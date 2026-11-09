"""A free-rotating wing sail, for sailing designs (configs/randolph_rev_b.yaml).

The v4 kayak has no sail; a design without a `sail:` block never touches this.

What is modelled (after the Randolph team's VPP, drone-boat
simulator/drone_sim/vpp.py and autopilot.py, MIT; see THIRD_PARTY_NOTICES.md):

* The wing turns freely on its mast and a tail flap sets its angle to the
  apparent wind (the wind the moving boat feels). Lift and drag come from a
  finite-wing curve that stalls smoothly into a flat plate.
* Each step the boat picks the wing angle that drives it forward hardest,
  without heeling it past its heel limit: the side force times the heeling
  arm must stay under the righting moment at that heel (GUESS arm).
* The wing sits low, so it feels less wind than the 10 m wind in the
  weather data: a log wind profile over a sea whose roughness grows with
  wave height, and some shelter behind wave crests (their numbers).
* A sailboat can't point into the wind. Inside `min_upwind_twa_deg` of the
  wind, or nearer than `min_downwind_twa_deg` to dead downwind, it sails the
  edge of that zone on one tack and only tacks over when the other tack is
  clearly better (hysteresis). In a storm it feathers the wing and runs off
  at `storm_run_twa_deg`.
* A feathered wing (no autopilot, broken wing, storm) gives only its small
  drag, and the boat drifts.

Display and comparison only: this is our model of their boat, not their
numbers, and it never feeds our own boat's odds.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from boatsim.vessel.hull import RHO_AIR

ALPHA_STEP_DEG = 2.5  # wing angles tried, 0 .. max_alpha_deg (their VPP grid)


@dataclass(frozen=True)
class SailParams:
    area_m2: float = 0.30
    aspect_ratio: float = 5.33
    cd0: float = 0.012
    span_efficiency: float = 0.85
    max_alpha_deg: float = 20.0
    ce_height_m: float = 0.66  # centre of effort above the waterline
    heel_arm_m: float = 0.9  # centre of effort to centre of lateral resistance
    max_heel_moment_nm: float = 17.4  # righting moment at the heel limit
    storm_wind_ms: float = 20.0
    storm_run_twa_deg: float = 140.0
    min_upwind_twa_deg: float = 50.0
    min_downwind_twa_deg: float = 165.0
    tack_hysteresis_deg: float = 20.0

    @classmethod
    def from_config(cls, sail: dict | None) -> SailParams | None:
        """From a design's `sail:` block; None when the design has no sail."""
        if not sail:
            return None
        return cls(**{k: v for k, v in sail.items() if k in cls.__dataclass_fields__})


def wrap180(a: float) -> float:
    return (a + 180.0) % 360.0 - 180.0


def foil_coeffs(alpha: float, ar: float, cd0: float, e: float = 0.85) -> tuple[float, float]:
    """Lift and drag coefficients of a finite symmetric wing at any angle (rad).

    Linear lift (slope from aspect ratio) and induced drag below stall, blended
    smoothly into flat-plate behaviour above it. Same curve as the Randolph
    VPP's foil_coeffs.
    """
    a = math.atan2(math.sin(alpha), math.cos(alpha))
    slope = 2.0 * math.pi * ar / (2.0 + math.sqrt(ar * ar + 4.0))
    stall = math.radians(10.0 + 4.0 * min(ar, 6.0) / 6.0)
    cdmax = 1.11 + 0.018 * min(ar, 20.0)
    cl_lin = slope * a
    cd_lin = cd0 + cl_lin * cl_lin / (math.pi * e * ar)
    cl_fp = 0.5 * cdmax * math.sin(2.0 * a)
    cd_fp = cd0 + cdmax * math.sin(a) ** 2
    x = (abs(a) - stall) / math.radians(2.5)
    w = 0.0 if x > 50.0 else 1.0 / (1.0 + math.exp(x))
    return w * cl_lin + (1.0 - w) * cl_fp, w * cd_lin + (1.0 - w) * cd_fp


def wind_factor(p: SailParams, hs: float) -> float:
    """Wind at the wing's height as a share of the 10 m wind (log profile over
    a sea roughened by waves, less shelter behind the crests)."""
    z = max(p.ce_height_m, 0.2)
    z0 = 2e-4 + 0.002 * max(hs, 0.0)
    shelter = 1.0 - 0.25 * min(max(hs / (2.0 * z), 0.0), 1.0)
    return math.log(z / z0) / math.log(10.0 / z0) * shelter


def wing_force(p: SailParams, ax: float, ay: float, alpha: float) -> tuple[float, float]:
    """Force (forward, starboard) in N on the wing at angle `alpha` (rad) to the
    apparent air flow (ax, ay): air velocity relative to the boat, boat axes.
    Lift goes to whichever side drives the boat forward."""
    v2 = ax * ax + ay * ay
    if v2 < 1e-12:
        return 0.0, 0.0
    v = math.sqrt(v2)
    ex, ey = ax / v, ay / v
    px, py = -ey, ex
    if px < 0.0:
        px, py = -px, -py
    cl, cd = foil_coeffs(alpha, p.aspect_ratio, p.cd0, p.span_efficiency)
    q = 0.5 * RHO_AIR * v2 * p.area_m2
    return q * (cd * ex + cl * px), q * (cd * ey + cl * py)


def best_alpha(p: SailParams, ax: float, ay: float, alpha_max_deg: float) -> float:
    """Wing angle (rad) with the most forward drive whose heeling moment stays
    within the limit. 0 (feathered) is always allowed."""
    best, best_fx = 0.0, wing_force(p, ax, ay, 0.0)[0]
    cap = p.max_heel_moment_nm / max(p.heel_arm_m, 1e-6)
    n = round(max(alpha_max_deg, 0.0) / ALPHA_STEP_DEG)
    for i in range(1, n + 1):
        a = math.radians(i * ALPHA_STEP_DEG)
        fx, fy = wing_force(p, ax, ay, a)
        if abs(fy) <= cap and fx > best_fx:
            best, best_fx = a, fx
    return best


def sail_heading(
    p: SailParams, desired: float, wind_from: float, prev_heading: float, tws: float
) -> tuple[float, bool]:
    """Heading the boat can actually sail toward `desired` (deg), and whether
    the wing is feathered (storm). wind_from: where the wind comes from, deg."""
    if tws > p.storm_wind_ms:
        angle, feather = p.storm_run_twa_deg, True
    else:
        rel = abs(wrap180(desired - wind_from))
        if rel < p.min_upwind_twa_deg:
            angle = p.min_upwind_twa_deg
        elif rel > p.min_downwind_twa_deg:
            angle = p.min_downwind_twa_deg
        else:
            return desired % 360.0, False
        feather = False
    h_plus, h_minus = (wind_from + angle) % 360.0, (wind_from - angle) % 360.0
    g_plus = math.cos(math.radians(wrap180(h_plus - desired)))
    g_minus = math.cos(math.radians(wrap180(h_minus - desired)))
    best = 1 if g_plus >= g_minus else -1
    cur = 1 if wrap180(prev_heading - wind_from) >= 0.0 else -1
    if best != cur and abs(g_plus - g_minus) <= math.sin(math.radians(p.tack_hysteresis_deg)):
        best = cur  # not clearly better: stay on this tack
    return (h_plus if best == 1 else h_minus), feather
