import json
from datetime import datetime, timedelta

from boatsim.runner.replay import COLUMNS, SCHEMA, to_replay, write
from boatsim.runner.simulate import VoyageLog
from boatsim.types import Event, EventKind, Outcome


def _log():
    t0 = datetime(2020, 5, 1, 12)
    log = VoyageLog(start=t0, seed=7)
    for h in range(3):
        log.rows.append(
            {
                "t": t0 + timedelta(hours=h),
                "lat": 36.65 + 0.01 * h,
                "lon": -74.94 + 0.02 * h,
                "heading": 75.4,
                "stw": 0.87,
                "soc": 0.9,
                "wind_u": 3.0,
                "wind_v": -1.0,
                "hs": 1.2,
                "tp": 7.5,
                "wave_dir": 250.0,
                "current_u": 0.4,
                "current_v": 0.1,
                "ghi": 600.0,
            }
        )
    log.events.append(Event(t0 + timedelta(hours=2), EventKind.PART_FAILED, "rudder"))
    log.outcome = Outcome.LOST
    log.end = t0 + timedelta(hours=2)
    log.drop = (36.65, -74.94)
    return log


def test_replay_keeps_the_log_exactly():
    log = _log()
    rep = to_replay(log)
    assert rep["schema"] == SCHEMA
    assert rep["h"] == [0.0, 1.0, 2.0]
    for name, (key, nd) in COLUMNS.items():
        assert len(rep[name]) == 3
        for v, row in zip(rep[name], log.rows, strict=True):
            assert abs(v - row[key]) <= 0.5 * 10**-nd + 1e-12, name
    assert rep["events"] == [{"h": 2.0, "kind": "part_failed", "detail": "rudder"}]
    assert rep["outcome"] == "lost"
    assert rep["course"]["drop"] == [36.65, -74.94]
    assert rep["course"]["target"] == [39.5, -13.5]


def test_missing_columns_become_null():
    log = _log()
    for r in log.rows:
        del r["tp"]
    assert to_replay(log)["tp"] == [None, None, None]


def test_write_merges_index(tmp_path):
    rep = to_replay(_log())
    write([rep], tmp_path)
    rep2 = dict(rep, start="2020-04-15T12:00")
    write([rep2], tmp_path)
    idx = json.loads((tmp_path / "index.json").read_text())
    assert [e["file"] for e in idx["voyages"]] == [
        "voyage_2020-04-15.json",
        "voyage_2020-05-01.json",
    ]
    back = json.loads((tmp_path / "voyage_2020-05-01.json").read_text())
    assert back["lat"][0] == 36.65
