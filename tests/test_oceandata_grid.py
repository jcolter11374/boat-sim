from datetime import datetime

import numpy as np
import pytest

from boatsim.oceandata.grid import Box, GridSeries, OutsideCoverage, TileCache


def _grid(fn=lambda t, y, x: 0 * x + 0 * y + t):
    times = np.array(["2020-10-15T00:00", "2020-10-15T01:00"], dtype="datetime64[s]")
    lats = np.array([30.0, 31.0])
    lons = np.array([-70.0, -69.0])
    tt, yy, xx = np.meshgrid(np.arange(2.0), lats, lons, indexing="ij")
    return GridSeries(times, lats, lons, {"f": fn(tt, yy, xx).astype(np.float32)})


def test_linear_in_time():
    g = _grid()
    assert g.sample(datetime(2020, 10, 15, 0, 30), 30.5, -69.5, ["f"])["f"] == pytest.approx(0.5)


def test_bilinear_in_space_reproduces_a_plane():
    g = _grid(lambda t, y, x: 2 * y + 3 * x)
    want = 2 * 30.25 + 3 * -69.9
    assert g.sample(datetime(2020, 10, 15), 30.25, -69.9, ["f"])["f"] == pytest.approx(want, 1e-5)


def test_nan_corners_are_skipped():
    g = _grid(lambda t, y, x: 0 * x + 5.0)
    g.fields["f"][:, 0, 0] = np.nan  # one land point
    assert g.sample(datetime(2020, 10, 15), 30.1, -69.9, ["f"])["f"] == pytest.approx(5.0)
    g.fields["f"][:] = np.nan
    assert np.isnan(g.sample(datetime(2020, 10, 15), 30.1, -69.9, ["f"])["f"])


def test_outside_raises():
    g = _grid()
    with pytest.raises(OutsideCoverage):
        g.sample(datetime(2020, 10, 15), 40.0, -69.5, ["f"])
    with pytest.raises(OutsideCoverage):
        g.sample(datetime(2020, 10, 16), 30.5, -69.5, ["f"])


def test_box_and_cache():
    assert Box(25, 60, -82, 5).contains(38.5, -28.0)
    assert not Box(25, 60, -82, 5).contains(36.85, -85.0)
    loads = []
    cache = TileCache(lambda k: loads.append(k) or k, max_tiles=2)
    for k in [1, 2, 1, 3, 1, 2]:
        cache.get(k)
    assert loads == [1, 2, 3, 2]
