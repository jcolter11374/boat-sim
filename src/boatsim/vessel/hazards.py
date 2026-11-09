"""Hazard odds per hour: knockdowns from breaking waves, the damage they do, and ship strikes.

The plan doc models these as odds per hour from sea state and traffic, not as
3D wave physics. Each hazard has a physical shape (how it grows with wave
height or ship traffic) and a size that is a GUESS, scaled so that a typical
summer crossing reproduces the design doc's FMEA residuals. Ravi varies the
knobs in Monte Carlo; real numbers come from the pool test, the Bay trial and
the literature as we find it.

Knockdowns
    Adapted from the Randolph team's drone-boat simulator (failures.py,
    breaking_knockdown_rate; MIT, see THIRD_PARTY_NOTICES.md):

        knockdowns per hour = breaking events at a point per hour
                              x share of breakers tall enough x share hitting beam-on

    * breaking events: whitecap coverage W = 3.84e-6 U10^3.41 (Monahan and
      O'Muircheartaigh 1980) is the fraction of time a point on the sea sits in
      a breaker. Each breaker lasts about half a wave period, so events per
      hour = W x 3600 / (0.5 Tp).
    * tall enough: a breaking crest about 55 % of hull length high capsizes a
      small boat beam-on (Wolfson Unit / 1979 Fastnet capsize work); 1.2 x beam
      is a floor for very short hulls. Breaker heights are Rayleigh with scale
      0.25 Hs (Randolph: GUESS), so the share is exp(-2 (Hc / 0.25 Hs)^2).
    * beam-on share 0.25 (Randolph: GUESS).

    For our 3.05 m hull, in a fully developed sea, this gives essentially no
    knockdowns below Hs 3 m, about 0.5 a day at Hs 4 m (27 kt of wind), 4 a
    day at Hs 5 m and 16 a day at Hs 6 m. An
    earlier version (#34) used Banner et al. (2000) breaking odds with the
    full wave height against 35 % of length. That made 1 to 1.5 m steep wind
    seas roll the boat several times a day, and Ravi's real-weather batch saw
    34 to 352 knockdowns per voyage (#52).

    The dome makes the boat self-righting (positive righting arm to 180 deg),
    so a knockdown is not a loss by itself. Each one has a chance of breaking
    something, which grows with wave height.

Ship strikes
    Random-encounter ("gas") model: a ship hits the kayak if it passes within
    half its own beam. Expected hits per hour =
        ship density x ship speed x (ship beam + kayak beam) x 3600 x (1 - p_avoid)
    p_avoid is the chance the ship's crew or the kayak sees the other in time.
    It depends on the AIS transponder working (the design doc says losing AIS
    roughly doubles collision risk). Ship density comes from oceandata as
    ships per km^2 at any instant.

Wear, water and people (sample_failures)
    Leaks, steering failure, entanglement in fishing line or weed, being picked
    up near land, electronics failure (much likelier once water is inside), a
    software hang the watchdog can't clear, and early-life defects. No
    datasheet gives these rates for a boat like ours, so the per-day rates are
    GUESSES. The starting point is the Randolph team's drone-boat simulator
    (https://github.com/sheltonr2/drone-boat, simulator/drone_sim/failures.py,
    MIT licence, see THIRD_PARTY_NOTICES.md). Their rates are themselves
    engineering guesses informed by small autonomous sailboat history. Changes
    for this design are noted line by line. Real-world anchors for the totals:

    * Microtransat Challenge: more than 30 autonomous-boat attempts since 2010,
      and only one documented finish, the 2 m Sailbuoy "SB Met" (79 days, 2018;
      Wikipedia "The Microtransat Challenge"). Recorded failure types include
      "picked up by fishing vessel" and "position report failure" (Peruagus
      team paper, CEUR-WS Vol-2331 paper 2, Table 1).
    * Scout (2013): a 3.9 m solar-electric drone, the closest precedent to ours.
      It lost communications about a month out from Rhode Island, after
      roughly 1,300 to 2,000 miles. The team's best guess was "some sort of
      electrical or software failure ... with the Arduino processors" (Make:;
      Sail-World, 16 Oct 2013).
    * Design doc FMEA (v4): entanglement 2.0 %, early-life defect or unknown 3.0 %,
      taken aboard 1.0 %, water in electronics 0.5 %, steering 0.4 % residual.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np

from boatsim.types import EnvState, Event, EventKind
from boatsim.vessel.coast import distance_to_land_km

# Parts a knockdown can break, with their share of per-knockdown damage odds.
# Panel names match the deck layout in the design doc (2 x 100 W + 1 x 50 W).
DEFAULT_PANELS_W = {"panel_100w_a": 100.0, "panel_100w_b": 100.0, "panel_50w": 50.0}


@dataclass(frozen=True)
class HazardParams:
    enabled: bool = True
    hull_length_m: float = 3.05  # design doc
    hull_beam_m: float = 0.79  # design doc
    critical_wave_frac_of_length: float = 0.55  # Wolfson / Fastnet: breaker 55 % of length
    critical_wave_frac_of_beam: float = 1.2  # Randolph: floor for short hulls
    breaker_height_frac_of_hs: float = 0.25  # Randolph GUESS: Rayleigh scale of breakers
    beam_on_share: float = 0.25  # Randolph GUESS
    knockdown_scale: float = 1.0  # multiplier for Monte Carlo spread (Randolph: wave_capsize)
    # Per-knockdown odds, at the reference wave height; scale with (Hs/ref)^2.
    damage_ref_hs_m: float = 3.0
    p_inverted_stuck: float = 4.0e-5  # GUESS: dome damaged or keel lost; FMEA 0.7 %/voyage
    p_part: dict[str, float] = field(
        default_factory=lambda: {
            "panel_100w_a": 4.0e-5,  # GUESS: delamination or torn off, ~0.7 %/voyage
            "panel_100w_b": 4.0e-5,  # GUESS
            "panel_50w": 4.0e-5,  # GUESS
            "ais_whip": 2.5e-5,  # GUESS: the only external antenna, ~0.5 %/voyage
            "rudder": 1.5e-5,  # GUESS: spade rudder stock bent
        }
    )
    max_damage_p: float = 0.05  # cap on any per-knockdown odds in extreme seas
    # Ship strikes
    ship_speed_ms: float = 7.0  # GUESS: ~14 kt, typical merchant ship
    ship_beam_m: float = 32.0  # GUESS: Panamax-ish beam
    p_avoid_with_ais: float = 0.975  # GUESS: tuned to design doc FMEA (~1 % per voyage)
    p_avoid_without_ais: float = 0.95  # design doc: losing AIS ~doubles collision risk
    p_lost_given_strike: float = 0.8  # GUESS: foam-filled hull may survive a glancing hit
    p_leak_given_strike: float = 1.0  # Randolph: a survived collision leaves the hull leaking

    # --- Wear, water and people. Rates per day; "Randolph" = drone-boat defaults. ---
    failures_enabled: bool = True
    # Leak into one of the two equipment tubs, x (1 + (Hs/3)^2). Randolph: 0.0025.
    # The hull is foam-filled, so a leak can't sink it (design doc). Water wets the
    # electronics box in that tub.
    leak_per_day: float = 0.0025
    # Electronics: two independent IP68 boxes (design doc). "main" holds the Pixhawk,
    # Iridium and AIS; "safe" holds the STM32 safe-mode controller. Randolph: 0.0012/day,
    # x6 once water is inside. Losing main leaves safe mode steering 070 deg on
    # Globalstar position reports. Losing both leaves the boat silent and uncontrolled.
    electronics_per_day: float = 0.0012
    electronics_wet_multiplier: float = 6.0
    # Software hang, Randolph: 0.02/day, watchdog clears 95 %. A hang that isn't
    # cleared takes out the main box (Scout's suspected failure, 2013).
    software_hang_per_day: float = 0.02
    watchdog_recovers: float = 0.95
    # Steering: rudder servo fails, x (1 + Hs/4). Randolph: 0.002/day, 60 % jammed.
    # Ours has a centring spring, so "limp" centres the rudder. A jammed rudder
    # also costs extra drag.
    steering_per_day: float = 0.002
    steering_jam_share: float = 0.6
    rudder_jam_drag_mult: float = 1.25  # GUESS
    # Entanglement in fishing line or weed. Randolph: 0.003/day, x3 within 100 km of
    # land, x2 in the Sargasso; adds 3x clean drag until it clears (0.15/day).
    # Ours: x2 in the Gulf Stream longline grounds (design doc FMEA row 1). Clears
    # faster (GUESS 0.5/day) because reverse-thrust cycles shed lines. Can wrap a
    # thruster (GUESS 10 %).
    entangle_per_day: float = 0.003
    entangle_near_land_km: float = 100.0
    entangle_near_land_mult: float = 3.0
    entangle_sargasso_mult: float = 2.0
    entangle_gulf_stream_mult: float = 2.0
    entangle_extra_drag: float = 3.0
    entangle_clear_per_day: float = 0.5
    p_thruster_wrap: float = 0.1
    # Thruster wear-out (bearings, seized prop), per thruster. GUESS from the design
    # doc: a single thruster is a 4 % single point of failure over the crossing
    # (option A), i.e. ~0.0007/day; with two, both failing is ~0.2 % (FMEA row 8: 0.5 %).
    thruster_per_day: float = 0.0007
    # Capture: picked up by a fishing boat or a passer-by. Randolph: 0.002/day, only
    # within 50 km of land.
    capture_per_day: float = 0.002
    capture_near_land_km: float = 50.0
    # Early-life defects and unknowns (design doc FMEA row 2: 3 % residual), as a
    # Weibull with shape < 1, so most of the risk is in the first weeks.
    unknown_shape: float = 0.5
    unknown_p_by_60_days: float = 0.03

    @classmethod
    def from_config(cls, hazards: dict) -> HazardParams:
        kw = {k: v for k, v in hazards.items() if k in cls.__dataclass_fields__}
        if "p_part" in kw:
            kw["p_part"] = {**cls().p_part, **kw["p_part"]}
        return cls(**kw)


def whitecap_fraction(wind_speed: float) -> float:
    """Monahan and O'Muircheartaigh (1980): W = 3.84e-6 U10^3.41, capped at 0.3."""
    return min(3.84e-6 * max(wind_speed, 0.0) ** 3.41, 0.3)


