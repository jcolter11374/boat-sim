import math
from datetime import UTC, datetime, timedelta

import pytest

from boatsim.oceandata import tides as T
from boatsim.oceandata.base import ConstantEnvironment
from boatsim.types import EnvState


def _m2_station(amp=1.0, flood=0.0, mean=0.0, lat=37.0, lon=-76.0):
    return T.Station("x", "Test", lat, lon, flood, mean, (("M2", amp, 0.0),))


def test_m2_repeats_every_12_42_hours_and_reverses_halfway():
    s = _m2_station()
    t0 = datetime(2024, 5, 1, tzinfo=UTC)
    period = timedelta(hours=360 / 28.9841042)
    for k in range(5):
        t = t0 + timedelta(hours=k * 2.3)
        assert s.speed(t + period) == pytest.approx(s.speed(t), abs=2e-3)
        assert s.speed(t + period / 2) == pytest.approx(-s.speed(t), abs=2e-3)
    peak = max(abs(s.speed(t0 + timedelta(minutes=10 * i))) for i in range(80))
    assert 0.95 < peak < 1.05  # f for M2 is within 4% of 1


def test_astro_speeds_match_the_constituent_speeds():
    """M2, S2, K1 and O1 arguments advance at their published speeds (deg/h)."""
    t0 = datetime(2024, 1, 1, tzinfo=UTC)
    a0, a1 = T.astro(t0), T.astro(t0 + timedelta(hours=1))
    for name, speed in (("M2", 28.9841042), ("S2", 30.0), ("K1", 15.0410686), ("O1", 13.9430356)):
        d = T.DOODSON[name][0]
        args = [(a1[k] - a0[k]) for k in ("tau", "s", "h", "p", "N", "p1")]
        args[4] = -args[4]
        assert sum(x * y for x, y in zip(d, args, strict=True)) == pytest.approx(speed, abs=1e-3)


def test_layer_adds_the_tide_near_stations_and_nothing_elsewhere():
    base = ConstantEnvironment(EnvState(current_u=0.1, current_v=0.2))
    s = _m2_station(flood=90.0)  # floods east
    env = T.TidalCurrents(base, [s])
    t = datetime(2024, 5, 1, 3, tzinfo=UTC)
    far = env.sample(t, 38.0, -76.0)
    assert far is base.state  # untouched, the same object
    at = env.sample(t, 37.0, -76.0)
    sp = s.speed(t)
    assert at.current_u == pytest.approx(0.1 + sp, abs=1e-9) and at.current_v == pytest.approx(0.2)
    half = env.sample(t, 37.0 + 6.0 / 111.2, -76.0)  # 6 km away: half strength
    assert half.current_u == pytest.approx(0.1 + 0.5 * sp, abs=1e-3)
    assert math.isclose(env.radius_km, T.RADIUS_KM)
