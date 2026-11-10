"""Voyage replays for the 3D sea page (sea3d, Phase 2).

Turns a VoyageLog into a small JSON file the browser can play back: the hourly
log as columns, the events, and the course marks (drop point, Microtransat
start and finish lines, finish target). The 3D page only draws what is in
these files, so a replay can't disagree with the simulator.

    python -m boatsim.runner.replay run 2020 --months 4 5 6 --out sea3d/public/voyages

writes one voyage_<date>.json per launch plus index.json listing them.

    python -m boatsim.runner.replay verify sea3d/public/voyages/voyage_2020-05-01.json

re-simulates one replay's launch with its seed and fails if anything differs
(Ravi's gate: a committed replay must be what the simulator does today).
Owner: Maya (Lead).
"""

from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime
from pathlib import Path

from boatsim.runner.arrival import DEFAULT_TARGET, EAST_LINE, TARGET_RADIUS_M, WEST_LINE

SCHEMA = 1
DEFAULT_BOAT = "v4 kayak"

# Column name in the replay -> (log row key, decimals). Positions to 1e-4 deg
# (about 10 m); everything else to what the page can show.
COLUMNS = {
    "lat": ("lat", 4),
    "lon": ("lon", 4),
    "heading": ("heading", 0),
    "stw": ("stw", 2),
    "soc": ("soc", 3),
    "wind_u": ("wind_u", 1),
    "wind_v": ("wind_v", 1),
    "hs": ("hs", 2),
    "tp": ("tp", 1),
    "wave_dir": ("wave_dir", 0),
    "current_u": ("current_u", 2),
    "current_v": ("current_v", 2),
    "ghi": ("ghi", 0),
}

# Per-hour yes/no columns, written as 1/0 (null when the log lacks them).
FLAGS = {
    "iridium_ok": "iridium_ok",
    "beacon_ok": "beacon_ok",
}


def _num(x, nd: int):
    if x is None:
        return None
    x = float(x)
    if not math.isfinite(x):
        return None
    r = round(x, nd)
    return int(r) if nd == 0 else r


def _iso(t: datetime | None) -> str | None:
    return t.isoformat(timespec="minutes") if t is not None else None


def to_replay(log, label: str = DEFAULT_BOAT) -> dict:
    """A VoyageLog as a JSON-ready dict (schema SCHEMA).

    Time is hours since launch. Rows the runner didn't fill (older logs without
    tp or currents) come through as null.
    """
    start = log.start
    rows = log.rows
    hours = [round((r["t"] - start).total_seconds() / 3600.0, 3) for r in rows]
    cols = {name: [_num(r.get(key), nd) for r in rows] for name, (key, nd) in COLUMNS.items()}
    for name, key in FLAGS.items():
        cols[name] = [None if r.get(key) is None else int(bool(r[key])) for r in rows]
    events = [
        {
            "h": round((e.t - start).total_seconds() / 3600.0, 3),
            "kind": getattr(e.kind, "value", str(e.kind)),
            "detail": e.detail,
        }
        for e in log.events
    ]
    drop = getattr(log, "drop", None)
    if drop is None and rows:
        drop = (rows[0]["lat"], rows[0]["lon"])
    outcome = getattr(log.outcome, "value", str(log.outcome))
    return {
        "schema": SCHEMA,
        "boat": label,
        "start": _iso(start),
        "end": _iso(log.end),
        "seed": log.seed,
        "outcome": outcome,
        "days": round(log.days, 2),
        "t_start_line": _iso(log.t_start_line),
        "t_finish_line": _iso(log.t_finish_line),
        "course": {
            "drop": list(drop) if drop else None,
            "west_line": [list(p) for p in WEST_LINE],
            "east_line": [list(p) for p in EAST_LINE],
            "target": list(DEFAULT_TARGET),
            "target_radius_m": TARGET_RADIUS_M,
        },
        "units": {
            "h": "hours since launch",
            "lat": "deg N",
            "lon": "deg E",
            "heading": "deg true",
            "stw": "m/s through the water",
            "soc": "battery state of charge, 0-1",
            "wind_u": "m/s eastward",
            "wind_v": "m/s northward",
            "hs": "m significant wave height",
            "tp": "s peak wave period",
            "wave_dir": "deg, waves come FROM",
            "current_u": "m/s eastward",
            "current_v": "m/s northward",
            "ghi": "W/m^2 sunlight",
            "iridium_ok": "1 = Iridium can report this hour (powered, main box and comms path ok)",
            "beacon_ok": "1 = Globalstar backup beacon still working",
        },
        "h": hours,
        **cols,
        "events": events,
    }


