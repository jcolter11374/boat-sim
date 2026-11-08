"""Turn tow-test and dock-test readings into config numbers (issue #5).

See docs/tow-test.md for the procedure. Both fits are one-number least
squares: the shape of each curve comes from the model, and the test measures
how big it is.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import replace

from boatsim.geo import KNOT
from boatsim.vessel import hull as H
from boatsim.vessel.propulsion import ThrusterParams, thrust_one


def fit_form_factor(
    speeds_kt: Sequence[float], forces_kgf: Sequence[float], hull: H.HullParams | None = None
) -> float:
    """Best `form_factor` for the hull, from towing force at known speeds.

    speeds_kt: speed through the water for each run (average of the two
    directions, so any current cancels). forces_kgf: average tow-line pull on
    the scale, in kilograms as the scale shows it.
    """
    hull = hull or H.HullParams()
    unit = replace(hull, form_factor=1.0)
    m = [H.calm_drag(unit, v * KNOT) for v in speeds_kt]
    r = [f * H.G for f in forces_kgf]
    return sum(a * b for a, b in zip(m, r, strict=True)) / sum(a * a for a in m)


def fit_thruster_efficiency(power_w_each: Sequence[float], thrust_kgf: Sequence[float]) -> float:
    """Best overall thruster efficiency from a tied-to-the-dock (bollard) test.

    At zero speed the model gives T^1.5 = eta x P x sqrt(2 rho A), so each
    reading gives eta directly; this averages them weighted by power.
    """
    p = ThrusterParams()
    k = math.sqrt(2.0 * H.RHO_WATER * p.disc_area_m2)
    num = sum((t * H.G) ** 1.5 / k for t in thrust_kgf)
    return num / sum(power_w_each)


def predicted_bollard_kgf(power_w_each: float, efficiency: float | None = None) -> float:
    """What the scale should read for one thruster at `power_w_each` watts."""
    p = ThrusterParams() if efficiency is None else ThrusterParams(efficiency=efficiency)
    return thrust_one(p, power_w_each, 0.0) / H.G
