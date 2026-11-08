"""ERA5 and GLORYS loaders, run against small fake stores laid out like the
real ones, so CI needs no network or login."""

from datetime import date, datetime

import numpy as np
import pytest

xr = pytest.importorskip("xarray")
pytest.importorskip("netCDF4")
pytest.importorskip("zarr")

from boatsim.oceandata import era5, glorys
from boatsim.oceandata.grid import Box
from boatsim.oceandata.reanalysis import ReanalysisEnvironment

BOX = Box(30.0, 40.0, -10.0, 10.0)  # crosses 0 deg longitude, like the real route box


def _fake_arco(path):
    """ARCO-ERA5 layout: lat 90..-90 descending, lon 0..359, hourly."""
    times = np.arange("2020-10-14T00", "2020-10-17T00", dtype="datetime64[h]").astype("M8[ns]")
    lat = np.arange(90.0, -90.1, -1.0)
    lon = np.arange(0.0, 360.0, 1.0)
    shape = (len(times), len(lat), len(lon))
    hours = np.arange(len(times), dtype=np.float32)[:, None, None]
    lon180 = ((lon + 180) % 360) - 180
    data = {
        "10m_u_component_of_wind": np.broadcast_to(lon180[None, None, :], shape),  # u = lon
        "10m_v_component_of_wind": np.broadcast_to(lat[None, :, None], shape),  # v = lat
        "significant_height_of_combined_wind_waves_and_swell": np.full(shape, 2.0),
        "peak_wave_period": np.full(shape, 9.0),
        "mean_wave_direction": np.full(shape, 350.0),
        "surface_solar_radiation_downwards": np.broadcast_to(hours * 3600.0, shape),
        "total_cloud_cover": np.full(shape, 0.5),
        "2m_temperature": np.full(shape, 288.15),
    }
    ds = xr.Dataset(
        {k: (("time", "latitude", "longitude"), v.astype(np.float32)) for k, v in data.items()},
        coords={"time": times, "latitude": lat, "longitude": lon},
        attrs={"valid_time_stop_era5t": "2026-11-02"},
    )
    ds.to_zarr(path, mode="w")
    return str(path)


def test_era5_fetch_crops_reorders_converts(tmp_path):
    url = _fake_arco(tmp_path / "arco.zarr")
    src = era5.ERA5Source(tmp_path / "cache", box=BOX, url=url)
    s = src.sample(datetime(2020, 10, 15, 6, 0), 35.5, -2.5)
    assert s["wind_u"] == pytest.approx(-2.5, abs=0.01)  # lon order fixed across 0 deg
    assert s["wind_v"] == pytest.approx(35.5, abs=0.01)
    assert s["air_temp"] == pytest.approx(15.0, abs=0.01)  # K -> deg C
    assert s["hs"] == pytest.approx(2.0, abs=0.001)
    assert s["wave_dir"] == pytest.approx(350.0, abs=0.05)
    # Sunlight: fake ssrd is (hour index) x 3600 J/m^2, i.e. W/m^2 = hour index,
    # sampled at t + 30 min. Hour index of 2020-10-15T06 is 30.
    assert s["ghi"] == pytest.approx(30.5, abs=0.05)
    path = era5.tile_path(date(2020, 10, 15), tmp_path / "cache")
    with xr.open_dataset(path) as ds:
        assert ds.sizes["time"] == era5.HOURS_PER_TILE
        assert ds.lat.values[0] < ds.lat.values[-1]
        assert ds.lon.values.min() == -10.0 and ds.lon.values.max() == 10.0


def test_direction_average_wraps_north():
    times = np.array(["2020-10-15T00", "2020-10-15T01"], dtype="datetime64[s]")
    from boatsim.oceandata.grid import GridSeries

    wd = np.array([350.0, 10.0], dtype=np.float32)[:, None, None] * np.ones((2, 2, 2))
    rad = np.deg2rad(wd)
    g = GridSeries(
        times,
        np.array([0.0, 1.0]),
        np.array([0.0, 1.0]),
        {"wave_dir": wd, "_wd_x": np.sin(rad), "_wd_y": np.cos(rad)},
    )
    d = era5._sample_direction(g, np.datetime64("2020-10-15T00:30"), 0.5, 0.5)
    assert min(d, 360 - d) == pytest.approx(0.0, abs=1e-3)


