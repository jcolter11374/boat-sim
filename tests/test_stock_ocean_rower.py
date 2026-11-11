"""The ocean rowing boat (configs/stock_ocean_rower45.yaml): published specs of
an 8.6 m ocean rowing class, four rowers in shifts (two at the oars, day and
night), and a para-anchor in head winds and gales (vessel/oddboats.py)."""

import math
from dataclasses import replace
from datetime import datetime, timedelta

import numpy as np
import pytest

from boatsim.config import load_design
from boatsim.types import Command, EnvState
from boatsim.vessel import OddBoatVessel, make_vessel

CFG = "configs/stock_ocean_rower45.yaml"
T0 = datetime(2020, 5, 1, 12)
KN = 0.514444


@pytest.fixture(scope="module")
def rower():
    v = make_vessel(load_design(CFG))
    v.hazards = replace(v.hazards, enabled=False)
    return v


def sea(wind_e):
    """A wind blowing toward the east at wind_e m/s (negative: from the east), with
    a wind sea to match."""
    ws = abs(wind_e)
    return EnvState(
        wind_u=wind_e,
        hs=0.17 * ws * ws / 9.81,
        tp=max(3.0, 0.73 * ws),
        wave_dir=270.0 if wind_e > 0 else 90.0,
    )


def row_east(v, env, hours=3.0, state=None):
    """Row east; returns (final state, knots made good east)."""
    s = state or replace(v.initial_state(T0, 37.0, -60.0), heading=90.0)
    lon0 = s.lon
    rng = np.random.default_rng(0)
    for _ in range(int(hours * 6)):
        s, _ = v.step(s, Command(90.0, 1.0), env, timedelta(minutes=10), rng)
    km = (s.lon - lon0) * 111.32 * math.cos(math.radians(37.0))
    return s, km / 1.852 / hours


def test_two_rowers_make_about_two_and_a_half_knots_day_and_night(rower):
    assert isinstance(rower, OddBoatVessel)
    _, kn = row_east(rower, EnvState())
    assert 2.2 < kn < 2.9
    night = replace(rower.initial_state(T0 + timedelta(hours=12), 37.0, -60.0), heading=90.0)
    assert rower.crew_on(night) and rower.crew_on(rower.initial_state(T0, 37.0, -60.0))


def test_a_following_breeze_helps_and_a_light_head_wind_slows(rower):
    _, calm = row_east(rower, EnvState())
    _, tail = row_east(rower, sea(6.0))
    _, head = row_east(rower, sea(-5.0))
    assert tail > calm > head > 1.0


def test_para_anchor_in_a_head_wind_or_a_gale_and_it_holds(rower):
    s, kn = row_east(rower, sea(-10.0))  # 20 kn on the nose
    assert s.on_anchor and not s.crew_working
    assert -1.0 < kn < 0.0  # drifting back, slowly
    s, kn = row_east(rower, sea(10.0))  # the same wind behind: keep rowing
    assert not s.on_anchor and kn > 3.0
    s, _ = row_east(rower, sea(17.0))  # a gale, even from behind: too rough to row
    assert s.on_anchor


def test_the_anchor_comes_in_only_once_the_wind_eases(rower):
    out, _ = row_east(rower, sea(-10.0), hours=1)
    still, _ = row_east(rower, sea(-6.0), hours=1, state=out)  # under 7 but not 2 less
    assert still.on_anchor
    back, _ = row_east(rower, sea(-4.0), hours=1, state=out)
    assert not back.on_anchor and back.crew_working


def test_boats_without_an_anchor_never_put_one_out():
    canoe = make_vessel(load_design("configs/joke_canoe.yaml"))
    assert not canoe.wants_anchor(90.0, sea(-30.0), False)
