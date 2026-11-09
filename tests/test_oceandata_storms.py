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
