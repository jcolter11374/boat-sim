from datetime import datetime, timedelta

import pandas as pd
import pytest

from boatsim.runner.simulate import VoyageLog
from boatsim.types import Outcome
from boatsim.viz.html import (
    MAX_TRACKS,
    main,
    report_html,
    sensitivity_figure,
    sensitivity_rows,
    track_rows,
    write_report,
)

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
        "Chance of finishing",
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


def _batch_with_sweep():
    df = _summary()
    df["end_lat"], df["end_lon"] = 38.0, -40.0
    df["solar_wh_day"], df["unknown_p_run"], df["unknown_shape"] = 500.0, 0.0, 0.5
    return df


def test_unknown_failure_sweep_turns_the_headline_into_a_range(tmp_path):
    df = _batch_with_sweep()
    page = report_html(df, banner="PRELIMINARY test")
    assert "The big unknown" in page and "fail by day 60" in page
    # Leads with the April-June window (2 of its 6 launches arrived), then all months (6 of 24).
    assert "April to June launches (the target window)" in page
    assert "The model alone says 33% (2 of 6 simulated launches" in page
    assert "All launch months together:</strong>" in page and "model alone 25% (6 of 24" in page
    assert page.index("April to June launches") < page.index("All launch months together")
    assert "PRELIMINARY test" in page
    for heading in ["Where the boats ended up", "Sun", "Lowest battery charge"]:
        assert heading in page
    assert "�" not in page  # strict UTF-8 hosts reject Plotly's raw U+FFFD


def test_map_outline_can_be_embedded(tmp_path):
    topo = tmp_path / "world_110m.json"
    topo.write_text('{"type": "Topology", "objects": {}, "note": "</script>"}')
    page = report_html(_batch_with_sweep(), topojson=topo)
    assert "window.PlotlyGeoAssets={topojson:{world_110m:" in page
    assert '"note": "<\\/script>"' in page  # can't close the script tag early
    assert "coastlines load from the internet" not in page


def test_window_can_be_switched_off():
    page = report_html(_batch_with_sweep(), window=None)
    assert "target window" not in page and "launch window" not in page
    assert "All launch months together</div>" in page
    assert "The model alone says 25%" in page


def test_sensitivity_chart_compares_each_change_with_its_own_baseline():
    main_run = pd.DataFrame(
        {
            "variant": ["baseline", "cruise_10w", "cruise_25w"],
            "label": ["The design", "Slower", "Faster"],
            "odds": [0.97, 0.88, 0.97],
            "gained": [0, 3, 3],
            "lost": [0, 12, 3],
            "sign_p": [1.0, 0.04, 1.0],
            "median_days": [79, 98, 68],
        }
    )
    thruster_run = pd.DataFrame(
        {
            "variant": ["baseline", "one_thruster"],
            "label": ["The design", "One motor"],
            "odds": [0.93, 0.75],
            "gained": [0, 4],
            "lost": [0, 22],
            "sign_p": [1.0, 0.001],
            "median_days": [78, 82],
        }
    )
    page = report_html(
        _batch_with_sweep(), sensitivity=[main_run, thruster_run], sensitivity_note="No ships."
    )
    assert "What changes the odds" in page and "No ships." in page
    text = list(sensitivity_figure(sensitivity_rows([main_run, thruster_run])).data[0].text)
    assert "-18 pts · real effect" in text  # 75% against its own 93% baseline
    assert "-9 pts · real effect · 19 days slower" in text
    assert "no change · within noise · 11 days sooner" in text
