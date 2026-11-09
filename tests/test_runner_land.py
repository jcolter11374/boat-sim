from datetime import datetime

import numpy as np
import pytest

from boatsim.autonomy import SafeModeAutopilot
from boatsim.oceandata.base import ConstantEnvironment
from boatsim.runner.land import DEFAULT_PATH, SPOT_CHECKS, LandMask, is_european_land
from boatsim.runner.parallel import StandardVoyage
from boatsim.runner.simulate import simulate
from boatsim.types import EnvState, EventKind, Mission, Outcome, Waypoint


def _mask_with_land(lat_min, lat_max, lon_min, lon_max) -> LandMask:
    """Water everywhere in 30-45N, 80-60W except one rectangle of land."""
    res = 0.02
    lat0, lon0 = 30.0, -80.0
    m = np.zeros((round(15 / res), round(20 / res)), dtype=bool)
    i0, i1 = round((lat_min - lat0) / res), round((lat_max - lat0) / res)
    j0, j1 = round((lon_min - lon0) / res), round((lon_max - lon0) / res)
    m[i0:i1, j0:j1] = True
    return LandMask(m, lat0, lon0, res)


def test_mask_lookup_and_round_trip(tmp_path):
    m = _mask_with_land(36.0, 37.0, -77.0, -76.0)
    assert m.on_land(36.5, -76.5)
    assert not m.on_land(36.5, -75.5)
    assert not m.on_land(10.0, -76.5)  # outside the grid counts as water
    p = tmp_path / "m.npz"
    m.save(p)
    m2 = LandMask.load(p)
    assert np.array_equal(m.mask, m2.mask)
    assert m2.on_land(36.5, -76.5)


def test_european_land_counts_as_arrival_zone():
    assert is_european_land(38.7, -27.2)  # Azores
    assert is_european_land(52.0, -8.5)  # Ireland
    assert not is_european_land(32.3, -64.8)  # Bermuda
    assert not is_european_land(32.7, -16.9)  # Madeira: not named by the rule


def test_dead_boat_drifting_onshore_ends_aground():
    """No thrust, an onshore (westward) current just off Cape Henry: aground."""
    job = StandardVoyage(weather="constant")
    c = job.components()
    c.env = ConstantEnvironment(EnvState(current_u=-0.5, wind_u=0.0, wind_v=0.0, ghi=250.0))
    c.land = _mask_with_land(36.0, 38.0, -78.0, -75.9)  # "Virginia" west of 75.9W
    c.autopilot = SafeModeAutopilot(cruise_fraction=0.0)  # dead in the water
    log = simulate(
        c,
        datetime(2020, 5, 15),
        36.9,
        -75.7,
        Mission([Waypoint(36.9, -70.0)]),
        max_days=10,
    )
    assert log.outcome == Outcome.AGROUND
    assert log.days < 2
    assert any(e.kind == EventKind.AGROUND for e in log.events)


@pytest.mark.skipif(not DEFAULT_PATH.exists(), reason="land mask not built yet")
@pytest.mark.parametrize(("lat", "lon", "want", "name"), SPOT_CHECKS)
def test_committed_mask_spot_checks(lat, lon, want, name):
    m = LandMask.load(DEFAULT_PATH)
    assert m.on_land(lat, lon) == want, name


def test_build_keeps_small_islands(tmp_path):
    shapely_geometry = pytest.importorskip("shapely.geometry")
    import json

    from boatsim.runner.land import build

    island = shapely_geometry.box(-64.78, 32.31, -64.77, 32.32)  # ~1 km, like Bermuda
    src = tmp_path / "land.geojson"
    src.write_text(json.dumps({"features": [{"geometry": shapely_geometry.mapping(island)}]}))
    m = build(src, tmp_path / "mask.npz")
    assert m.on_land(32.315, -64.775)
    assert not m.on_land(32.4, -64.6)
