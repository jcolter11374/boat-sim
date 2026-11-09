"""SmocSource (#73) against fake Copernicus subsets, so CI needs no login."""

from datetime import datetime

import numpy as np
import pytest

xr = pytest.importorskip("xarray")
pytest.importorskip("netCDF4")

from boatsim.oceandata import smoc
from boatsim.oceandata.grid import Box, OutsideCoverage

BOX = Box(36.0, 38.0, -70.0, -68.0)
CALLS = []


def _fake_opener(dataset_id, variables, box, start, end):
    CALLS.append((dataset_id, tuple(variables)))
    hourly = dataset_id.endswith("PT1H-i")
    step = np.timedelta64(1, "h") if hourly else np.timedelta64(1, "D")
    t = np.arange(np.datetime64("2020-11-01"), np.datetime64("2026-01-01"), step)
    t = t[(t >= np.datetime64(start)) & (t <= np.datetime64(end))]
    lat = np.arange(box.lat_min, box.lat_max + 0.01, 0.5)
    lon = np.arange(box.lon_min, box.lon_max + 0.01, 0.5)
    hours = ((t - t[0]) / np.timedelta64(1, "h")).astype(float) if len(t) else np.zeros(0)
    shape = (len(t), 1, len(lat), len(lon))
    if hourly:  # 0.5 m/s east plus a 12-hour tide of 0.2 m/s
        u = 0.5 + 0.2 * np.sin(2 * np.pi * hours / 12.0)
    else:  # grows 0.1 m/s a day
        u = hours / 24.0 * 0.1
    u = np.broadcast_to(u[:, None, None, None], shape).astype(np.float32)
    v = np.full(shape, -0.3, dtype=np.float32)
    dims = ("time", "depth", "latitude", "longitude")
    return xr.Dataset(
        {variables[0]: (dims, u), variables[1]: (dims, v)},
        coords={"time": t.astype("M8[ns]"), "depth": [0.494], "latitude": lat, "longitude": lon},
    )


def test_model_kind_is_daily_mean_at_noon(tmp_path):
    CALLS.clear()
    src = smoc.SmocSource("model", tmp_path, box=BOX, opener=_fake_opener)
    # File starts Apr 30 (u = 0); May 1 daily mean u = 0.1, stamped May 1 12:00.
    assert src.sample(datetime(2022, 5, 1, 12), 37.0, -69.0)["current_u"] == pytest.approx(0.1)
    assert src.sample(datetime(2022, 5, 1, 0), 37.0, -69.0)["current_u"] == pytest.approx(0.05)
    assert src.sample(datetime(2022, 5, 1, 0), 37.0, -69.0)["current_v"] == pytest.approx(-0.3)
    assert CALLS == [("cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m", ("uo", "vo"))]


def test_total_kind_is_hourly_with_the_tide(tmp_path):
    CALLS.clear()
    src = smoc.SmocSource("total", tmp_path, box=BOX, opener=_fake_opener)
    # Fake series starts Apr 30 00:00, so the tide peaks at 03:00, 15:00, ...
    peak = src.sample(datetime(2022, 5, 1, 3), 37.0, -69.0)["current_u"]
    trough = src.sample(datetime(2022, 5, 1, 9), 37.0, -69.0)["current_u"]
    assert peak == pytest.approx(0.7, abs=0.001) and trough == pytest.approx(0.3, abs=0.001)
    assert CALLS[0][1] == ("utotal", "vtotal")
    with xr.open_dataset(smoc.tile_path(2022, 5, "total", tmp_path)) as ds:
        assert ds.sizes["time"] == (31 + 2) * 24  # Apr 30 .. Jun 1, hourly


def test_months_and_box_are_checked(tmp_path):
    with pytest.raises(ValueError, match="kind"):
        smoc.SmocSource("tides", tmp_path)
    src = smoc.SmocSource("model", tmp_path, box=BOX, opener=_fake_opener)
    with pytest.raises(OutsideCoverage):
        src.sample(datetime(2022, 5, 1), 45.0, -69.0)
    with pytest.raises(ValueError, match="no SMOC"):
        smoc.fetch_month(2019, 6, "model", tmp_path, BOX, opener=_fake_opener)


def test_without_login_says_so(tmp_path, monkeypatch):
    monkeypatch.setattr(smoc, "_have_login", lambda: False)
    with pytest.raises(smoc.CopernicusLoginMissing, match="login"):
        smoc.fetch_month(2022, 5, "model", tmp_path)
