import math

import pytest

from boatsim.vessel.wearout import (
    RECORD_OPEN_OCEAN_PER_DAY,
    WEAROUT_PARAMS,
    wearout_multiplier,
)


def test_constant_rate_is_one_everywhere():
    for d in (0.0, 1.0, 30.0, 200.0):
        assert wearout_multiplier(d, "none") == 1.0


@pytest.mark.parametrize("name", ["central", "low", "high"])
def test_multiplier_is_one_at_t_ref(name):
    p = WEAROUT_PARAMS[name]
    assert wearout_multiplier(p["t_ref_days"], p) == pytest.approx(1.0)


def test_wearout_rises_and_falling_shape_falls():
    assert (
        wearout_multiplier(10, "central")
        < wearout_multiplier(60, "central")
        < wearout_multiplier(90, "central")
    )
    assert wearout_multiplier(10, "low") > wearout_multiplier(60, "low")


def test_central_row_reproduces_the_fitted_weibull():
    # Fit: shape 1.41, scale 78.6 days; hazard (k/s)(t/s)^(k-1)
    k, s = 1.41, 78.6
    for d in (15, 60, 90):
        fitted = (k / s) * (d / s) ** (k - 1)
        ours = RECORD_OPEN_OCEAN_PER_DAY * wearout_multiplier(d, "central")
        assert ours == pytest.approx(fitted, rel=0.02)


def test_small_days_are_clamped():
    assert math.isfinite(wearout_multiplier(0.0, "low"))
    assert wearout_multiplier(0.0, "central") == wearout_multiplier(1.0, "central")


def test_hazard_knob_applies_only_offshore():
    from datetime import datetime

    import numpy as np

    from boatsim.vessel import hazards as H

    p = H.HazardParams(wearout_k=2.24, wearout_t_ref_days=48.6)
    assert H.wearout_mult(H.HazardParams(), 90.0) == 1.0
    assert H.wearout_mult(p, 90.0) == pytest.approx((90 / 48.6) ** 1.24)
    # Same dice, open ocean: more wear means at least as many failures
    rng = np.random.default_rng(0)
    t = datetime(2020, 5, 1)
    n_off = n_on = 0
    for _ in range(3000):
        d = H.draw_dice(rng)
        kw = {"env": _calm(), "hours": 24.0, "damage": {}, "t": t, "lat": 40.0, "lon": -40.0}
        kw.update(days_at_sea=80.0, rng=d)
        n_off += len(H.sample_failures(H.HazardParams(), **kw).failed_parts)
        n_on += len(H.sample_failures(p, days_open_ocean=75.0, **kw).failed_parts)
    assert n_on > n_off


def _calm():
    import inspect

    from boatsim.types import EnvState

    fields = inspect.signature(EnvState).parameters
    return EnvState(**{k: 0.0 for k in fields if fields[k].default is inspect.Parameter.empty})
