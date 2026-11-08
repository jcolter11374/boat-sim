from datetime import datetime, timedelta

import pandas as pd
import pytest

from boatsim.runner.simulate import VoyageLog
from boatsim.types import Outcome
from boatsim.viz.html import MAX_TRACKS, main, report_html, track_rows, write_report

pytest.importorskip("plotly")

T0 = datetime(2021, 5, 1)


def _log(outcome, days=3, seed=0, start=T0):
    log = VoyageLog(start=start, seed=seed, outcome=outcome)
    for h in range(days * 24 + 1):
        log.rows.append(
            {"t": start + timedelta(hours=h), "lat": 36.85, "lon": -75.7 + 0.03 * h, "soc": 0.8}
        )
    return log


def _summary():
    rows = []
    for i in range(24):
        outcome = ["arrived", "lost", "timeout", "left_data_box"][i % 4]
        cause = {"arrived": "arrived", "lost": "ship_strike", "timeout": "battery_empty"}.get(
            outcome, "off_course_timeout"
        )
        rows.append(
            {
                "start": datetime(2015, 1 + i % 12, 1),
                "outcome": outcome,
                "cause": cause,
                "days": 50.0 + i,
                "min_soc": 0.2,
                "airtime_usd": 60.0,
            }
        )
    return pd.DataFrame(rows)


def test_track_rows_thins_to_every_six_hours_and_keeps_the_end():
    t = track_rows(_log(Outcome.ARRIVED, days=3))
    assert len(t["day"]) == 13  # 0, 6, ..., 72 hours
    assert t["day"][-1] == 3.0 and t["outcome"] == "arrived"
    assert all(isinstance(x, float) for x in t["lat"] + t["soc"])


def test_report_has_every_section_and_plain_words():
    tracks = [track_rows(_log(o, seed=i)) for i, o in enumerate(Outcome)]
    page = report_html(_summary(), tracks, subtitle="test")
    for heading in [
        "Chance of reaching Europe",
        "Odds by launch month",
        "How the voyages ended",
        "Where the boats went",
        "Battery",
        "Report card",
        "Every voyage",
    ]:
        assert heading in page
    assert "95% range" in page and "story, not a forecast" in page
    assert "blown out of the area we have weather data for" in page  # left_data_box note
    assert page.count("plotly.js v") == 1  # Plotly embedded once


def test_report_without_tracks_or_causes_still_works():
    df = pd.DataFrame([{"start": T0, "outcome": "arrived", "days": 55.0}])
    page = report_html(df)
    assert "Where the boats went" not in page and "How the voyages ended" not in page
    assert "Odds by launch month" in page


def test_tracks_are_capped(tmp_path):
    tracks = [track_rows(_log(Outcome.ARRIVED, days=1, seed=i)) for i in range(MAX_TRACKS + 50)]
    out = write_report(tmp_path / "r.html", _summary(), tracks)
    assert out.exists() and out.stat().st_size < 10_000_000


def test_command_line_reads_batch_csvs(tmp_path, capsys):
    df = _summary()
    df.iloc[:12].to_csv(tmp_path / "voyages_2015.csv", index=False)
    df.iloc[12:].to_csv(tmp_path / "voyages_2016.csv", index=False)
    out = tmp_path / "report.html"
    main(
        [str(tmp_path / "voyages_2015.csv"), str(tmp_path / "voyages_2016.csv"), "--out", str(out)]
    )
    assert "24 voyages" in capsys.readouterr().out
    assert "Odds by launch month" in out.read_text()
