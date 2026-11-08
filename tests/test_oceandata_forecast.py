import math
from datetime import datetime, timedelta

import numpy as np
import pytest

from boatsim.oceandata import ConstantEnvironment, ErrorForecast
from boatsim.types import EnvState

TRUTH = EnvState(wind_u=5.0, wind_v=-2.0, current_u=0.3, hs=2.0, tp=9.0, ghi=500.0, air_temp=18.0)
T0 = datetime(2020, 10, 1)


def _wind_rms(lead: timedelta, n=400, scale=1.0) -> float:
    """Vector RMS wind error over many independent forecasts and places."""
    fc = ErrorForecast(ConstantEnvironment(TRUTH), seed=7, scale=scale)
    rng = np.random.default_rng(1)
    sq = []
    for i in range(n):
        issued = fc.issue(T0 + timedelta(hours=6 * i))
        lat, lon = rng.uniform(30, 50), rng.uniform(-70, -20)
        s = issued.sample(issued.t_issue + lead, lat, lon)
        sq.append((s.wind_u - TRUTH.wind_u) ** 2 + (s.wind_v - TRUTH.wind_v) ** 2)
    return math.sqrt(np.mean(sq))


def test_error_grows_with_lead_time_at_the_intended_size():
    r0, r1, r3, r7 = (_wind_rms(timedelta(days=d)) for d in (0, 1, 3, 7))
    assert r0 < r1 < r3 < r7
    assert r1 == pytest.approx(2.0, rel=0.2)  # table: 2.0 m/s vector RMS at day 1
    assert r7 == pytest.approx(5.5, rel=0.2)


def test_same_forecast_same_answer_new_forecast_new_error():
    fc = ErrorForecast(ConstantEnvironment(TRUTH), seed=3)
    t = T0 + timedelta(days=2)
    a = fc.issue(T0).sample(t, 40.0, -50.0)
    assert a == fc.issue(T0).sample(t, 40.0, -50.0)
    assert a != fc.issue(T0 + timedelta(days=1)).sample(t, 40.0, -50.0)
    assert a != ErrorForecast(ConstantEnvironment(TRUTH), seed=4).issue(T0).sample(t, 40.0, -50.0)


def test_error_is_smooth_in_space():
    """Across many forecasts, errors 17 km apart move together; 2,500 km apart they don't."""
    fc = ErrorForecast(ConstantEnvironment(TRUTH), seed=1)
    here, near, far = [], [], []
    for i in range(400):
        issued = fc.issue(T0 + timedelta(hours=6 * i))
        t = issued.t_issue + timedelta(days=3)
        here.append(issued.sample(t, 40.0, -50.0).wind_u)
        near.append(issued.sample(t, 40.0, -49.8).wind_u)
        far.append(issued.sample(t, 40.0, -20.0).wind_u)
    assert np.corrcoef(here, near)[0, 1] > 0.95
    assert abs(np.corrcoef(here, far)[0, 1]) < 0.2


def test_scale_zero_is_the_truth_and_waves_stay_positive():
    env = ConstantEnvironment(TRUTH)
    assert ErrorForecast(env, scale=0).issue(T0) is env
    issued = ErrorForecast(env, seed=2, scale=3.0).issue(T0)
    for d in range(10):
        s = issued.sample(T0 + timedelta(days=d), 40.0, -40.0)
        assert s.hs > 0 and s.ghi >= 0


def test_wave_error_does_not_bias_the_mean():
    hs = []
    for i in range(500):
        issued = ErrorForecast(ConstantEnvironment(TRUTH), seed=5).issue(T0 + timedelta(hours=i))
        hs.append(issued.sample(issued.t_issue + timedelta(days=5), 40.0, -40.0).hs)
    assert np.mean(hs) == pytest.approx(TRUTH.hs, rel=0.05)
