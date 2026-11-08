import pytest

from boatsim.geo import KNOT
from boatsim.vessel import hull as H
from boatsim.vessel.calibrate import (
    fit_form_factor,
    fit_thruster_efficiency,
    predicted_bollard_kgf,
)
from boatsim.vessel.propulsion import ThrusterParams


def test_form_factor_fit_recovers_a_known_hull():
    true = H.HullParams(form_factor=1.6)
    speeds = [1.0, 1.5, 2.0, 2.5, 3.0]
    kgf = [H.calm_drag(true, v * KNOT) / H.G for v in speeds]
    assert fit_form_factor(speeds, kgf) == pytest.approx(1.6, rel=1e-6)


def test_thruster_efficiency_fit_recovers_the_model():
    watts = [10.0, 20.0, 40.0]
    kgf = [predicted_bollard_kgf(w, efficiency=0.25) for w in watts]
    assert fit_thruster_efficiency(watts, kgf) == pytest.approx(0.25, rel=1e-3)


def test_expected_tow_readings_are_small():
    # So John knows what scale to buy: ~0.5 kgf at 1.7 kt, ~1.3 kgf at 3 kt.
    assert 0.3 < H.calm_drag(H.HullParams(), 1.7 * KNOT) / H.G < 0.6
    assert 1.0 < H.calm_drag(H.HullParams(), 3.0 * KNOT) / H.G < 1.6
    assert 0.5 < predicted_bollard_kgf(15.0) < 1.2
    assert ThrusterParams().efficiency > 0
