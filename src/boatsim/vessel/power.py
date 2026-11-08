"""Solar charging and the LiFePO4 battery for the v4 kayak.

Solar: rated watts x (sunlight / 1000 W/m^2) x derates. ERA5 gives sunlight
on a flat surface (GHI), which suits panels bonded flat to the deck. Derates:

* heel: the boat rolls in waves, tilting the panels. For a random roll angle
  with spread sigma the average of cos(roll) is exp(-sigma^2 / 2). Roll spread
  grows with wave height (GUESS, see roll_rms_deg).
* temperature: cells run hot in sun and lose ~0.37 %/C above 25 C. Cell
  temperature from the standard NOCT model.
* soiling and salt, curvature and shading on the dome, MPPT, wiring: fixed
  factors (GUESS for this deck; typical published ranges).

The design doc uses one flat 0.6 for all of this plus battery losses. The
defaults below come out at about 0.62 on a typical day before battery losses,
so daily yields land within ~10 % of the design doc's 690 to 900 Wh/day
(tests/test_vessel_power.py checks this).

Battery: two 12.8 V 50 Ah LiFePO4 banks treated as one 1,280 Wh pool (the
design diode-ORs them onto one bus). Energy bookkeeping with charge and
discharge efficiencies, charge taper near full, and the BMS refusing to charge
below 0 C (design doc: low-temperature charge cutoff).
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class SolarParams:
    rated_wp: float = 250.0  # design doc
    soiling_salt: float = 0.93  # GUESS: salt film between rain showers
    mounting_mismatch: float = 0.80  # GUESS: curved dome, side-deck shading, mixed panels
    mppt_eff: float = 0.96  # Victron SmartSolar 75/15 datasheet peak 98 %, less at part load
    wiring_eff: float = 0.98  # GUESS
    temp_coeff_per_c: float = -0.0037  # GUESS: typical monocrystalline, panel not chosen
    noct_c: float = 55.0  # GUESS: typical NOCT is ~45 C; flush on foam, no cooling behind
    roll_rms_deg_calm: float = 5.0  # GUESS
    roll_rms_deg_per_m_hs: float = 6.0  # GUESS
    roll_rms_deg_max: float = 30.0  # GUESS

    @classmethod
    def from_config(cls, power: dict) -> SolarParams:
        kw = {k: v for k, v in power.items() if k in cls.__dataclass_fields__}
        if "solar_wp" in power:
            kw["rated_wp"] = float(power["solar_wp"])
        return cls(**kw)

    @property
    def fixed_derate(self) -> float:
        return self.soiling_salt * self.mounting_mismatch * self.mppt_eff * self.wiring_eff


def roll_rms_deg(p: SolarParams, hs: float) -> float:
    return min(p.roll_rms_deg_calm + p.roll_rms_deg_per_m_hs * max(hs, 0.0), p.roll_rms_deg_max)


def heel_factor(p: SolarParams, hs: float) -> float:
    """Average cos(roll) for normally distributed roll: exp(-sigma^2/2)."""
    sigma = math.radians(roll_rms_deg(p, hs))
    return math.exp(-0.5 * sigma * sigma)


def cell_temp_c(p: SolarParams, air_temp_c: float, ghi: float) -> float:
    """NOCT model: T_cell = T_air + (NOCT - 20) x G / 800."""
    return air_temp_c + (p.noct_c - 20.0) * max(ghi, 0.0) / 800.0


def temp_factor(p: SolarParams, air_temp_c: float, ghi: float) -> float:
    return max(0.0, 1.0 + p.temp_coeff_per_c * (cell_temp_c(p, air_temp_c, ghi) - 25.0))


def solar_power_w(p: SolarParams, ghi: float, hs: float, air_temp_c: float) -> float:
    """Power delivered by the MPPTs to the battery bus, in W."""
    if ghi <= 0.0:
        return 0.0
    return (
        p.rated_wp
        * (ghi / 1000.0)
        * heel_factor(p, hs)
        * temp_factor(p, air_temp_c, ghi)
        * p.fixed_derate
    )


@dataclass(frozen=True)
class BatteryParams:
    capacity_wh: float = 1280.0  # 2 x 12.8 V x 50 Ah, datasheet nameplate
    charge_eff: float = 0.975  # GUESS: LiFePO4 round trip ~95 %, split evenly
    discharge_eff: float = 0.975  # GUESS
    taper_start_soc: float = 0.95  # GUESS: charger absorption phase cuts current near full
    min_charge_temp_c: float = 0.0  # LiFePO4 BMS low-temperature charge cutoff (design doc)
    restart_soc: float = 0.02  # GUESS: BMS reconnects the load once a little charge is back

    @classmethod
    def from_config(cls, power: dict) -> BatteryParams:
        kw = {k: v for k, v in power.items() if k in cls.__dataclass_fields__}
        if "battery_wh" in power:
            kw["capacity_wh"] = float(power["battery_wh"])
        return cls(**kw)


def charge_acceptance(p: BatteryParams, soc: float, temp_c: float) -> float:
    """Fraction of offered charging power the battery takes (0..1)."""
    if temp_c < p.min_charge_temp_c or soc >= 1.0:
        return 0.0
    if soc <= p.taper_start_soc:
        return 1.0
    return (1.0 - soc) / (1.0 - p.taper_start_soc)


@dataclass(frozen=True)
class EnergyStep:
    battery_wh: float  # stored energy at the end of the step
    drive_w: float  # drive power actually delivered (may be cut if the battery runs flat)
    hotel_w: float  # electronics power actually delivered
    solar_w: float  # solar power offered by the MPPTs
    charge_w: float  # power that went into storage (before charge losses)


def energy_step(
    p: BatteryParams,
    battery_wh: float,
    solar_w: float,
    drive_w: float,
    hotel_w: float,
    hours: float,
    temp_c: float,
) -> EnergyStep:
    """Advance the battery by `hours`. Solar feeds the loads first, the surplus
    charges the battery; any shortfall comes out of the battery. If the battery
    cannot cover the whole step, drive power is cut first, then electronics."""
    soc = battery_wh / p.capacity_wh if p.capacity_wh > 0 else 0.0
    net = solar_w - drive_w - hotel_w
    if net >= 0.0:
        accepted = net * charge_acceptance(p, soc, temp_c)
        e = battery_wh + accepted * p.charge_eff * hours
        return EnergyStep(min(e, p.capacity_wh), drive_w, hotel_w, solar_w, accepted)

    need_wh = -net / p.discharge_eff * hours
    if need_wh <= battery_wh:
        return EnergyStep(battery_wh - need_wh, drive_w, hotel_w, solar_w, 0.0)

    # Not enough stored energy for the whole step: cut drive, then hotel.
    avail_w = battery_wh * p.discharge_eff / hours + solar_w  # what can be supplied on average
    hotel = min(hotel_w, avail_w)
    drive = min(drive_w, max(0.0, avail_w - hotel))
    return EnergyStep(0.0, drive, hotel, solar_w, 0.0)
