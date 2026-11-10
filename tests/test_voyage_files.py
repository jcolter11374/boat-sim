"""Gate on the committed replay files the 3D page plays (sea3d/public/voyages).

Cheap checks that need no weather data: the files are well formed, the index
lists exactly them, each carries the seed the odds batch gives its launch, and
each starts at its design's drop point (so a replay made before a route change
fails here). The full re-simulation check is `replay verify` in the
replay-check workflow; compare() is tested here on made-up replays.
"""

import json
import math
from datetime import datetime
from itertools import pairwise
from pathlib import Path

import pytest

from boatsim.config import load_design
from boatsim.mc.months import launches
from boatsim.runner.replay import COLUMNS, SCHEMA, compare, design_for, file_name

VOYAGES = Path(__file__).resolve().parents[1] / "sea3d" / "public" / "voyages"
FILES = sorted(VOYAGES.glob("voyage_*.json"))


def _km(a, b):
    dlat = math.radians(b[0] - a[0])
    dlon = math.radians(b[1] - a[1]) * math.cos(math.radians(a[0]))
    return 6371.0 * math.hypot(dlat, dlon)


def test_index_lists_exactly_the_files():
    if not VOYAGES.exists():
        pytest.skip("no committed replays")
    idx = json.loads((VOYAGES / "index.json").read_text())
    assert idx["schema"] == SCHEMA
    listed = [e["file"] for e in idx["voyages"]]
    assert sorted(listed) == [f.name for f in FILES]
    for e in idx["voyages"]:
        rep = json.loads((VOYAGES / e["file"]).read_text())
        assert e["file"] == file_name(rep)
        for k in ("boat", "start", "outcome", "days"):
            assert e[k] == rep[k], (e["file"], k)


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_replay_file_is_sound(path):
    rep = json.loads(path.read_text())
    assert rep["schema"] == SCHEMA
    h = rep["h"]
    assert h and h[0] >= 0 and all(b > a for a, b in pairwise(h))
    for name in COLUMNS:
        assert len(rep[name]) == len(h), name
    for la, lo in zip(rep["lat"], rep["lon"], strict=True):
        assert la is not None and lo is not None
        assert -90 <= la <= 90 and -180 <= lo <= 180
    # Seed as in the odds batch: year * 1000 + launch index over the year.
    start = datetime.fromisoformat(rep["start"])
    assert rep["seed"] == start.year * 1000 + launches(start.year).index(start)
    # Made with its design's drop point as it is today, and the boat starts there.
    voyage = load_design(Path(__file__).resolve().parents[1] / design_for(rep)).voyage
    drop = [voyage["drop_lat"], voyage["drop_lon"]]
    assert rep["course"]["drop"] == drop
    assert _km(drop, (rep["lat"][0], rep["lon"][0])) < 10
    # The log covers the voyage: last row within a day of the end.
    end = datetime.fromisoformat(rep["end"])
    days = (end - start).total_seconds() / 86400
    assert abs(days - rep["days"]) < 0.01
    assert days * 24 - h[-1] < 24
    for e in rep["events"]:
        assert -1 <= e["h"] <= days * 24 + 1


def _rep():
    return {
        "start": "2020-05-01T12:00",
        "end": "2020-05-02T12:00",
        "seed": 2020008,
        "outcome": "lost",
        "days": 1.0,
        "t_start_line": None,
        "t_finish_line": None,
        "course": {"drop": [36.65, -74.94]},
        "h": [0.0, 1.0],
        **{name: [1.0, 2.0] for name in COLUMNS},
        "events": [],
    }


def test_compare_agrees_and_names_differences():
    assert compare(_rep(), _rep()) == []
    fresh = _rep()
    fresh["lon"][1] = 2.0001
    fresh["outcome"] = "arrived"
    diffs = compare(_rep(), fresh)
    assert any(d.startswith("outcome") for d in diffs)
    assert any(d.startswith("lon: 1 of 2 rows differ, first at h 1.0") for d in diffs)
    short = _rep()
    short["h"] = [0.0]
    assert any("saved 2 rows, fresh 1" in d for d in compare(_rep(), short))
