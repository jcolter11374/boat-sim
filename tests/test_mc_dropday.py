"""Drop-day study (#163): offline tests on made-up weather."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pandas as pd
import pytest

from boatsim.config import load_design
from boatsim.mc import deadboat as DB
from boatsim.mc import dropday as D
from boatsim.mc.drifters import drift, kayak_for_drift
from boatsim.oceandata import ConstantEnvironment
from boatsim.types import EnvState


def test_every_day_from_15_april_to_30_june():
    ds = D.drop_days(2023)
    assert (
        len(ds) == 77 and ds[0] == datetime(2023, 4, 15, 12) and ds[-1] == datetime(2023, 6, 30, 12)
    )


def test_points_are_todays_drop_and_the_randolph_point():
    assert D.POINTS["100km"] == pytest.approx((36.65, -74.94), abs=0.01)  # #128
    assert D.POINTS["randolph100"] == (38.02, -74.01)


def test_randolph_2023_result_is_8_of_16_ashore_7_to_28_may():
    assert len(D.RANDOLPH_2023) == 16 and sum(D.RANDOLPH_2023.values()) == 8
    assert not D.RANDOLPH_2023[date(2023, 5, 4)] and D.RANDOLPH_2023[date(2023, 5, 7)]
    assert D.RANDOLPH_2023[date(2023, 5, 28)] and not D.RANDOLPH_2023[date(2023, 5, 31)]
    assert max(D.RANDOLPH_2023) == date(2023, 6, 15)


def test_windage_scales_downwind_drift():
    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(EnvState(wind_u=10.0, hs=1.0, tp=6.0, wave_dir=270.0, ghi=0.0))
    t0 = datetime(2023, 5, 1)
    speeds = []
    for f in (0.6, 1.0, 1.7):
        tr = drift(
            env, t0, 36.65, -74.94, 0.5, "kayak", vessel=kayak_for_drift(DB.with_windage(design, f))
        )
        speeds.append(tr["lon"].iloc[-1] - tr["lon"].iloc[0])
        assert abs(tr["lat"].iloc[-1] - 36.65) < 1e-3  # straight downwind
    assert speeds[0] < speeds[1] < speeds[2]
    assert DB.with_windage(design, 1.0) is design


def test_area_names():
    assert D.area(35.9, -75.6) == "Outer Banks (NC)"
    assert D.area(36.8, -75.95) == "Virginia Beach / Eastern Shore"
    assert D.area(38.3, -75.1) == "Delmarva (MD/DE)"
    assert D.area(34.5, -76.5) == "south of Cape Hatteras"


def _days(flags, start=datetime(2023, 4, 28, 12)):
    return pd.DataFrame(
        {"start": [start + timedelta(days=i) for i in range(len(flags))], "aground": flags}
    )


def test_runs_and_strip():
    g = _days([True, True, True, True, False, True, True, False])
    assert D.runs_of_bad_days(g) == [(date(2023, 4, 28), date(2023, 5, 1), 4)]
    assert D.strip(g) == "XXX|X.XX."


def test_report_on_made_up_rows():
    rows = []
    for t in D.drop_days(2023):
        for name in ("100km", "randolph100"):
            for w in (0.6, 1.0):
                bad = t.month == 5 and t.day >= 7
                r = {
                    "start": t,
                    "year": 2023,
                    "point": name,
                    "windage": w,
                    "aground": bad,
                    "aground_day": 9.0 if bad else float("nan"),
                    "aground_lat": 35.8 if bad else float("nan"),
                    "aground_lon": -75.6 if bad else float("nan"),
                    "area": "Outer Banks (NC)" if bad else "",
                }
                if w == 1.0:
                    r.update(
                        fc_min_land_km7=20.0 if bad else 90.0,
                        fc_aground7=False,
                        fc_wind_onshore5=3.0 if bad else -1.0,
                        tr_min_land_km7=10.0 if bad else 100.0,
                    )
                rows.append(r)
    md = D.report_markdown(pd.DataFrame(rows))
    assert "| 07 May | ashore | ashore day 9, Outer Banks (NC) |" in md
    assert "07 May-31 May (25 days)" in md
    # A rule that is right every time avoids all groundings and allows none.
    line = next(x for x in md.splitlines() if "within 25 km of land" in x and "perfect" not in x)
    assert "| 25/25 (100%) |" in line and line.endswith("| 0/52 (0%) |")
