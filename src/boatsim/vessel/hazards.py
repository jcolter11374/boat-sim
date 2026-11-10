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
    Leaks, steering failure, entanglement in fishing line or weed, being taken
    by fishermen near land, electronics failure (much likelier once water is
    inside), a software hang the watchdog can't clear, Iridium going silent
    while the boat sails on, and the Globalstar beacon failing. Hardware rates
    are multiplied by an early-life (infant-mortality) factor.

    The rates come from the shared hazard table the Randolph team compiled for
    both projects (issue #89): https://github.com/sheltonr2/drone-boat,
    docs/Failure_Rates.md section 2, at commit 25befa9 (MIT licence, see
    THIRD_PARTY_NOTICES.md). It fits per-day rates to 37 Microtransat attempts
    (837 boat-days) with gliders, drifters and Argo floats as reference
    fleets, and splits every voyage into "near land" (within ~150 km of a
    coast) and "open ocean": mission-ending events ran at 0.116 per day near
    land against 0.013 per day offshore. Three rate sets (RATE_SETS):
    "historical" is the fit to the record, "planning" (the default) credits
    mitigations that tests must still earn, "original" is what boat-sim used
    before (#52, #65). Changes for this design are noted line by line. Every
    LOST event's detail ends with its phase, e.g. "... [near land]".
    Real-world anchors for the totals:

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
from boatsim.vessel.wearout import wearout_multiplier

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

    # --- Wear, water and people. Rates per day. ---
    # Defaults are the "planning" rate set; RATE_SETS below holds all three. The
    # rates come from the Randolph team's shared hazard table (drone-boat
    # docs/Failure_Rates.md, section 2, MIT; "R2" below means a row of that table),
    # mapped onto the kayak where its design differs. All GUESS.
    rate_set: str = "planning"
    failures_enabled: bool = True
    # Near land vs open ocean: the shared table splits every voyage at ~150 km
    # from any coast (shelf, channels, fishing grounds). Used for capture and to
    # tag each loss with its phase.
    near_land_km: float = 150.0
    # R2 leak: 0.0025, x (1 + (Hs/3)^2), x early life. Into one of the two
    # equipment tubs. The hull is foam-filled, so a leak can't sink it (design
    # doc); the water wets the electronics box in that tub.
    leak_per_day: float = 0.0025
    # R2 electronics: planning 0.0025, historical 0.0035, x6 once wet, x early
    # life. Their boats have one box, so a failure is a loss. Ours has two
    # independent IP68 boxes (design doc): "main" holds the Pixhawk, Iridium and
    # AIS; "safe" the STM32 safe-mode controller. Each box gets the R2 rate.
    # Losing main leaves safe mode steering 070 deg on Globalstar pings. Losing
    # both leaves the boat silent and uncontrolled: lost.
    electronics_per_day: float = 0.0025
    electronics_wet_multiplier: float = 6.0
    # Common-cause share (the reliability "beta factor"): this share of the
    # electronics rate kills both boxes at once (shared battery and wiring, one
    # hull, one firmware author). GUESS 0.3, well above the 0.01-0.1 IEC 61508-6
    # allows for well-separated channels, because ours share far more. 1.0 gives
    # the single-box boats of the record.
    electronics_common_cause: float = 0.3
    # Boxes fitted: 2 (ours, above), or 1 for a single-box boat such as the
    # Randolph Rev B: one box holds autopilot and radio, so any electronics or
    # unrecovered software failure leaves it silent and uncontrolled: a loss,
    # unless a working backup tracker keeps reporting (then it drifts, tracked). It rolls the common-cause die, so
    # paired runs against our kayak stay in step (hazards.SLOT).
    electronics_boxes: int = 2
    # R2 comms_silent (new): planning 0.0011, historical 0.0022, x (1 + Hs/4),
    # x early life. The Iridium modem, its antenna or the comms power path dies;
    # the boat sails on, unheard on Iridium. The Globalstar beacon is separate.
    comms_silent_per_day: float = 0.0011
    # Globalstar SmartOne Solar beacon dying on its own (own cell and battery).
    # Not in R2. GUESS: same as a thruster, a sealed commercial unit.
    beacon_per_day: float = 0.0007
    # R2 software hang: 0.02/day, watchdog clears 95 %. A hang that isn't
    # cleared takes out the main box (Scout's suspected failure, 2013).
    software_hang_per_day: float = 0.02
    watchdog_recovers: float = 0.95
    # R2 rudder servo: 0.002, x (1 + Hs/4), x early life; 60 % jammed. Ours has a
    # centring spring, so "limp" centres the rudder. A jammed rudder also costs
    # extra drag. (R2's tail-servo and wing rig-damage rows don't apply: no wing.
    # Our panels, dome and AIS whip break per knockdown, above.)
    steering_per_day: float = 0.002
    steering_jam_share: float = 0.6
    rudder_jam_drag_mult: float = 1.25  # GUESS
    # R2 entanglement: 0.003/day, x3 within 100 km of land, x2 in the Sargasso;
    # drag x4 until it clears. Ours: x2 in the Gulf Stream longline grounds
    # (design doc FMEA row 1). Clears faster (GUESS 0.5/day vs R2 ~0.15) because
    # reverse-thrust cycles shed lines. Can wrap a thruster (GUESS 10 %).
    entangle_per_day: float = 0.003
    entangle_near_land_km: float = 100.0
    entangle_near_land_mult: float = 3.0
    entangle_sargasso_mult: float = 2.0
    entangle_gulf_stream_mult: float = 2.0
    entangle_extra_drag: float = 3.0
    entangle_clear_per_day: float = 0.5
    p_thruster_wrap: float = 0.1
    # Thruster wear-out (bearings, seized prop), per thruster, x early life. GUESS
    # from the design doc: a single thruster is a 4 % single point of failure over
    # the crossing (option A), i.e. ~0.0007/day; with two, both failing is ~0.2 %
    # (FMEA row 8: 0.5 %).
    thruster_per_day: float = 0.0007
    # R2 capture: taken or snagged by fishermen. Planning 0.01, historical 0.02,
    # within ~150 km of land (Microtransat near land: 4 taken in 215 boat-days).
    capture_per_day: float = 0.01
    capture_near_land_km: float = 150.0
    # R2 early life (new): hardware hazards x (1 + k e^(-(day + shakedown)/tau)),
    # k = 3, tau = 7 days. Planning assumes a 14-day unattended shakedown (it
    # cuts the launch-day multiplier from 4.0 to 1.4); historical has none.
    early_life_k: float = 3.0
    early_life_tau_days: float = 7.0
    shakedown_days: float = 14.0
    # Early-life defects and unknowns as a Weibull with shape < 1 (design doc
    # FMEA row 2: 3 %). Only the "original" set uses it: the early-life
    # multiplier replaces it, and keeping both would count infant mortality
    # twice. Ravi's sweep (#52) can still turn it up.
    unknown_shape: float = 0.5
    unknown_p_by_60_days: float = 0.0
    # Wear-out (#118): hardware rates in open ocean x (t / t_ref)^(k - 1), t = days
    # spent in open ocean so far (vessel/wearout.py). k = 1 is off. The record can't
    # tell wear-out from a constant rate, so every set keeps it off until we choose;
    # wearout.WEAROUT_PARAMS holds the fitted range (central k 1.41, high 2.24).
    wearout_k: float = 1.0
    wearout_t_ref_days: float = 35.0

    @classmethod
    def from_config(cls, hazards: dict, rate_set: str | None = None) -> HazardParams:
        """Build from a design's `hazards:` block.

        The block's `rate_set` (default "planning") picks one of RATE_SETS; any
        other key in the block overrides that set, for sensitivity runs. Passing
        `rate_set` here switches the whole set with one flag: the set's own
        values then win over the block's, and the rest of the block (knockdowns,
        ship strikes, drag) still applies."""
        name = rate_set or hazards.get("rate_set", "planning")
        if name not in RATE_SETS:
            raise ValueError(f"unknown hazard rate_set {name!r}; pick one of {sorted(RATE_SETS)}")
        kw = {k: v for k, v in hazards.items() if k in cls.__dataclass_fields__}
        if rate_set is None:
            kw = {**RATE_SETS[name], **kw}
        else:
            kw = {**kw, **RATE_SETS[name]}
        kw["rate_set"] = name
        if "p_part" in kw:
            kw["p_part"] = {**cls().p_part, **kw["p_part"]}
        return cls(**kw)


# The three rate sets of the shared table (R2). Only the keys that differ between
# them are listed; everything else comes from HazardParams' defaults or the design.
_PLANNING = {
    "leak_per_day": 0.0025,
    "electronics_per_day": 0.0025,  # R2 planning (x0.7 IP68 credit)
    "comms_silent_per_day": 0.0011,  # R2 planning (x0.5 backup-power credit)
    "beacon_per_day": 0.0007,
    "capture_per_day": 0.01,  # R2 planning (x0.5 labels, notice, offshore drop)
    "capture_near_land_km": 150.0,
    "early_life_k": 3.0,
    "shakedown_days": 14.0,  # a 14-day unattended trial before the drop: planned (John, 9 Nov 2026)
    "unknown_p_by_60_days": 0.0,
}
RATE_SETS: dict[str, dict[str, float]] = {
    "planning": _PLANNING,
    # The fit to the Microtransat record (37 attempts, 837 boat-days).
    "historical": {
        **_PLANNING,
        "electronics_per_day": 0.0035,
        "comms_silent_per_day": 0.0022,
        "capture_per_day": 0.02,
        "shakedown_days": 0.0,
    },
    # What boat-sim used through PR #65, kept so old results can be reproduced.
    "original": {
        **_PLANNING,
        "electronics_per_day": 0.0012,
        "electronics_common_cause": 0.0,
        "comms_silent_per_day": 0.0,
        "beacon_per_day": 0.0,
        "capture_per_day": 0.002,
        "capture_near_land_km": 50.0,
        "early_life_k": 0.0,
        "unknown_p_by_60_days": 0.03,
    },
}


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


# --- Common random numbers -------------------------------------------------------
# Each step the kayak draws ONE fixed block of uniforms, rng.random(K_DICE), and
# every decision below reads its own slot, whether or not it applies this step
# (no ships here, far from land, part already broken...). So the hull's random
# stream advances by exactly K_DICE per step wherever the boat is, and two runs
# that differ only in their path (route, re-planning, cruise power) keep seeing
# the same dice step for step: paired comparisons stay paired.
# K_DICE is one slot per decision, with 8 reserved slots for knockdown parts and 8
# for thrusters, so K doesn't depend on the design. Add new slots at the end only.
MAX_KNOCKDOWN_PARTS = 8
MAX_THRUSTERS = 8
_names = [
    "knockdown_count",
    "knockdown_inverted",
    *(f"knockdown_part_{i}" for i in range(MAX_KNOCKDOWN_PARTS)),
    "strike",
    "strike_survived",
    "strike_leak",
    "leak",
    "leak_tub",
    "electronics_common",
    "electronics_main",
    "electronics_safe",
    "comms_silent",
    "beacon",
    "steering",
    "steering_jam",
    "entangle",
    "thruster_wrap",
    "thruster_wrap_which",
    *(f"thruster_{i}" for i in range(MAX_THRUSTERS)),
    "capture",
    "unknown",
]
SLOT = {name: i for i, name in enumerate(_names)}
K_DICE = len(_names)
del _names


def draw_dice(rng: np.random.Generator) -> np.ndarray:
    """The step's fixed block of uniforms (see SLOT)."""
    return rng.random(K_DICE)


def _dice(u: np.ndarray | np.random.Generator) -> np.ndarray:
    return draw_dice(u) if isinstance(u, np.random.Generator) else u


def poisson_from_uniform(lam: float, u: float, k_max: int = 10_000) -> int:
    """Poisson(lam) count by inverting its CDF at u: one uniform, any lam."""
    if lam <= 0.0:
        return 0
    k, pmf = 0, math.exp(-lam)
    if pmf == 0.0:  # huge lam (never on our boat): normal approximation
        from statistics import NormalDist

        return max(0, round(NormalDist(lam, math.sqrt(lam)).inv_cdf(min(max(u, 1e-12), 1 - 1e-12))))
    cdf = pmf
    while u > cdf and k < k_max:
        k += 1
        pmf *= lam / k
        cdf += pmf
        if pmf < 1e-300:
            break
    return k


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
    rng: np.ndarray | np.random.Generator,
) -> HazardOutcome:
    """Draw what happens to the boat in one step of `hours`.

    rng: the step's dice block (draw_dice), or a Generator to draw one from."""
    u = _dice(rng)
    events: list[Event] = []
    failed: list[str] = []
    lost = False
    if not p.enabled:
        return HazardOutcome(events, failed, lost, 0)
    if len(p.p_part) > MAX_KNOCKDOWN_PARTS:
        raise ValueError(f"at most {MAX_KNOCKDOWN_PARTS} knockdown parts have dice slots")

    wind = math.hypot(env.wind_u, env.wind_v)
    lam = knockdown_rate_per_hour(p, env.hs, env.tp, wind) * hours
    n = poisson_from_uniform(lam, u[SLOT["knockdown_count"]])
    if n:
        # n knockdowns in the step: each part (and the boat) gets n independent
        # chances, i.e. 1 - (1 - q)^n, from one uniform each.
        scale = damage_scale(p, env.hs)
        events.append(Event(t, EventKind.CAPSIZE, f"{n} knockdown(s), Hs {env.hs:.1f} m"))
        q_inv = min(p.p_inverted_stuck * scale, p.max_damage_p)
        if u[SLOT["knockdown_inverted"]] < 1.0 - (1.0 - q_inv) ** n:
            events.append(Event(t, EventKind.LOST, "stuck inverted or keel lost"))
            lost = True
        else:
            for i, (part, base) in enumerate(p.p_part.items()):
                q = min(base * scale, p.max_damage_p)
                if not damage.get(part) and u[SLOT[f"knockdown_part_{i}"]] < 1.0 - (1.0 - q) ** n:
                    failed.append(part)
                    events.append(Event(t, EventKind.PART_FAILED, f"{part} (knockdown)"))

    # AIS needs its antenna and the main electronics box it lives in.
    ais_ok = not any(damage.get(k) or k in failed for k in ("ais_whip", "electronics_main"))
    lam = ship_strike_rate_per_hour(p, env.ship_density, ais_ok)
    if not lost and u[SLOT["strike"]] < 1.0 - math.exp(-lam * hours):
        survived = u[SLOT["strike_survived"]] >= p.p_lost_given_strike
        events.append(
            Event(t, EventKind.SHIP_STRIKE, "survived, damaged" if survived else "sunk or wrecked")
        )
        if survived:
            hit = ("panel_100w_a", "rudder", "leak_main_tub")
            for part in hit if u[SLOT["strike_leak"]] < p.p_leak_given_strike else hit[:2]:
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


def wearout_mult(p: HazardParams, days_open_ocean: float) -> float:
    """#118 wear-out on open-ocean hardware rates; 1 when wearout_k is 1."""
    return wearout_multiplier(
        days_open_ocean, {"k": p.wearout_k, "t_ref_days": p.wearout_t_ref_days}
    )


def early_life_mult(p: HazardParams, days_at_sea: float) -> float:
    """R2 infant mortality: 1 + k e^(-(day + shakedown)/tau)."""
    if p.early_life_k <= 0.0:
        return 1.0
    return 1.0 + p.early_life_k * math.exp(
        -(max(days_at_sea, 0.0) + p.shakedown_days) / p.early_life_tau_days
    )


NEAR_LAND, OPEN_OCEAN = "near land", "open ocean"


def phase(p: HazardParams, land_km: float) -> str:
    """Which exposure phase of the shared table a point is in."""
    return NEAR_LAND if land_km < p.near_land_km else OPEN_OCEAN


def tag_phase(detail: str, ph: str) -> str:
    """'cause' -> 'cause [near land]': how a LOST event records its phase."""
    return f"{detail} [{ph}]"


def split_phase(detail: str) -> tuple[str, str | None]:
    """'cause [near land]' -> ('cause', 'near land'); untagged -> (detail, None)."""
    for ph in (NEAR_LAND, OPEN_OCEAN):
        suffix = f" [{ph}]"
        if detail.endswith(suffix):
            return detail[: -len(suffix)], ph
    return detail, None


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
    rng: np.ndarray | np.random.Generator,
    thrusters: tuple[str, ...] = ("thruster_port", "thruster_starboard"),
    days_open_ocean: float = 0.0,
) -> HazardOutcome:
    """Draw the non-wave failures for one step: leaks, electronics, software,
    Iridium going silent, the beacon, steering, entanglement, thruster wear-out
    and capture. Hardware rates carry the early-life multiplier.

    rng: the step's dice block (draw_dice), or a Generator to draw one from.
    thrusters: damage names of the thrusters the boat has (KayakVessel passes
    them from propulsion.thruster_count), so a one-thruster boat only rolls one die.
    days_open_ocean: days spent beyond near_land_km so far, for the wear-out term."""
    u = _dice(rng)
    out = HazardOutcome([], [], False, 0)
    if not (p.enabled and p.failures_enabled):
        return out
    if len(thrusters) > MAX_THRUSTERS:
        raise ValueError(f"at most {MAX_THRUSTERS} thrusters have dice slots")

    def roll(slot: str, rate_per_day: float) -> bool:
        return bool(u[SLOT[slot]] < _p(rate_per_day, hours))

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
    early = early_life_mult(p, days_at_sea)
    if land_km >= p.near_land_km:
        early *= wearout_mult(p, days_open_ocean)

    # Leak into one of the two tubs
    if roll("leak", p.leak_per_day * (1.0 + (hs / 3.0) ** 2) * early):
        one_box = p.electronics_boxes == 1  # one box, one tub that matters
        tub = "leak_main_tub" if one_box or u[SLOT["leak_tub"]] < 0.5 else "leak_safe_tub"
        if not broken(tub):
            fail(tub, "water getting into the hull")

    # Electronics boxes (beta-factor model): each box fails on its own at
    # (1 - beta) of the rate, likelier once its tub is wet; a common cause at
    # beta of the rate takes out both. Software hang on main.
    beta = min(max(p.electronics_common_cause, 0.0), 1.0)
    wet = any(broken(TUB_FOR_BOX[b]) for b in ELECTRONICS)
    if p.electronics_boxes == 1:
        rate = p.electronics_per_day * early * (p.electronics_wet_multiplier if wet else 1.0)
        rate += p.software_hang_per_day * (1.0 - p.watchdog_recovers)
        if roll("electronics_common", rate) and not broken("electronics_main"):
            fail("electronics_main", "the one electronics box: electronics or software failure")
            out.failed_parts.append("electronics_safe")  # no second box to fall back on
            if broken("beacon"):  # no working backup tracker (or none fitted)
                lose("electronics box dead: silent and uncontrolled")
                return out
            # A backup tracker in its own compartment (Rev B's YB3) keeps reporting:
            # the boat drifts on, uncontrolled but tracked, and the runner scores it
            # as usual (#153). The tracker can still fail later (beacon die below).
    else:
        common = beta * p.electronics_per_day * early
        if wet:
            common *= p.electronics_wet_multiplier
        if roll("electronics_common", common) and not all(broken(b) for b in ELECTRONICS):
            for box in ELECTRONICS:
                if not broken(box):
                    fail(box, "common-cause electronics failure")
        for box in ELECTRONICS:
            rate = (1.0 - beta) * p.electronics_per_day * early
            if broken(TUB_FOR_BOX[box]):
                rate *= p.electronics_wet_multiplier
            if box == "electronics_main":
                rate += p.software_hang_per_day * (1.0 - p.watchdog_recovers)
            if roll(box, rate) and not broken(box):
                fail(box, "electronics or software failure")
        if all(broken(b) for b in ELECTRONICS):
            lose("both electronics boxes dead: silent and uncontrolled")
            return out

    # Comms: Iridium goes silent while the boat sails on; the beacon on its own
    comms_rate = p.comms_silent_per_day * (1.0 + hs / 4.0) * early
    if roll("comms_silent", comms_rate) and not broken("comms_silent"):
        fail("comms_silent", "Iridium modem, antenna or comms power")
    if roll("beacon", p.beacon_per_day * early) and not broken("beacon"):
        fail("beacon", "Globalstar beacon failed")

    # Steering
    if roll("steering", p.steering_per_day * (1.0 + hs / 4.0) * early) and not broken("rudder"):
        if u[SLOT["steering_jam"]] < p.steering_jam_share:
            fail("rudder", "servo jammed")
            out.failed_parts.append("rudder_jammed")
        else:
            fail("rudder", "servo failed limp, spring centres it")

    # Entanglement: comes and goes (one slot: it either clears or starts)
    if broken("entangled"):
        if roll("entangle", p.entangle_clear_per_day):
            out.cleared_parts.append("entangled")  # no event: EventKind has no "recovered"
    elif roll("entangle", entangle_rate_per_day(p, lat, lon, land_km)):
        fail("entangled", "fishing line or weed")
        working = [th for th in thrusters if not broken(th)]
        if working and u[SLOT["thruster_wrap"]] < p.p_thruster_wrap:
            which = min(int(u[SLOT["thruster_wrap_which"]] * len(working)), len(working) - 1)
            fail(working[which], "line wrapped round it")

    # Thruster wear-out: one die per thruster the boat actually has
    for i, th in enumerate(thrusters):
        if roll(f"thruster_{i}", p.thruster_per_day * early) and not broken(th):
            fail(th, "bearing or motor failure")

    # Taken or snagged by fishermen near land
    rate = p.capture_per_day if land_km < p.capture_near_land_km else 0.0
    if roll("capture", rate):
        lose("taken or snagged by fishermen")
        return out

    # Early-life defect or unknown (the "original" set only, by default)
    if roll("unknown", unknown_hazard_per_day(p, days_at_sea)):
        lose("early-life defect or unknown failure")

    return out
