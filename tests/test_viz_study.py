"""Results page from the sensitivity study (viz/study.py)."""

from datetime import datetime

import pandas as pd
import pytest

pytest.importorskip("plotly")

from boatsim.mc.sensitivity import compare
from boatsim.viz import study


def _voyages():
    rows = []
    starts = [datetime(2015, m, d, 12) for m in (4, 5, 6) for d in (1, 11, 21)]
    finish = {"baseline": 6, "no_shakedown": 4, "old_rule": 9, "target_51n": 2,
              "target_39_5n": 5, "cruise_30w": 7}  # fmt: skip
    for name, k in finish.items():
        for i, s in enumerate(starts):
            ok = i < k
            rows.append(
                {
                    "variant": name,
                    "start": s,
                    "seed": 2015000 + i,
                    "outcome": "arrived" if ok else "aground",
                    "days": 90.0 if ok else 40.0,
                    "ending": "arrived" if ok else "ran aground before the finish",
                    "min_soc": 0.5,
                    "airtime_usd": 30.0,
                }
            )
    return pd.DataFrame(rows)


def test_hero_labels_the_shakedown_and_shows_both():
    t = compare(_voyages())
    h = study.hero_html(t)
    assert "with the planned 14-day shakedown" in h
    assert "with no shakedown" in h
    assert "67%" in h and "44%" in h  # 6/9 and 4/9
    assert "once failures we can" in h


def test_rule_and_target_figures():
    t = compare(_voyages())
    rule = study.rule_figure(t)
    assert "retired" in rule.data[0].y[0]
    assert list(rule.data[0].x) == pytest.approx([100.0, 600 / 9])
    tf = study.target_figure(t)
    assert tf.data[0].y[0].startswith("51N 16W")
    assert tf.data[0].y[-1] == "The design as it stands"


def test_page_retires_old_figure_and_keeps_other_changes_apart():
    v = _voyages()
    page = study.study_html(compare(v), v, retired="The old 93% is retired.")
    assert "The old 93% is retired." in page
    assert "Where to aim on the finish line" in page
    assert "What else changes the odds" in page
    assert "Faster cruise" in page
    assert "Odds by launch month" in page
    assert "�" not in page


def test_missing_variants_leave_sections_out():
    v = _voyages()
    t = compare(v[v["variant"].isin(["baseline", "cruise_30w"])])
    assert study.rule_figure(t) is None
    assert study.target_figure(t) is None
    page = study.study_html(t)
    assert "with no shakedown" not in page


def test_headline_can_lead_with_another_row():
    t = compare(_voyages())
    h = study.hero_html(
        t, headline="target_39_5n", headline_tag="straight route", baseline_name="old dog-leg"
    )
    assert "56%" in h  # 5/9 for the straight route leads
    assert "with the planned 14-day shakedown; straight route" in h
    assert "with no shakedown (old dog-leg, which made 67% with one)" in h
    tf = study.target_figure(t, headline="target_39_5n", baseline_label="Old plan")
    colours = list(tf.data[0].marker.color)
    assert colours[list(tf.data[0].y).index("Old plan")] != colours[1]
    assert sum(c == study.BAR for c in colours) == 1


def test_shakedown_link():
    t = compare(_voyages())
    assert "How the shakedown works" not in study.hero_html(t)
    h = study.hero_html(t, shakedown_link="https://example.org/shakedown-trial.md")
    assert '<a href="https://example.org/shakedown-trial.md">How the shakedown works</a>' in h