def knockdown_rate_per_hour(p: HazardParams, hs: float, tp: float, wind_speed: float) -> float:
    if not p.enabled or hs <= 0.05 or tp <= 0.0:
        return 0.0
    events_per_hour = whitecap_fraction(wind_speed) * 3600.0 / (0.5 * max(tp, 1.0))
    hc = max(
        p.critical_wave_frac_of_length * p.hull_length_m,
        p.critical_wave_frac_of_beam * p.hull_beam_m,
    )
    tall = math.exp(-2.0 * (hc / (p.breaker_height_frac_of_hs * hs)) ** 2)
    return events_per_hour * tall * p.beam_on_share * p.knockdown_scale


def damage_scale(p: HazardParams, hs: float) -> float:
    return (hs / p.damage_ref_hs_m) ** 2


def ship_strike_rate_per_hour(p: HazardParams, ships_per_km2: float, ais_ok: bool) -> float:
    if not p.enabled or ships_per_km2 <= 0.0:
        return 0.0
    density_m2 = ships_per_km2 / 1.0e6
    sweep_m2_per_h = p.ship_speed_ms * (p.ship_beam_m + p.hull_beam_m) * 3600.0
    p_avoid = p.p_avoid_with_ais if ais_ok else p.p_avoid_without_ais
    return density_m2 * sweep_m2_per_h * (1.0 - p_avoid)