class ReplayReducer:
    """run_many reducer: keep the replay, drop the heavy log in the worker.
    A class (not a lambda) so it pickles into worker processes."""

    def __init__(self, label: str = DEFAULT_BOAT):
        self.label = label

    def __call__(self, log) -> dict:
        return to_replay(log, label=self.label)


replay_reduce = ReplayReducer()


def slug(label: str) -> str:
    """File-name-safe boat name: 'Randolph Rev B' -> 'randolph-rev-b'."""
    return re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")


def file_name(rep: dict) -> str:
    """voyage_<date>.json for our kayak (kept for existing links),
    voyage_<boat>_<date>.json for any other boat."""
    day = rep["start"][:10]
    if rep["boat"] == DEFAULT_BOAT:
        return f"voyage_{day}.json"
    return f"voyage_{slug(rep['boat'])}_{day}.json"


def index_entry(rep: dict, name: str) -> dict:
    return {
        "file": name,
        "boat": rep["boat"],
        "start": rep["start"],
        "outcome": rep["outcome"],
        "days": rep["days"],
    }


def write(reps: list[dict], out: Path) -> Path:
    """Write each replay plus index.json (merged with any existing index)."""
    out.mkdir(parents=True, exist_ok=True)
    idx_path = out / "index.json"
    entries = {}
    if idx_path.exists():
        entries = {e["file"]: e for e in json.loads(idx_path.read_text())["voyages"]}
    for rep in reps:
        name = file_name(rep)
        (out / name).write_text(json.dumps(rep, separators=(",", ":")))
        entries[name] = index_entry(rep, name)
    voyages = sorted(entries.values(), key=lambda e: e["start"])
    idx_path.write_text(json.dumps({"schema": SCHEMA, "voyages": voyages}, indent=1))
    return idx_path


# Fields a re-run must reproduce exactly (after the same rounding).
VERIFY_FIELDS = ("start", "end", "seed", "outcome", "days", "t_start_line", "t_finish_line")


def compare(saved: dict, fresh: dict, limit: int = 5) -> list[str]:
    """Differences between a committed replay and a fresh one; empty if they agree."""
    out = []
    for k in VERIFY_FIELDS:
        if saved.get(k) != fresh.get(k):
            out.append(f"{k}: saved {saved.get(k)!r}, fresh {fresh.get(k)!r}")
    if saved.get("course", {}).get("drop") != fresh.get("course", {}).get("drop"):
        out.append(
            f"drop: saved {saved['course'].get('drop')}, fresh {fresh['course'].get('drop')}"
        )
    for name in ("h", *COLUMNS):
        a, b = saved.get(name) or [], fresh.get(name) or []
        if len(a) != len(b):
            out.append(f"{name}: saved {len(a)} rows, fresh {len(b)}")
            continue
        bad = [i for i, (x, y) in enumerate(zip(a, b, strict=True)) if x != y]
        if bad:
            i = bad[0]
            out.append(
                f"{name}: {len(bad)} of {len(a)} rows differ, first at h {saved['h'][i]}: "
                f"saved {a[i]}, fresh {b[i]}"
            )
    if saved.get("events") != fresh.get("events"):
        out.append(f"events: saved {saved.get('events')}, fresh {fresh.get('events')}")
    return out[:limit] if limit else out


