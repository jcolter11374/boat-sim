"""Ship-density map: binning, calibration, building and sampling, on fake grids
(the real sources are only reachable from GitHub Actions)."""

import warnings
from datetime import datetime

import numpy as np
import pytest

xr = pytest.importorskip("xarray")
pytest.importorskip("netCDF4")

from boatsim.oceandata import traffic as T
from boatsim.oceandata.grid import Box
from boatsim.oceandata.reanalysis import ReanalysisEnvironment

BOX = Box(30.0, 31.0, -10.0, -9.0)


def test_grid_axes_are_cell_centres():
    lats, lons = T.grid_axes(BOX, 0.5)
    assert lats.tolist() == [30.25, 30.75]
    assert lons.tolist() == [-9.75, -9.25]


def test_bin_sums_and_counts_ignoring_nan():
    lat = np.array([30.1, 30.2, 30.3, 30.9, 29.0])  # last one is outside the box
    lon = np.array([-9.9, -9.9, -9.9, -9.1, -9.9])
    v = np.array([1.0, 3.0, np.nan, 5.0, 100.0])
    total, n_valid, n_all = T._bin(lat, lon, v, BOX, 0.5, (2, 2))
    assert total[0, 0] == 4.0 and n_valid[0, 0] == 2 and n_all[0, 0] == 3
    assert total[1, 1] == 5.0 and n_all[1, 1] == 1
    assert total.sum() == 9.0  # the outside point is dropped


def test_emodnet_hours_per_month_is_ships_per_km2():
    # One ship always present in a km^2 = 730.5 ship-hours per km^2 per month.
    assert 730.5 / T.HOURS_PER_MONTH == 1.0


def test_calibrate_recovers_the_factor():
    rng = np.random.default_rng(0)
    wb = rng.uniform(1, 1000, (20, 20))
    emod = 2e-5 * wb
    frac = np.ones_like(wb)
    frac[:5] = 0.2  # poorly covered cells are left out
    emod[:5] = 1.0
    lats, lons = np.linspace(36, 40, 20), np.linspace(-12, -6, 20)
    k, ratio = T.calibrate(emod, frac, wb, lats, lons, log=lambda *_: None)
    assert k == pytest.approx(2e-5)
    assert np.isnan(ratio[:5]).all()


def _fake_build(monkeypatch, tmp_path):
    lats, lons = T.grid_axes(BOX, T.RES)
    shape = (len(lats), len(lons))
    wb = np.full(shape, 1.5)
    junk = np.full(shape, 0.01)
    junk[:, 5:] = 0.5  # the eastern half is busy: half its World Bank pixels corrupt
    wb[0, 0] = junk[0, 0] = np.nan  # land in both
    emod = np.full(shape, np.nan)
    frac = np.zeros(shape)
    frac[5:, :] = 1.0  # EMODnet covers the northern half
    emod[5:, :5] = 1e-5
    emod[5:, 5:] = 1e-3
    monkeypatch.setattr(T, "grid_axes", lambda *a, **k: (lats, lons))
    monkeypatch.setattr(T, "emodnet_grid", lambda **k: (emod, frac))
    monkeypatch.setattr(T, "world_bank_grid", lambda tif, **k: (wb, junk))
    out = T.build(tmp_path / "ships.nc", "unused.tif", log=lambda *_: None)
    return out, lats, lons


def test_build_prefers_emodnet_and_fills_from_the_fitted_table(monkeypatch, tmp_path):
    out, _, _ = _fake_build(monkeypatch, tmp_path)
    with xr.open_dataset(out) as ds:
        d, src = ds.ship_density.values, ds.source.values
    assert src[9, 9] == 1 and d[9, 9] == pytest.approx(1e-3)
    # South half has no EMODnet: filled from the table by corrupt share.
    assert src[2, 2] == 2 and d[2, 2] == pytest.approx(1e-5)
    assert src[2, 7] == 2 and d[2, 7] == pytest.approx(1e-3)
    assert src[0, 0] == 0 and d[0, 0] == 0.0


def test_lookup_falls_back_to_corrupt_share_only():
    junk = np.array([[0.01, 0.5, 0.5]])
    wb = np.array([[1.5, 1.5, np.nan]])  # last cell: every pixel corrupt
    emod = np.where(junk > 0.1, 1e-3, 1e-5) * np.ones((25, 1))
    jj, ww = junk * np.ones((25, 1)), wb * np.ones((25, 1))
    table, by_junk = T.fit_lookup(emod, np.ones_like(emod), ww, jj)
    est = T.apply_lookup(table, by_junk, wb, junk)
    assert est[0].tolist() == pytest.approx([1e-5, 1e-3, 1e-3])


def test_source_samples_and_feeds_the_environment(monkeypatch, tmp_path):
    out, _, _ = _fake_build(monkeypatch, tmp_path)
    ships = T.ShipDensitySource(out)
    assert ships.sample(30.95, -9.05) == pytest.approx(1e-3)
    assert ships.sample(70.0, 0.0) == pytest.approx(1e-3)  # clamped to the map edge

    class FakeERA5:
        def sample(self, t, lat, lon):
            return dict.fromkeys(
                ("wind_u", "wind_v", "hs", "tp", "wave_dir", "ghi", "cloud_fraction", "air_temp"),
                1.0,
            )

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        env = ReanalysisEnvironment(era5=FakeERA5(), ships=ships)
        s = env.sample(datetime(2020, 10, 1), 30.95, -9.05)
        assert s.ship_density == pytest.approx(1e-3)
        assert (
            ReanalysisEnvironment(era5=FakeERA5())
            .sample(datetime(2020, 10, 1), 30.95, -9.05)
            .ship_density
            == 0.0
        )


def test_default_source_warns_when_missing(tmp_path):
    with pytest.warns(UserWarning, match="no ship traffic"):
        assert T.default_source(tmp_path / "nope.nc") is None


def test_default_source_fails_when_required(tmp_path, monkeypatch):
    monkeypatch.setenv("BOATSIM_REQUIRE_SHIPS", "1")
    with pytest.raises(FileNotFoundError, match="REQUIRE_SHIPS"):
        T.default_source(tmp_path / "nope.nc")