@dataclass
class HazardOutcome:
    events: list[Event]
    failed_parts: list[str]
    lost: bool
    knockdowns: int
    cleared_parts: list[str] = field(default_factory=list)


def sample_hazards(
    p: HazardParams,
    env: EnvState,
    hours: float,
    damage: dict[str, bool],
    t: datetime,
    rng: np.random.Generator,
) -> HazardOutcome:
    """Draw what happens to the boat in one step of `hours`."""
    events: list[Event] = []
    failed: list[str] = []
    lost = False
    if not p.enabled:
        return HazardOutcome(events, failed, lost, 0)

    wind = math.hypot(env.wind_u, env.wind_v)
    n = int(rng.poisson(knockdown_rate_per_hour(p, env.hs, env.tp, wind) * hours))
    if n:
        scale = damage_scale(p, env.hs)
        events.append(Event(t, EventKind.CAPSIZE, f"{n} knockdown(s), Hs {env.hs:.1f} m"))
        for _ in range(n):
            if rng.random() < min(p.p_inverted_stuck * scale, p.max_damage_p):
                events.append(Event(t, EventKind.LOST, "stuck inverted or keel lost"))
                lost = True
                break
            for part, base in p.p_part.items():
                if damage.get(part) or part in failed:
                    continue
                if rng.random() < min(base * scale, p.max_damage_p):
                    failed.append(part)
                    events.append(Event(t, EventKind.PART_FAILED, f"{part} (knockdown)"))

    # AIS needs its antenna and the main electronics box it lives in.
    ais_ok = not any(damage.get(k) or k in failed for k in ("ais_whip", "electronics_main"))
    lam = ship_strike_rate_per_hour(p, env.ship_density, ais_ok)
    if not lost and lam > 0.0 and rng.random() < 1.0 - math.exp(-lam * hours):
        survived = rng.random() >= p.p_lost_given_strike
        events.append(
            Event(t, EventKind.SHIP_STRIKE, "survived, damaged" if survived else "sunk or wrecked")
        )
        if survived:
            hit = ("panel_100w_a", "rudder", "leak_main_tub")
            for part in hit if rng.random() < p.p_leak_given_strike else hit[:2]:
                if not damage.get(part) and part not in failed:
                    failed.append(part)
        else:
            lost = True

    return HazardOutcome(events, failed, lost, n)


