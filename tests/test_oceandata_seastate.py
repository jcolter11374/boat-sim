from datetime import datetime

import numpy as np
import pytest
import xarray as xr

from boatsim.oceandata import seastate
from boatsim.oceandata.grid import Box

BOX = Box(lat_min=30.0, lat_max=33.0, lon_min=-3.0, lon_max=2.0)


def _fake_arco(path):
    """ARCO-ERA5 layout (lat 90..-90, lon 0..359.75, hourly) with the wave partitions.
    Value of each field = field number + lat/100, so position and order are checkable."""
    times = np.arange("2020-04-01T00", "2020-05-01T01", dtype="datetime64[h]").astype("M8[ns]")
    lat = np.arange(40.0, 24.9, -0.25)
    lon = np.concatenate([np.arange(0.0, 5.0, 0.25), np.arange(355.0, 360.0, 0.25)])
    shape = (len(times), len(lat), len(lon))
    data = {}
    for n, (_, src, _, _) in enumerate(seastate.FIELDS):
        a = np.broadcast_to((n + lat / 100.0)[None, :, None], shape).copy()
        data[src] = a
    data["significant_height_of_wind_waves"][:, lat == 31.0, :] = np.nan  # "land" row
    ds = xr.Dataset(
        {k: (("time", "latitude", "longitude"), v.astype(np.float32)) for k, v in data.items()},
        coords={"time": times, "latitude": lat, "longitude": lon},
    )
    ds.to_zarr(path, mode="w")
    return xr.open_zarr(path, chunks=None)


def test_pack_round_trip_and_fill():
    a = np.array([1.234, np.nan, -0.5, 400.0])
    q = seastate.pack(a, 0.01)
    assert q.dtype == np.dtype("<i2")
    assert q[1] == seastate.FILL
    b = seastate.unpack(q, 0.01)
    assert b[0] == pytest.approx(1.23, abs=1e-5) and np.isnan(b[1])
    assert b[3] == pytest.approx(327.67, abs=1e-3)  # clipped, not wrapped


def test_month_times():
    t = seastate.month_times(2020, 4)
    assert len(t) == 30 * 8 and t[0] == datetime(2020, 4, 1) and t[-1] == datetime(2020, 4, 30, 21)
    assert len(seastate.month_times(2020, 12)) == 31 * 8


def test_bake_month_grid_order_and_values(tmp_path):
    store = _fake_arco(tmp_path / "arco.zarr")
    js, _bz = seastate.bake_month(2020, 4, tmp_path / "out", box=BOX, store=store, workers=2)
    h, planes = seastate.read_grid(js.with_suffix(""))
    assert (h["nlat"], h["nlon"]) == (4, 6)  # whole degrees only: 30..33, -3..2
    assert (h["lat0"], h["lon0"]) == (30.0, -3.0)
    assert planes.shape == (240, len(seastate.FIELDS), 4, 6)
    assert [f["name"] for f in h["fields"]][:3] == ["ws_hs", "ws_tm", "ws_dir"]
    s = seastate.sample(h, planes, datetime(2020, 4, 10, 6), 32.0, 1.0)
    assert s["s1_hs"] == pytest.approx(3.32, abs=0.006)
    assert s["s2_dir"] == pytest.approx(8.32, abs=0.06)
    assert np.isnan(seastate.sample(h, planes, datetime(2020, 4, 10), 31.0, 0.0)["ws_hs"])
    assert h["attribution"].startswith("Contains modified Copernicus")
    idx = seastate.write_index(tmp_path / "out")
    assert '"2020-04"' in idx.read_text()


def test_bake_month_refuses_missing_time(tmp_path):
    store = _fake_arco(tmp_path / "arco.zarr")
    with pytest.raises(ValueError, match="not fully"):
        seastate.bake_month(2020, 5, tmp_path / "out", box=BOX, store=store)


def test_bake_depth_falls_back_and_flips(tmp_path):
    lat = np.arange(40.0, 36.0, -0.5)  # descending, like some grids
    lon = np.arange(-78.0, -73.0, 0.5)
    z = (lat[:, None] * 0 + lon[None, :]).astype(np.float32)  # elevation = lon
    good = xr.Dataset({"z": (("lat", "lon"), z)}, coords={"lat": lat, "lon": lon})

    def opener(url):
        if "bad" in url:
            raise OSError("no route")
        return good

    log = []
    js, _ = seastate.bake_depth(
        tmp_path,
        sources=[("GEBCO x", "bad://"), ("ETOPO 2022 30s", "ok://")],
        opener=opener,
        log=log.append,
    )
    h, planes = seastate.read_grid(js.with_suffix(""))
    assert h["source"] == "ETOPO 2022 30s" and "ETOPO" in h["attribution"]
    assert h["lat0"] == 36.5 and h["lon0"] == -77.5  # inside DEPTH_BOX, south first
    assert planes[0, 0] == -78  # elevation -77.5 rounded to whole metres
    assert any("failed" in m for m in log)
