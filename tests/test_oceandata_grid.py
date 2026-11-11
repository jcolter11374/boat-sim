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


def _reference_sample(g, t, lat, lon, names):
    """The plain per-field form GridSeries.sample replaced (#192 follow-up);
    the fast form must give the same bits."""
    ts = int(np.datetime64(t, "s").astype(np.int64))
    tsec = g.times.astype(np.int64)
    k = min(int(np.searchsorted(tsec, ts, side="right")) - 1, len(tsec) - 2)
    wt = (ts - tsec[k]) / (tsec[k + 1] - tsec[k])
    i = min(int(np.searchsorted(g.lats, lat, side="right")) - 1, len(g.lats) - 2)
    wy = (lat - g.lats[i]) / (g.lats[i + 1] - g.lats[i])
    j = min(int(np.searchsorted(g.lons, lon, side="right")) - 1, len(g.lons) - 2)
    wx = (lon - g.lons[j]) / (g.lons[j + 1] - g.lons[j])
    w_space = np.array([(1 - wy) * (1 - wx), (1 - wy) * wx, wy * (1 - wx), wy * wx])
    w = np.concatenate([w_space * (1 - wt), w_space * wt])
    k1 = k + 1
    out = {}
    for name in names:
        a = g.fields[name]
        v = np.array(
            [a[k, i, j], a[k, i, j + 1], a[k, i + 1, j], a[k, i + 1, j + 1]]
            + [a[k1, i, j], a[k1, i, j + 1], a[k1, i + 1, j], a[k1, i + 1, j + 1]],
            dtype=np.float64,
        )
        ok = np.isfinite(v)
        wsum = w[ok].sum()
        out[name] = float(np.dot(w[ok], v[ok]) / wsum) if wsum > 1e-12 else float("nan")
    return out


def test_fast_sampling_gives_the_same_bits_as_the_plain_form():
    rng = np.random.default_rng(3)
    times = np.arange("2020-05-01", "2020-05-03", np.timedelta64(6, "h"), dtype="datetime64[s]")
    lats, lons = np.arange(30.0, 36.0), np.arange(-70.0, -62.0, 0.5)
    shape = (len(times), len(lats), len(lons))
    fields = {n: (rng.normal(size=shape) * 7).astype(np.float32) for n in ("a", "b", "c")}
    fields["b"][rng.random(shape) < 0.2] = np.nan  # land and gaps
    g = GridSeries(times, lats, lons, fields)
    for _ in range(3000):
        t = times[0] + np.timedelta64(int(rng.integers(0, 42 * 3600)), "s")
        lat, lon = rng.uniform(30, 35), rng.uniform(-70, -62.5)
        for names in (["a", "b", "c"], ["c", "a"], ["a"]):
            got = g.sample(t, lat, lon, iter(names))
            want = _reference_sample(g, t, lat, lon, names)
            for n in names:
                assert got[n] == want[n] or (np.isnan(got[n]) and np.isnan(want[n]))