ELECTRONICS = ("electronics_main", "electronics_safe")
TUB_FOR_BOX = {"electronics_main": "leak_main_tub", "electronics_safe": "leak_safe_tub"}

_SARGASSO = (20.0, 35.0, -70.0, -40.0)  # Randolph's box
_GULF_STREAM = (34.0, 42.0, -75.0, -50.0)  # GUESS: longline grounds on the route


def _in_box(lat: float, lon: float, box: tuple[float, float, float, float]) -> bool:
    return box[0] <= lat <= box[1] and box[2] <= lon <= box[3]


def _p(rate_per_day: float, hours: float) -> float:
    return 1.0 - math.exp(-max(rate_per_day, 0.0) * hours / 24.0)


def unknown_hazard_per_day(p: HazardParams, days: float) -> float:
    """Weibull hazard h(t) = (k/eta)(t/eta)^(k-1), sized so P(fail by day 60) is
    unknown_p_by_60_days."""
    if p.unknown_p_by_60_days <= 0.0:
        return 0.0
    k = p.unknown_shape
    eta = 60.0 / (-math.log(1.0 - p.unknown_p_by_60_days)) ** (1.0 / k)
    t = max(days, 1e-3)
    return (k / eta) * (t / eta) ** (k - 1.0)


def entangle_rate_per_day(p: HazardParams, lat: float, lon: float, land_km: float) -> float:
    m = p.entangle_near_land_mult if land_km < p.entangle_near_land_km else 1.0
    if _in_box(lat, lon, _SARGASSO):
        m *= p.entangle_sargasso_mult
    if _in_box(lat, lon, _GULF_STREAM):
        m *= p.entangle_gulf_stream_mult
    return p.entangle_per_day * m