def _fake_glorys_opener(dataset_id, box, start, end):
    days = np.arange("1993-01-01", "2021-07-01", dtype="datetime64[D]")
    if dataset_id.endswith("myint_0.083deg_P1D-m"):
        days = np.arange("2021-07-01", "2026-09-01", dtype="datetime64[D]")
    days = days[(days >= np.datetime64(start, "D")) & (days <= np.datetime64(end, "D"))]
    if not len(days):
        raise ValueError("no data in range")
    lat = np.arange(box.lat_min, box.lat_max + 0.01, 0.5)
    lon = np.arange(box.lon_min, box.lon_max + 0.01, 0.5)
    k = (days - days[0]).astype(float)[:, None, None, None]
    u = np.broadcast_to(k * 0.1, (len(days), 1, len(lat), len(lon)))  # u grows 0.1 m/s/day
    v = np.full_like(u, -0.2)
    v[:, :, 0, 0] = np.nan  # a land point
    return xr.Dataset(
        {
            "uo": (("time", "depth", "latitude", "longitude"), u.astype(np.float32)),
            "vo": (("time", "depth", "latitude", "longitude"), v.astype(np.float32)),
        },
        coords={"time": days.astype("M8[ns]"), "depth": [0.494], "latitude": lat, "longitude": lon},
    )


def test_glorys_daily_means_centred_at_noon(tmp_path):
    src = glorys.GlorysSource(tmp_path, box=BOX, opener=_fake_glorys_opener)
    # Month file starts the day before (Sep 30) with u = 0, Oct 1 u = 0.1, ...
    noon = src.sample(datetime(2020, 10, 1, 12), 35.0, 0.0)
    assert noon["current_u"] == pytest.approx(0.1, abs=0.001)
    assert noon["current_v"] == pytest.approx(-0.2, abs=0.001)
    midnight = src.sample(datetime(2020, 10, 1, 0), 35.0, 0.0)
    assert midnight["current_u"] == pytest.approx(0.05, abs=0.001)
    # Last evening of the month interpolates into the padded next day.
    assert src.sample(datetime(2020, 10, 31, 18), 35.0, 0.0)["current_u"] == pytest.approx(
        3.125, abs=0.002
    )


def test_glorys_switches_to_interim_dataset(tmp_path):
    path = glorys.fetch_month(2021, 7, tmp_path, BOX, opener=_fake_glorys_opener)
    with xr.open_dataset(path) as ds:
        assert ds.sizes["time"] == 33  # Jun 30 (reanalysis) + Jul 1..Aug 1 (interim)


def test_glorys_without_login_says_so(tmp_path, monkeypatch):
    monkeypatch.delenv("COPERNICUSMARINE_SERVICE_USERNAME", raising=False)
    monkeypatch.setattr(glorys, "_have_login", lambda: False)
    with pytest.raises(glorys.CopernicusLoginMissing, match="register"):
        glorys.fetch_month(2020, 10, tmp_path, BOX)


def test_reanalysis_environment_fills_envstate(tmp_path):
    url = _fake_arco(tmp_path / "arco.zarr")
    env = ReanalysisEnvironment(
        era5.ERA5Source(tmp_path / "e", box=BOX, url=url),
        glorys.GlorysSource(tmp_path / "g", box=BOX, opener=_fake_glorys_opener),
    )
    s = env.sample(datetime(2020, 10, 15, 12), 30.2, -9.8)  # next to the land point
    assert s.current_v == pytest.approx(-0.2, abs=0.001)
    assert s.hs == pytest.approx(2.0, abs=0.001) and s.air_temp == pytest.approx(15.0, abs=0.01)
