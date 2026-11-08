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


def test_unknown_survival_matches_the_hazard_model():
    from dataclasses import replace

    from boatsim.vessel.hazards import HazardParams, unknown_hazard_per_day

    p = replace(HazardParams(), unknown_p_by_60_days=0.3, unknown_shape=0.5)
    # Integrate the hazard numerically to day 60 and day 120.
    import numpy as np

    t = np.linspace(1e-6, 120, 200_001)
    h = np.array([unknown_hazard_per_day(p, x) for x in t])
    cum = np.concatenate([[0.0], np.cumsum((h[1:] + h[:-1]) / 2 * np.diff(t))])
    for day in (60, 120):
        i = int(np.searchsorted(t, day))
        assert M.unknown_survival([day], 0.3, 0.5)[0] == pytest.approx(np.exp(-cum[i]), abs=0.01)
    assert M.unknown_survival([60], 0.3, 0.5)[0] == pytest.approx(0.7)


def test_monthly_voyage_can_switch_the_unknown_hazard_off():
    job = M.MonthlyVoyage(weather="constant", max_days=1, unknown_p_by_60_days=0.0)
    row = M.summarise(job(datetime(2015, 6, 1, 12), seed=1))
    assert row["unknown_p_run"] == 0.0
    assert row["unknown_shape"] > 0


def test_sweep_weights_arrivals_by_survival():
    df = pd.DataFrame(
        {
            "month": [1, 1],
            "year": [2015, 2015],
            "outcome": ["arrived", "lost"],
            "ending": ["arrived", "lost"],
            "days": [60.0, 30.0],
            "unknown_p_run": [0.0, 0.0],
            "unknown_shape": [1.0, 1.0],
        }
    )
    assert M.swept_odds(df, 0.5) == pytest.approx(0.25)
    md = M.report_markdown(df)
    assert "Odds as a range" in md
    assert "| All | 2 | 48% | 45% | 38% | 25% | 8% |" in md


def test_run_command_passes_unknown_p_to_the_job(monkeypatch, tmp_path):
    seen = {}

    def fake_run_year(year, job, workers, months):
        seen["job"] = job
        return pd.DataFrame({"start": [], "outcome": []})

    monkeypatch.setattr(M, "run_year", fake_run_year)
    M.main(["run", "2015", "--unknown-p", "0", "--no-currents", "--out", str(tmp_path)])
    assert seen["job"].unknown_p_by_60_days == 0.0
    assert seen["job"].currents is False
