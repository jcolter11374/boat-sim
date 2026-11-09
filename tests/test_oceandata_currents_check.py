"""GLORYS-vs-SMOC comparison (#73) on fake fields; the real one runs in Actions."""

from datetime import date

import numpy as np
import pytest

xr = pytest.importorskip("xarray")
pd = pytest.importorskip("pandas")

from boatsim.oceandata import currents_check as C


def test_block_mean_averages_into_quarter_degrees():
    lats = np.array([36.05, 36.15, 36.30])
    lons = np.array([-74.95, -74.80])
    a = np.array([[1.0, 3.0], [5.0, np.nan], [10.0, 10.0]])
    out, clats, clons = C.block_mean(a, lats, lons)
    assert clats[0] == 36.125 and clons[0] == -74.875
    assert out[0, 0] == pytest.approx(3.0)  # (1 + 3 + 5) / 3, NaN skipped
    assert out[1, 0] == pytest.approx(10.0)
    assert np.isnan(out[5, 5])


def test_compare_reports_speed_and_direction_differences():
    lons = np.array([-72.0, -52.0])
    u1 = np.array([[1.0, 0.5]])
    v1 = np.zeros((1, 2))
    u2 = np.array([[0.0, 0.5]])
    v2 = np.array([[1.0, 0.0]])  # west cell: same speed, 90 degrees apart
    rows = {r["band"]: r for r in C.compare(u1, v1, u2, v2, lons)}
    w = rows["75W-70W"]
    assert w["speed_glorys"] == pytest.approx(1.0) and w["speed_smoc"] == pytest.approx(1.0)
    assert w["dir_diff_median_deg"] == pytest.approx(90.0)
    assert w["rms_vector_diff"] == pytest.approx(np.sqrt(2))
    assert rows["55W-50W"]["rms_vector_diff"] == pytest.approx(0.0)
    assert rows["all"]["cells"] == 2


def _fake_opener(dataset_id, variables, start, end, box=C.STRETCH):
    lat = np.arange(36.0, 42.0, 1 / 12)
    lon = np.arange(-75.0, -50.0, 1 / 12)
    n = 24 if dataset_id == C.SMOC_DATASET else 1
    times = pd.date_range(start, periods=n, freq="h")
    shape = (n, 1, len(lat), len(lon))
    data = {}
    for v in variables:
        base = 1.0 if v.startswith("u") else 0.0
        if v in ("utotal",):
            base = 1.1  # Stokes drift adds 0.1 m/s eastward
        data[v] = (("time", "depth", "latitude", "longitude"), np.full(shape, base))
    return xr.Dataset(
        data, coords={"time": times, "depth": [0.5], "latitude": lat, "longitude": lon}
    )


def test_run_compares_model_and_total(capsys):
    rows = C.run(dates=[date(2023, 5, 15)], opener=_fake_opener, log=lambda *_: None)
    by = {(r["kind"], r["band"]): r for r in rows}
    assert by[("model", "all")]["rms_vector_diff"] == pytest.approx(0.0)
    assert by[("total", "all")]["rms_vector_diff"] == pytest.approx(0.1)
    assert by[("total", "all")]["east_smoc"] == pytest.approx(1.1)
    C.summarise(rows, log=print)
    assert "GLORYS vs SMOC total" in capsys.readouterr().out
