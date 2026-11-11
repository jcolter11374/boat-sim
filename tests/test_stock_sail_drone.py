"""The wind-powered ocean drone (configs/stock_sail_drone7.yaml): published specs
of a 7 m sailing drone (length, wing height, draft, weight, 2-3 kn average,
8+ kn top), sailed by the same free-rotating wing model as Rev B (vessel/sail.py)."""

from dataclasses import replace
from datetime import datetime, timedelta

import numpy as np
import pytest

from boatsim.config import load_design
from boatsim.types import Command, EnvState
from boatsim.vessel import KayakVessel, make_vessel

CFG = "configs/stock_sail_drone7.yaml"
KN = 0.514444


@pytest.fixture(scope="module")
def drone():
    v = make_vessel(load_design(CFG))
    v.hazards = replace(v.hazards, enabled=False, failures_enabled=False)
    return v


def speed_kn(v, wind_ms, twa, hours=2.0):
    """Steady speed through the water, wind from the north, ordered `twa` off it."""
    env = EnvState(ghi=500.0, wind_v=-wind_ms, hs=0.02 * wind_ms**2, tp=6.0, wave_dir=0.0)
    s = replace(v.initial_state(datetime(2020, 5, 1, 12), 37.0, -60.0), heading=float(twa))
    rng = np.random.default_rng(0)
    for _ in range(int(hours * 6)):
        s, _ = v.step(s, Command(float(twa), 0.0), env, timedelta(minutes=10), rng)
    return s.speed_through_water / KN, s


def test_it_is_a_wing_sailing_drone_with_no_motor(drone):
    assert type(drone) is KayakVessel and drone.sail is not None
    assert getattr(drone, "polar", None) is None
    d = load_design(CFG)
    assert d.propulsion["thruster_count"] == 0 and d.stock["label"] == "wind-powered ocean drone"


def test_speeds_match_the_published_range(drone):
    """Published: 2-3 kn average, 8+ kn top. A moderate breeze on the beam sits in
    the average band; nothing in ordinary winds reaches the top speed."""
    beam, _ = speed_kn(drone, 6.0, 90)
    assert 2.0 < beam < 4.0
    for ws in (3.0, 6.0, 10.0, 14.0):
        for twa in (50, 90, 135, 170):
            assert speed_kn(drone, ws, twa)[0] < 8.0
    assert speed_kn(drone, 6.0, 50)[0] < beam  # close-hauled is slower than a reach


def test_it_cannot_point_into_the_wind(drone):
    _, s = speed_kn(drone, 6.0, 20)  # ordered 20 deg off the wind
    off = abs((s.heading + 180.0) % 360.0 - 180.0)
    assert off >= 49.0  # sails the edge of the no-go zone (min_upwind_twa_deg 50)
