"""ERA5-vs-NDBC check (#10) on fake buoy text and a fake ERA5 source."""

import numpy as np
import pytest

pd = pytest.importorskip("pandas")

from boatsim.oceandata import buoys as B

STDMET = """#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC   mi    ft
2023 01 01 00 50 200  8.0 10.0  2.00  9.00  6.00 210 1015.0  10.0  12.0   8.0 99.0 99.00
2023 01 01 01 50 200  8.0 10.0 99.00 99.00 99.00 999 1015.0  10.0  12.0   8.0 99.0 99.00
2023 01 01 02 50 999 99.0 99.0  3.00  9.00  6.00 210 1015.0  10.0  12.0   8.0 99.0 99.00
"""

TABLE = """# STATION_ID | OWNER | TTYPE | HULL | NAME | PAYLOAD | LOCATION | TIMEZONE | FORECAST | NOTE
44014|N|Weather Buoy|3D|VIRGINIA BEACH|SCOOP|36.603 N 74.837 W (36&#176;36'11" N 74&#176;50'13" W)| |FZNT23|
41049|N|Weather Buoy|3D|SOUTH BERMUDA|SCOOP|27.505 N 62.271 W (27&#176;30'18" N 62&#176;16'16" W)| | |
"""


def test_parse_stdmet_marks_missing_values():
    df = B.parse_stdmet(STDMET)
    assert len(df) == 3
    assert df.wvht.tolist()[0] == 2.0 and np.isnan(df.wvht[1])
    assert np.isnan(df.wspd[2]) and np.isnan(df.wdir[2])
    assert str(df.time[0]) == "2023-01-01 00:50:00"


def test_station_table_positions():
    pos = B.parse_station_table(TABLE)
    assert pos["44014"] == (36.603, -74.837)
    assert pos["41049"] == (27.505, -62.271)


def test_wind_is_raised_to_10m():
    assert B.to_10m(10.0) == pytest.approx(10.0 * (10 / 4.1) ** 0.11)
    assert 1.09 < B.to_10m(1.0) < 1.11


def test_pair_matches_nearest_hour_and_stats():
    class FakeERA5:
        def sample(self, t, lat, lon):
            return {"hs": 2.0 + t.hour * 0.1, "wind_u": 6.0, "wind_v": 8.0}

    p = B.pair(B.parse_stdmet(STDMET), FakeERA5(), 36.6, -74.8)
    assert [t.hour for t in p.index] == [1, 2, 3]  # 00:50 -> 01:00
    assert p.era5_hs.iloc[0] == pytest.approx(2.1)
    assert p.era5_ws10.iloc[0] == pytest.approx(10.0)
    s = B.stats(np.array([1.0, 2.0, 3.0] * 5), np.array([1.1, 2.2, 3.3] * 5))
    assert s["bias"] == pytest.approx(0.2)
    assert s["corr"] == pytest.approx(1.0)
    bands = B.by_height(np.array([0.5] * 10 + [5.0] * 10), np.array([0.5] * 10 + [4.0] * 10))
    assert bands[-1]["band"] == "4-6 m" and bands[-1]["ratio"] == pytest.approx(0.8)


def test_hourly_takes_waves_and_wind_from_different_reports():
    # Recent files: 10-minute wind-only reports plus an hourly report with waves.
    text = STDMET.splitlines()[:2] + [
        "2023 01 01 00 40 200  7.0 10.0 99.00 99.00 99.00 999 1015.0 10.0 12.0 8.0 99.0 99.00",
        "2023 01 01 00 50 999 99.0 99.0  2.50  9.00  6.00 210 1015.0 10.0 12.0 8.0 99.0 99.00",
        "2023 01 01 01 00 210  9.0 11.0 99.00 99.00 99.00 999 1015.0 10.0 12.0 8.0 99.0 99.00",
    ]
    h = B.hourly(B.parse_stdmet("\n".join(text)))
    assert len(h) == 1
    assert h.wvht.iloc[0] == pytest.approx(2.5)
    assert h.wspd.iloc[0] == pytest.approx(9.0) and h.wdir.iloc[0] == 210
