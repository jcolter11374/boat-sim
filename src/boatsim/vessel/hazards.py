"""Hazard odds per hour: knockdowns from breaking waves, the damage they do, and ship strikes.

The plan doc models these as odds per hour from sea state and traffic, not as
3D wave physics. Each hazard has a physical shape (how it grows with wave
height or ship traffic) and a size that is a GUESS, scaled so that a typical
summer crossing reproduces the design doc's FMEA residuals. Ravi varies the
knobs in Monte Carlo; real numbers come from the pool test, the Bay trial and
the literature as we find it.

Knockdowns
    A small boat is rolled over when a breaking wave about a third of its
    length high hits it beam-on (Wolfson Unit / Fastnet 1979 capsize studies:
    breaking waves of ~35 % of hull length capsize yachts beam-on). The rate is

        waves per hour x fraction that break x fraction tall enough x scale

    * waves per hour = 3600 / Tp
    * fraction that break: Banner, Babanin & Young (2000), breaking probability
      of dominant waves P = 22 (eps - 0.055)^2.01 with eps = Hs kp / 2
    * fraction taller than the critical height: Rayleigh, exp(-2 (Hc/Hs)^2)
    * scale (GUESS): most breakers are spilling whitecaps, not plunging crests,
      and the boat isn't always beam-on. Set so a summer crossing sees a few
      knockdowns a day in normal seas and dozens in a gale.

    The dome makes the boat self-righting (positive righting arm to 180 deg),
    so a knockdown is not a loss by itself. Each one has a small chance of
    breaking something, which grows with wave height.

Ship strikes
    Random-encounter ("gas") model: a ship hits the kayak if it passes within
    half its own beam. Expected hits per hour =
        ship density x ship speed x (ship beam + kayak beam) x 3600 x (1 - p_avoid)
    p_avoid is the chance the ship's crew or the kayak sees the other in time.
    It depends on the AIS transponder working (the design doc says losing AIS
    roughly doubles collision risk). Ship density comes from oceandata as
    ships per km^2 at any instant.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np

from boatsim.types import EnvState, Event, EventKind
from boatsim.vessel.hull import G

# Parts a knockdown can break, with their share of per-knockdown damage odds.
# Panel names match the deck layout in the design doc (2 x 100 W + 1 x 50 W).
DEFAULT_PANELS_W = {"panel_100w_a": 100.0, "panel_100w_b": 100.0, "panel_50w": 50.0}


@dataclass(frozen=True)
class HazardParams:
    enabled: bool = True
    hull_length_m: float = 3.05  # design doc
    hull_beam_m: float = 0.79  # design doc
    critical_wave_frac_of_length: float = 0.35  # Wolfson / Fastnet capsize studies
    knockdown_scale: float = 0.02  # GUESS, see module docstring and calibration test
    # Per-knockdown odds, at the reference wave height; scale with (Hs/ref)^2.
    damage_ref_hs_m: float = 3.0
    p_inverted_stuck: float = 1.5e-4  # GUESS: dome damaged or keel lost; FMEA 0.7 %/voyage
    p_part: dict[str, float] = field(
        default_factory=lambda: {
            "panel_100w_a": 1.5e-4,  # GUESS: delamination or torn off, ~0.7 %/voyage
            "panel_100w_b": 1.5e-4,  # GUESS
            "panel_50w": 1.5e-4,  # GUESS
            "ais_whip": 1.0e-4,  # GUESS: the only external antenna, ~0.5 %/voyage
            "rudder": 5.0e-5,  # GUESS: spade rudder stock bent
        }
    )
    max_damage_p: float = 0.05  # cap on any per-knockdown odds in extreme seas
    # Ship strikes
    ship_speed_ms: float = 7.0  # GUESS: ~14 kt, typical merchant ship
    ship_beam_m: float = 32.0  # GUESS: Panamax-ish beam
    p_avoid_with_ais: float = 0.975  # GUESS: tuned to design doc FMEA (~1 % per voyage)
    p_avoid_without_ais: float = 0.95  # design doc: losing AIS ~doubles collision risk
    p_lost_given_strike: float = 0.8  # GUESS: foam-filled hull may survive a glancing hit

    @classmethod
    def from_config(cls, hazards: dict) -> HazardParams:
        kw = {k: v for k, v in hazards.items() if k in cls.__dataclass_fields__}
        if "p_part" in kw:
            kw["p_part"] = {**cls().p_part, **kw["p_part"]}
        return cls(**kw)


def breaking_probability(hs: float, tp: float) -> float:
    """Banner et al. (2000): chance a dominant wave breaks, from its steepness."""
    if hs <= 0.0 or tp <= 0.0:
        return 0.0
    kp = (2.0 * math.pi / tp) ** 2 / G  # deep-water wavenumber at the peak
    eps = hs * kp / 2.0
    if eps <= 0.055:
        return 0.0
    return min(22.0 * (eps - 0.055) ** 2.01, 1.0)


def knockdown_rate_per_hour(p: HazardParams, hs: float, tp: float) -> float:
    if not p.enabled or hs <= 0.0 or tp <= 0.0:
        return 0.0
    hc = p.critical_wave_frac_of_length * p.hull_length_m
    tall = math.exp(-2.0 * (hc / hs) ** 2)
    return (3600.0 / tp) * breaking_probability(hs, tp) * tall * p.knockdown_scale


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

    n = int(rng.poisson(knockdown_rate_per_hour(p, env.hs, env.tp) * hours))
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

    ais_ok = not (damage.get("ais_whip") or "ais_whip" in failed)
    lam = ship_strike_rate_per_hour(p, env.ship_density, ais_ok)
    if not lost and lam > 0.0 and rng.random() < 1.0 - math.exp(-lam * hours):
        survived = rng.random() >= p.p_lost_given_strike
        events.append(
            Event(t, EventKind.SHIP_STRIKE, "survived, damaged" if survived else "sunk or wrecked")
        )
        if survived:
            for part in ("panel_100w_a", "rudder"):
                if not damage.get(part) and part not in failed:
                    failed.append(part)
        else:
            lost = True

    return HazardOutcome(events, failed, lost, n)
