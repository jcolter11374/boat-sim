import pytest

from boatsim.oceandata import storm_dates as sd

CSV = """SID,SEASON,NAME,ISO_TIME,LAT,LON,USA_WIND,USA_SSHS
 ,Year, , ,degrees_north,degrees_east,kts,1
X1,2020,PAULETTE,2020-09-13 00:00:00,30.0,-64.0,80,1
X1,2020,PAULETTE,2020-09-14 06:00:00,32.3,-64.8,90,2
X1,2020,PAULETTE,2020-09-15 00:00:00,35.0,-60.0,105,3
X2,2020,TEDDY,2020-09-21 12:00:00,31.5,-64.0,85,2
"""


def test_check_dates_peak_and_closest_pass(tmp_path):
    p = tmp_path / "ib.csv"
    p.write_text(CSV)
    df = sd.load(p)
    r = sd.check(df, "PAULETTE", 2020, ["Bermuda"])
    assert (r["first"], r["last"]) == ("2020-09-13", "2020-09-15")
    assert (r["peak_kt"], r["peak_cat"], r["peak_date"]) == (105, 3, "2020-09-15")
    b = r["passes"][0]
    assert b["date"] == "2020-09-14 06 UTC" and b["km"] < 5 and b["cat"] == 2
    assert not sd.check(df, "SANDY", 2012, ["Cape Hatteras"])["found"]
    lines = []
    rows = sd.report(df, log=lines.append)
    assert len(rows) == len(sd.CLAIMS) and any("NOT FOUND" in s for s in lines)


def test_km():
    assert sd.km(0, 0, 0, 1) == pytest.approx(111.19, abs=0.01)