def sample_failures(
    p: HazardParams,
    env: EnvState,
    hours: float,
    damage: dict[str, bool],
    t: datetime,
    lat: float,
    lon: float,
    days_at_sea: float,
    rng: np.random.Generator,
    thrusters: tuple[str, ...] = ("thruster_port", "thruster_starboard"),
) -> HazardOutcome:
    """Draw the non-wave failures for one step: leaks, electronics, software,
    steering, entanglement, thruster wear-out, capture and early-life defects.

    thrusters: damage names of the thrusters the boat has (KayakVessel passes
    them from propulsion.thruster_count), so a one-thruster boat only rolls one die."""
    out = HazardOutcome([], [], False, 0)
    if not (p.enabled and p.failures_enabled):
        return out

    def broken(part: str) -> bool:
        return bool(damage.get(part)) or part in out.failed_parts

    def fail(part: str, why: str) -> None:
        out.failed_parts.append(part)
        out.events.append(Event(t, EventKind.PART_FAILED, f"{part} ({why})"))

    def lose(why: str) -> None:
        out.lost = True
        out.events.append(Event(t, EventKind.LOST, why))

    hs = max(env.hs, 0.0)
    land_km = distance_to_land_km(lat, lon)

    # Leak into one of the two tubs
    if rng.random() < _p(p.leak_per_day * (1.0 + (hs / 3.0) ** 2), hours):
        tub = "leak_main_tub" if rng.random() < 0.5 else "leak_safe_tub"
        if not broken(tub):
            fail(tub, "water getting into the hull")

    # Electronics boxes, likelier once their tub is wet; software hang on main
    for box in ELECTRONICS:
        if broken(box):
            continue
        rate = p.electronics_per_day
        if broken(TUB_FOR_BOX[box]):
            rate *= p.electronics_wet_multiplier
        if box == "electronics_main":
            rate += p.software_hang_per_day * (1.0 - p.watchdog_recovers)
        if rng.random() < _p(rate, hours):
            fail(box, "electronics or software failure")
    if all(broken(b) for b in ELECTRONICS):
        lose("both electronics boxes dead: silent and uncontrolled")
        return out

    # Steering
    if not broken("rudder") and rng.random() < _p(p.steering_per_day * (1.0 + hs / 4.0), hours):
        if rng.random() < p.steering_jam_share:
            fail("rudder", "servo jammed")
            out.failed_parts.append("rudder_jammed")
        else:
            fail("rudder", "servo failed limp, spring centres it")

    # Entanglement: comes and goes
    if broken("entangled"):
        if rng.random() < _p(p.entangle_clear_per_day, hours):
            out.cleared_parts.append("entangled")  # no event: EventKind has no "recovered"
    elif rng.random() < _p(entangle_rate_per_day(p, lat, lon, land_km), hours):
        fail("entangled", "fishing line or weed")
        working = [th for th in thrusters if not broken(th)]
        if working and rng.random() < p.p_thruster_wrap:
            fail(working[int(rng.integers(len(working)))], "line wrapped round it")

    # Thruster wear-out: one die per thruster the boat actually has
    for th in thrusters:
        if not broken(th) and rng.random() < _p(p.thruster_per_day, hours):
            fail(th, "bearing or motor failure")

    # Picked up near land
    if land_km < p.capture_near_land_km and rng.random() < _p(p.capture_per_day, hours):
        lose("picked up by a fishing boat or passer-by")
        return out

    # Early-life defect or unknown
    if rng.random() < _p(unknown_hazard_per_day(p, days_at_sea), hours):
        lose("early-life defect or unknown failure")

    return out
