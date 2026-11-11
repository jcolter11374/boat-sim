import json
from datetime import datetime, timedelta

from boatsim.runner.replay import (
    COLUMNS,
    SCHEMA,
    design_for,
    file_name,
    slug,
    thin,
    to_replay,
    write,
)
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
                "rain": 1.3,
                "iridium_ok": h < 2,
                "beacon_ok": True,
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
    assert rep["iridium_ok"] == [1, 1, 0]
    assert rep["beacon_ok"] == [1, 1, 1]
    assert rep["events"] == [{"h": 2.0, "kind": "part_failed", "detail": "rudder"}]
    assert rep["outcome"] == "lost"
    assert rep["course"]["drop"] == [36.65, -74.94]
    assert rep["course"]["target"] == [39.5, -13.5]


def test_missing_columns_become_null():
    log = _log()
    for r in log.rows:
        del r["tp"]
        del r["beacon_ok"]
    rep = to_replay(log)
    assert rep["tp"] == [None, None, None]
    assert rep["beacon_ok"] == [None, None, None]


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


def test_other_boats_get_their_own_file_names():
    rep = to_replay(_log(), label="Randolph Rev B")
    assert rep["boat"] == "Randolph Rev B"
    assert slug("Randolph Rev B") == "randolph-rev-b"
    assert file_name(rep) == "voyage_randolph-rev-b_2020-05-01.json"
    assert file_name(to_replay(_log())) == "voyage_2020-05-01.json"


def test_yacht_columns_only_when_the_log_has_them():
    assert "heel" not in to_replay(_log())  # kayak replays stay as they were
    log = _log()
    for i, r in enumerate(log.rows):
        r.update(heel=-12.34 * i, sail_plan=["full", "reef1", "down"][i], engine_on=i == 2)
    rep = to_replay(log, label="31 ft cruiser")
    assert rep["heel"] == [0.0, -12.3, -24.7]
    assert rep["sail_plan"] == ["full", "reef1", "down"]
    assert rep["engine"] == [0, 0, 1]
    assert "heel" in rep["units"]
    assert thin(rep, 2)["sail_plan"] == ["full", "down"]


def test_stock_boat_replays_find_their_design():
    rep = to_replay(_log(), label="31 ft cruiser")
    assert design_for(rep) == "configs/stock_cruiser31.yaml"
    assert design_for(to_replay(_log(), label="Randolph Rev B")) == "configs/randolph_rev_b.yaml"
