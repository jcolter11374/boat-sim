"""Thrust from electrical power for the Blue Robotics T200 thrusters.

Model: ideal actuator-disc (momentum) theory times one overall efficiency.

    eta * P_elec = T * (V + v_i),   v_i = -V/2 + sqrt(V^2/4 + T / (2 rho A))

T is thrust, V the boat's speed through the water, v_i the extra speed the
propeller gives the water and A the propeller disc area. The (V + v_i) term
means a thruster gets more thrust per watt when it is pushing a slow, heavy
load and is most efficient at low thrust and some forward speed.

eta lumps ESC, motor, propeller blade losses and the shroud. It is fitted to
Blue Robotics' published full-throttle point at 12 V (3.71 kgf forward for
205 W, T200 R2 product page). That point gives eta = 0.35. Using the same
eta at low power is a GUESS: brushless motors lose efficiency at light load,
so the real thruster may be a little worse at the ~15 W per thruster we cruise
at. The tow test and the Bay trial (issue #5) replace this.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from boatsim.vessel.hull import RHO_WATER, G

T200_DIAMETER_M = 0.076  # 76 mm propeller, Blue Robotics datasheet
T200_FULL_THRUST_N = 3.71 * G  # 12 V full throttle, forward, datasheet
T200_FULL_POWER_W = 205.0  # 12 V full throttle, datasheet


def _bollard_ideal_power(thrust: float, disc_area: float) -> float:
    """Ideal power to make `thrust` at zero speed: T^1.5 / sqrt(2 rho A)."""
    return thrust**1.5 / math.sqrt(2.0 * RHO_WATER * disc_area)


def fitted_efficiency(diameter: float = T200_DIAMETER_M) -> float:
    """Overall efficiency implied by the datasheet full-throttle bollard point."""
    area = math.pi * diameter**2 / 4.0
    return _bollard_ideal_power(T200_FULL_THRUST_N, area) / T200_FULL_POWER_W


@dataclass(frozen=True)
class ThrusterParams:
    count: int = 2
    diameter_m: float = T200_DIAMETER_M
    efficiency: float = round(fitted_efficiency(), 3)  # ~0.35, see module docstring
    max_power_each_w: float = 50.0  # design doc: 100 W burst for the pair

    @classmethod
    def from_config(cls, prop: dict) -> ThrusterParams:
        kw = {}
        if "thruster_count" in prop:
            kw["count"] = int(prop["thruster_count"])
        if "thruster_efficiency" in prop:
            kw["efficiency"] = float(prop["thruster_efficiency"])
        if "max_drive_w" in prop:
            kw["max_power_each_w"] = float(prop["max_drive_w"]) / max(kw.get("count", cls.count), 1)
        return cls(**kw)

    @property
    def disc_area_m2(self) -> float:
        return math.pi * self.diameter_m**2 / 4.0


def thrust_one(p: ThrusterParams, power_w: float, speed: float) -> float:
    """Thrust in N from one thruster given its electrical power and boat speed.

    Solves eta P = T (V + v_i) exactly by Newton's method on s = V/2 + v_i,
    which turns it into  q (s - V/2)(s + V/2)^2 = eta P  with q = 2 rho A.
    That cubic is increasing and convex for s > V/2, so Newton from the right
    converges without overshoot.
    """
    if power_w <= 0.0:
        return 0.0
    v = max(speed, 0.0)  # going backwards: treat as bollard, close enough
    q = 2.0 * RHO_WATER * p.disc_area_m2
    target = p.efficiency * power_w
    half = 0.5 * v
    s = half + (target / q) ** (1.0 / 3.0)  # h(s) >= 0 here, so we start right of the root
    for _ in range(30):
        lo, hi = s - half, s + half
        h = q * lo * hi * hi - target
        dh = q * (hi * hi + 2.0 * lo * hi)
        step = h / dh
        s -= step
        if abs(step) < 1e-9:
            break
    return q * (s * s - half * half)


def total_thrust(p: ThrusterParams, power_w: float, speed: float, working: int) -> float:
    """Thrust from all working thrusters sharing `power_w` equally."""
    if working <= 0:
        return 0.0
    return working * thrust_one(p, power_w / working, speed)