def design_for(rep: dict) -> str:
    """The design file a replay was made from: v4_kayak.yaml for our boat, else
    configs/<boat name, snake_case>.yaml ('Randolph Rev B' -> randolph_rev_b.yaml)."""
    if rep["boat"] == DEFAULT_BOAT:
        return "configs/v4_kayak.yaml"
    return f"configs/{slug(rep['boat']).replace('-', '_')}.yaml"


def verify(path: Path, design: str | None = None, max_days: float = 150.0) -> list[str]:
    """Re-simulate a committed replay's launch with its seed and compare."""
    from boatsim.mc.months import MonthlyVoyage

    saved = json.loads(Path(path).read_text())
    design = design or design_for(saved)
    job = MonthlyVoyage(design_path=design, max_days=max_days)
    fresh = to_replay(job(datetime.fromisoformat(saved["start"]), saved["seed"]), saved["boat"])
    # Round-trip through JSON so the fresh copy has exactly the file's types.
    return compare(saved, json.loads(json.dumps(fresh)), limit=0)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m boatsim.runner.replay")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="simulate launches of one year and write replays")
    r.add_argument("year", type=int)
    r.add_argument("--months", type=int, nargs="*", default=[4, 5, 6])
    r.add_argument("--design", default="configs/v4_kayak.yaml")
    r.add_argument("--max-days", type=float, default=150.0)
    r.add_argument("--workers", type=int, default=4)
    r.add_argument("--out", default="sea3d/public/voyages")
    r.add_argument(
        "--label",
        default=None,
        help="boat name in the replay (default: v4 kayak for our design, else the design's name)",
    )
    v = sub.add_parser("verify", help="re-simulate committed replays and fail if they differ")
    v.add_argument("files", nargs="+")
    v.add_argument("--design", default=None, help="default: from the replay's boat name")
    v.add_argument("--max-days", type=float, default=150.0)
    a = p.parse_args(argv)

    if a.cmd == "verify":
        failed = 0
        for f in a.files:
            diffs = verify(Path(f), a.design, a.max_days)
            print(f"{f}: {'matches a fresh run' if not diffs else 'DIFFERS from a fresh run'}")
            for d in diffs[:10]:
                print(f"  {d}")
            failed += bool(diffs)
        if failed:
            raise SystemExit(
                f"{failed} replay(s) no longer match the simulator; regenerate them with the "
                "Voyage replays workflow"
            )
        return

    from boatsim.config import load_design
    from boatsim.mc.months import MonthlyVoyage, launches
    from boatsim.runner.parallel import run_many

    job = MonthlyVoyage(design_path=a.design, max_days=a.max_days)
    if a.label:
        label = a.label
    elif Path(a.design).name == "v4_kayak.yaml":
        label = DEFAULT_BOAT
    else:
        label = load_design(a.design).name
    reducer = ReplayReducer(label)
    starts = [t for t in launches(a.year) if t.month in a.months]
    # Same seeds as the odds batch (year * 1000 + launch index over the year).
    all_starts = launches(a.year)
    first = all_starts.index(starts[0])
    if starts == all_starts[first : first + len(starts)]:  # one block of months: run in parallel
        reps = run_many(job, starts, seed=a.year * 1000 + first, workers=a.workers, reduce=reducer)
    else:
        reps = []
        for t in starts:
            seed = a.year * 1000 + all_starts.index(t)
            reps += run_many(job, [t], seed=seed, workers=1, reduce=reducer)
    idx = write(reps, Path(a.out))
    for rep in reps:
        print(f"{rep['start']}  {rep['outcome']:<12} {rep['days']:6.1f} d  {len(rep['h'])} rows")
    print(f"wrote {len(reps)} replays, index {idx}")


if __name__ == "__main__":
    main()
