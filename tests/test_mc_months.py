"""Odds by launch month (#20): offline tests with constant weather."""

from __future__ import annotations

from datetime import datetime

import pandas as pd
import pytest

from boatsim.mc import months as M


def test_launches_cover_every_month_twice():
    t = M.launches(2015)
    assert len(t) == 24
    assert {x.month for x in t} == set(range(1, 13))
    assert all(x.day in (1, 15) for x in t)


def test_wilson_interval():
    p, lo, hi = M.wilson(8, 10)
    assert p == pytest.approx(0.8)
    assert 0.44 < lo < 0.5 and 0.94 < hi < 0.97
    assert M.wilson(0, 0)[0] != M.wilson(0, 0)[0]  # nan with no voyages


def test_monthly_voyage_meters_energy_and_summarises():
    job = M.MonthlyVoyage(weather="constant", max_days=3)
    log = job(datetime(2015, 6, 1, 12), seed=1)
    assert log.meter["hours"] == pytest.approx(72.0)
    # Constant weather: cruise power the whole way, flat 250 W/m^2 sun.
    assert log.meter["drive_wh"] / log.meter["hours"] == pytest.approx(15.0, rel=0.01)
    row = M.summarise(log)
    assert row["month"] == 6 and row["year"] == 2015
    assert row["outcome"] == "timeout" and row["ending"] == "still at sea"
    assert "airtime_usd" in row and "km_to_go" in row
    assert row["sun_kwh_m2_day"] == pytest.approx(6.0, rel=0.01)
    assert row["drive_w_avg"] == pytest.approx(15.0, rel=0.01)
    assert row["km_from_drop"] > 100


def test_leaving_the_weather_box_ends_cleanly(monkeypatch):
    from boatsim.oceandata.grid import OutsideCoverage

    def boom(*a, **k):
        raise OutsideCoverage("left the box")

    monkeypatch.setattr("boatsim.runner.simulate", boom)
    log = M.MonthlyVoyage(weather="constant")(datetime(2015, 1, 1, 12), seed=1)
    row = M.summarise(log)
    assert row["outcome"] == "left_data_box"
    assert row["ending"] == "left the weather box"
    assert row["cause"] == "left_data_box"


def test_run_year_and_report():
    job = M.MonthlyVoyage(weather="constant", max_days=2)
    df = M.run_year(2015, job, workers=1, only_months=[1, 7])
    assert list(df["month"]) == [1, 1, 7, 7]
    assert df["seed"].tolist() == [2015000, 2015001, 2015002, 2015003]
    md = M.report_markdown(df)
    assert "| Jan | 2 | 0 |" in md and "| Feb | 0 | | no launches" in md
    t = M.by_month(df)
    assert len(t) == 12 and t.loc[0, "voyages"] == 2


def test_report_counts_causes():
    df = pd.DataFrame(
        {
            "month": [1, 1, 2],
            "year": [2015] * 3,
            "outcome": ["arrived", "lost", "timeout"],
            "ending": ["arrived", "stuck inverted or keel lost", "still at sea"],
            "days": [60.0, 30.0, 150.0],
        }
    )
    md = M.report_markdown(df)
    assert "| stuck inverted or keel lost | 1 |" in md
    assert "arrived 33%" in md
