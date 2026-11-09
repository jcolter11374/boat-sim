"""ERA5-vs-IBTrACS storm check, on a fake best-track file and a fake ERA5 tile."""

import io

import numpy as np
import pytest

pd = pytest.importorskip("pandas")

from boatsim.oceandata import storms as S
from boatsim.oceandata.grid import GridSeries

CSV = """SID,SEASON,NUMBER,NAME,ISO_TIME,LAT,LON,USA_WIND,USA_SSHS
 ,Year, , ,,degrees_north,degrees_east,kts,1
A,2015,1,ALPHA,2015-09-01 12:00:00,35.0,-60.0,100,3
A,2015,1,ALPHA,2015-09-01 15:00:00,35.5,-59.5,100,3
A,2015,1,ALPHA,2015-09-01 18:00:00,36.0,-59.0, ,3
B,2015,2,BRAVO,2015-09-01 12:00:00,20.0,-60.0,50,0
C,2030,3,CHARLIE,2030-09-01 12:00:00,35.0,-60.0,50,0
"""


def test_load_keeps_synoptic_points_in_box_and_years():
    df = S.load_ibtracs(io.StringIO(CSV), 2012, 2021)
    # 15Z is not synoptic, 18Z has no wind, BRAVO is south of the box, CHARLIE is too late.
    assert df.NAME.tolist() == ["ALPHA"]
    assert df.USA_WIND.iloc[0] == 100


def _tile():
    times = np.arange("2015-09-01T00", "2015-09-02T02", dtype="datetime64[h]").astype("M8[ns]")
    lats = np.arange(30.0, 40.01, 0.25)
    lons = np.arange(-65.0, -54.99, 0.25)
    shape = (len(times), len(lats), len(lons))
    u = np.full(shape, 5.0, dtype=np.float32)
    v = np.zeros(shape, dtype=np.float32)
    hs = np.full(shape, 3.0, dtype=np.float32)
    i, j = int(np.argmin(abs(lats - 35.5))), int(np.argmin(abs(lons + 60.0)))
    u[12, i, j] = 40.0  # storm peak, 55 km north of the centre
    hs[12, i, j] = 11.0
    u[12, 0, 0] = 90.0  # far away: must be ignored
    return GridSeries(
        times=times, lats=lats, lons=lons, fields={"wind_u": u, "wind_v": v, "hs": hs}
    )


def test_peak_is_taken_within_the_radius_only():
    t = np.datetime64("2015-09-01T12:00", "ns")
    peak, hs = S.era5_peak_near(_tile(), t, 35.0, -60.0)
    assert peak == pytest.approx(40.0)
    assert hs == pytest.approx(11.0)
    peak, _ = S.era5_peak_near(_tile(), np.datetime64("2015-09-01T13:00", "ns"), 35.0, -60.0)
    assert peak == pytest.approx(5.0)


def test_compare_and_summarise():
    df = S.load_ibtracs(io.StringIO(CSV), 2012, 2021)

    class FakeTiles:
        def get(self, day):
            return _tile()

    class FakeERA5:
        _tiles = FakeTiles()

    res = S.compare(df, FakeERA5())
    assert res.best_ms.iloc[0] == pytest.approx(51.44, abs=0.01)
    assert res.ratio.iloc[0] == pytest.approx(40.0 / 51.44, abs=0.001)
    rows = S.summarise(res, log=lambda *_: None)
    assert rows[0]["class"].startswith("major hurricane")
    assert rows[0]["points"] == 1


def test_encounter_finds_the_closest_hurricane(tmp_path):
    from datetime import datetime, timedelta

    p = tmp_path / "ib.csv"
    p.write_text(CSV)
    tracks = S.HurricaneTracks(p, 2012, 2021)
    t0 = datetime(2015, 9, 1, 10)
    # Hourly rows 1 degree of latitude north of ALPHA (cat 3 at 12Z, 35N 60W).
    rows = [{"t": t0 + timedelta(hours=h), "lat": 36.0, "lon": -60.0} for h in range(5)]
    e = S.encounter(rows, tracks)
    assert e["hurricane_min_km"] == pytest.approx(111.0, abs=0.5)
    assert e["hurricane_name"] == "ALPHA"
    assert e["hurricane_hours_near"] == pytest.approx(4.0)  # 09Z-15Z slot covers all rows
    far = [{"t": t0, "lat": 50.0, "lon": -20.0}]
    assert S.encounter(far, tracks)["hurricane_min_km"] > 3000
    none = [{"t": datetime(2016, 1, 1), "lat": 36.0, "lon": -60.0}]
    assert S.encounter(none, tracks)["hurricane_min_km"] == float("inf")


def test_ratio_table_by_category_and_month(tmp_path):
    rng = np.random.default_rng(0)
    n = 40
    res = pd.DataFrame(
        {
            # 30 C1 points in September, 5 in October; 5 TS points in August.
            "USA_SSHS": [1] * 35 + [0] * 5,
            "time": pd.to_datetime(["2015-09-01"] * 30 + ["2015-10-01"] * 5 + ["2015-08-01"] * 5),
            "ratio": np.r_[np.full(30, 0.6), np.full(5, 0.8), np.full(5, 0.7)]
            + rng.normal(0, 1e-6, n),
        }
    )
    t = S.ratio_table(res)
    assert list(t.columns) == S.RATIO_COLUMNS
    assert len(t) == 7 * 7  # TD, TS, C1-C5 x (all + Jun-Nov)
    row = t.set_index(["category", "month"])
    assert row.loc[("C1", "9"), "ratio_median"] == pytest.approx(0.6, abs=1e-4)
    assert row.loc[("C1", "9"), "note"] == ""
    oct_ = row.loc[("C1", "10")]  # 5 points: falls back to C1's all-month row
    assert oct_["n_points"] == 5 and "all-month" in oct_["note"]
    assert oct_["ratio_median"] == row.loc[("C1", "all"), "ratio_median"]
    assert row.loc[("C1", "all"), "n_points"] == 35
    assert "only 5 points" in row.loc[("TS", "all"), "note"]
    assert np.isnan(row.loc[("C5", "all"), "ratio_median"])
    p = tmp_path / "derived" / "ratio.csv"
    S.write_ratio_csv(t, p, 2012, 2021)
    text = p.read_text()
    assert "0.93" in text and "doi:10.1175/2009BAMS2755.1" in text and "200 km" in text
    back = pd.read_csv(p, comment="#")
    assert len(back) == 49 and back.month.astype(str).tolist()[0] == "all"
