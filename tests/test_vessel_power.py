import math

import pytest

from boatsim.vessel.power import (
    BatteryParams,
    SolarParams,
    charge_acceptance,
    energy_step,
    heel_factor,
    solar_power_w,
    temp_factor,
)

S = SolarParams()
B = BatteryParams()


def _daily_yield_wh(kwh_m2: float, air_c: float, hs: float = 1.5) -> float:
    peak = kwh_m2 * 1000.0 * math.pi / 24.0
    total = 0.0
    for minute in range(24 * 60):
        h = minute / 60.0
        g = peak * math.sin(math.pi * (h - 6.0) / 12.0) if 6.0 < h < 18.0 else 0.0
        total += solar_power_w(S, g, hs, air_c) / 60.0
    return total


@pytest.mark.parametrize(
    "kwh_m2, air_c, design_doc_wh",
    [
        (6.0, 22.0, 900),  # drop point to Gulf Stream, May
        (5.2, 19.0, 780),  # Gulf Stream, May-June
        (4.8, 16.0, 720),  # mid-Atlantic, June
        (4.6, 15.0, 690),  # approaches, June-July
        (1.5, 15.0, 225),  # fully overcast day
    ],
)
def test_daily_solar_matches_design_doc_within_15_percent(kwh_m2, air_c, design_doc_wh):
    assert _daily_yield_wh(kwh_m2, air_c) == pytest.approx(design_doc_wh, rel=0.15)


def test_solar_covers_electronics_even_when_overcast():
    assert _daily_yield_wh(1.5, 15.0) > 85.0


def test_derates_behave():
    assert heel_factor(S, 4.0) < heel_factor(S, 0.0) < 1.0
    assert temp_factor(S, 30.0, 1000.0) < temp_factor(S, 10.0, 1000.0)
    assert solar_power_w(S, 0.0, 1.0, 15.0) == 0.0
    # Rated output at STC (1000 W/m^2, 25 C cell), before fixed losses
    stc_air = 25.0 - (S.noct_c - 20.0) * 1000.0 / 800.0
    flat = solar_power_w(S, 1000.0, 0.0, stc_air) / heel_factor(S, 0.0)
    assert flat == pytest.approx(S.rated_wp * S.fixed_derate)


def test_charge_taper_and_cold_cutoff():
    assert charge_acceptance(B, 0.5, 20.0) == 1.0
    assert 0.0 < charge_acceptance(B, 0.97, 20.0) < 1.0
    assert charge_acceptance(B, 1.0, 20.0) == 0.0
    assert charge_acceptance(B, 0.5, -1.0) == 0.0


def test_energy_step_conserves_with_losses():
    s = energy_step(B, 640.0, solar_w=100.0, drive_w=0.0, hotel_w=0.0, hours=1.0, temp_c=20.0)
    assert s.battery_wh == pytest.approx(640.0 + 100.0 * B.charge_eff)
    s = energy_step(B, 640.0, solar_w=0.0, drive_w=30.0, hotel_w=3.5, hours=1.0, temp_c=20.0)
    assert s.battery_wh == pytest.approx(640.0 - 33.5 / B.discharge_eff)


def test_flat_battery_cuts_drive_before_electronics():
    s = energy_step(B, 1.0, solar_w=0.0, drive_w=50.0, hotel_w=3.5, hours=1.0, temp_c=20.0)
    assert s.battery_wh == 0.0
    assert s.hotel_w == pytest.approx(min(3.5, 1.0 * B.discharge_eff))
    assert s.drive_w < 1.0


def test_battery_never_overfills():
    s = energy_step(B, 1279.0, solar_w=200.0, drive_w=0.0, hotel_w=0.0, hours=1.0, temp_c=20.0)
    assert s.battery_wh <= B.capacity_wh
