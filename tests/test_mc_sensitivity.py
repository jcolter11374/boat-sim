"""Sensitivity study (#21): offline tests on constant made-up weather."""

from __future__ import annotations

import math
from datetime import datetime

import pandas as pd
import pytest

from boatsim.basestation import ForecastReplanPolicy, HoldCoursePolicy
from boatsim.mc import sensitivity as S


def _components(name):
    return S.SensitivityVoyage(
        variant=name, weather="constant", unknown_p_by_60_days=0.0
    ).components(1)


def test_window_launches_cover_april_to_june_only():
    ts = S.window_launches(2020, 10)
    assert ts[0] == datetime(2020, 4, 1, 12)
    assert {t.month for t in ts} == {4, 5, 6}
    assert len(ts) == 10  # Apr 1, 11, 21, May 1, 11, 21, 31, Jun 10, 20, 30


def test_variants_change_what_they_say_and_nothing_else():
    base = _components("baseline")
    assert isinstance(base.base, ForecastReplanPolicy) and base.base.min_gain_h < 100

    batt = _components("battery_640")
    assert batt.vessel.inner.battery.capacity_wh == 640
    assert batt.vessel.inner.hazards.unknown_p_by_60_days == 0.0  # override survives

    assert _components("solar_350").vessel.inner.solar.rated_wp == 350
    assert _components("cruise_25w").autopilot.cruise_fraction == pytest.approx(0.25)
    assert _components("hold_at_30").autopilot.hold_below_soc == 0.30
    assert _components("no_throttle_back").autopilot.throttle_scale(0.2) == 1.0
    assert base.autopilot.throttle_scale(0.2) < 1.0

    one = _components("one_thruster")
    assert one.vessel.inner.thruster_parts == ("thruster_centre",)
    assert one.autopilot.thruster_count == 1
    assert one.autopilot.cruise_fraction == pytest.approx(15 / 50)
    assert _components("battery_640").autopilot.thruster_count == 2

    assert base.link.mailbox == "with_report"
    assert _components("mailbox_scheduled").link.mailbox == "scheduled"

    assert math.isinf(_components("no_corrections").base.min_gain_h)
    assert isinstance(_components("silent_base").base, HoldCoursePolicy)


def test_every_variant_builds_and_has_a_plain_label():
    for name, v in S.VARIANTS.items():
        _components(name)
        assert v.label and v.group


def test_run_year_pairs_variants_on_the_same_seeds():
    df = S.run_year(
        2020,
        ("baseline", "cruise_25w"),
        every_days=45,
        workers=1,
        weather="constant",
        max_days=3,
        unknown_p_by_60_days=0.0,
    )
    a, b = (df[df["variant"] == n].reset_index() for n in ("baseline", "cruise_25w"))
    assert list(a["seed"]) == list(b["seed"]) == [2020000, 2020001, 2020002]
    assert list(a["start"]) == list(b["start"])
    assert (b["km_from_drop"] > a["km_from_drop"]).all()  # more power, further in 3 days


def test_sign_test():
    assert S.sign_test(0, 0) == 1.0
    assert S.sign_test(3, 3) == 1.0
    assert S.sign_test(6, 0) == pytest.approx(2 / 64)


def _row(variant, seed, outcome, days=60.0):
    return {
        "variant": variant,
        "start": datetime(2020, 4, 1, 12),
        "seed": seed,
        "outcome": outcome,
        "days": days,
        "year": 2020,
        "month": 4,
        "ending": outcome,
        "airtime_usd": 80.0,
        "min_soc": 0.5,
        "unknown_p_run": 0.0,
        "unknown_shape": 0.5,
    }


def test_compare_counts_flips_against_the_baseline():
    rows = [_row("baseline", s, "arrived" if s < 8 else "timeout") for s in range(10)]
    rows += [_row("solar_350", s, "arrived" if s >= 2 else "timeout") for s in range(10)]
    t = S.compare(pd.DataFrame(rows)).set_index("variant")
    assert t.loc["solar_350", "gained"] == 2 and t.loc["solar_350", "lost"] == 2
    assert t.loc["solar_350", "arrived"] == 8
    md = S.report_markdown(pd.DataFrame(rows))
    assert "| Bigger panels (350 W) | 8/10 | 8 |" in md
    header, sep = [ln for ln in md.splitlines() if ln.startswith("|")][:2]
    assert header.count("|") == sep.count("|")


def test_cli_run_and_report(tmp_path):
    S.main(
        [
            "run",
            "2020",
            "--constant",
            "--every-days",
            "60",
            "--max-days",
            "2",
            "--workers",
            "1",
            "--variants",
            "silent_base",
            "--out",
            str(tmp_path),
        ]
    )
    df = pd.read_csv(tmp_path / "sensitivity_2020.csv")
    assert set(df["variant"]) == {"baseline", "silent_base"}  # baseline always added
    assert (df["unknown_p_run"] == 0.0).all()
    S.main(["report", str(tmp_path / "sensitivity_2020.csv"), "--out", str(tmp_path)])
    assert "Base sends nothing" in (tmp_path / "sensitivity_report.md").read_text()


def test_rows_record_whether_ship_traffic_was_on():
    df = S.run_year(
        2020,
        ("baseline",),
        every_days=90,
        workers=1,
        weather="constant",
        max_days=1,
        unknown_p_by_60_days=0.0,
    )
    assert not df["ships"].any()  # constant weather has no ship map


def test_finish_variants_set_route_target_and_rule():
    from boatsim.runner.arrival import FinishTarget

    north = S.SensitivityVoyage(variant="target_51n", weather="constant")
    c = north.components(1)
    assert isinstance(c.finish, FinishTarget) and (c.finish.lat, c.finish.lon) == (51.0, -16.0)
    assert [(w.lat, w.lon) for w in north.mission().waypoints] == [S.BAY_MOUTH, (51.0, -16.0)]
    assert c.base.route[-1].lat == 51.0  # base plans toward the same target
    old = S.SensitivityVoyage(variant="old_rule", weather="constant").components(1)
    assert old.finish.reached(38.5, -27.0)  # Azores counted under the old rule
    assert not old.finish.reached(39.5, -13.5)  # the new target is open ocean
    base = S.SensitivityVoyage(weather="constant")
    assert base.mission().waypoints[1].lat == 36.0  # default route, south of the Azores


def test_every_target_is_on_the_eastern_line():
    for name, v in S.VARIANTS.items():
        if isinstance(v.finish, tuple):
            S.SensitivityVoyage(variant=name, weather="constant").components(1)  # validates
