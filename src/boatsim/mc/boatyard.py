"""Boatyard grid (3D roadmap item 2): every build the yard page offers, simulated
ahead of time, because the browser can't run the simulator.

The page looks a build up by its id and gets two things:

* **Finish odds** from an odds batch: April to June launches every 10 days over
  ten years of real weather (ERA5) and currents (GLORYS12), the same paired seeds
  for every build (as mc.sensitivity), with the "unknown failure" guess off and
  swept back in afterwards.
* **Replays** of the six 1st/15th April to June launches of one year, with the
  same seeds as the voyage replays (runner.replay), thinned to one row every few
  hours so the whole grid stays small enough for git and the Pages build.

Builds of the v4 kayak (ids like ``k-m2-p25-e2-b2``):

* motors: 1 or 2 thrusters (one motor: 50 W burst, as sensitivity's one_thruster)
* cruise power: 10, 15, 20, 25 or 30 W
* energy: battery and panels together, small / current / large
* electronics boxes: 1 or 2. With one box, losing it stops the autopilot and
  the Iridium radio; the Globalstar beacon keeps reporting while the boat drifts.

Plus two builds of our model of the Randolph Rev B (display only, not their
numbers): as published, and a stronger wing spar (GUESS: a tenth of their
published wing damage per knockdown, standing in for the 30-32 mm spar they are
moving to, until they publish a re-tuned value).

    python -m boatsim.mc.boatyard odds 2015 --out runs/boatyard
    python -m boatsim.mc.boatyard replays 2020 --out runs/boatyard/replays
    python -m boatsim.mc.boatyard build --odds runs/boatyard/odds_*.csv \\
        --replays runs/boatyard/replays --out sea3d/public/boatyard

Owner: Theo (Physics). File format for the page: docs/boatyard.md.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from boatsim.mc.sensitivity import SensitivityVoyage, Variant, window_launches

SCHEMA = 1
KAYAK = "configs/v4_kayak.yaml"
REV_B = "configs/randolph_rev_b.yaml"
STRIDE_H = 6  # hours between replay rows (the voyage replays are hourly)

MOTORS = (1, 2)
CRUISE_W = (10, 15, 20, 25, 30)
# Battery and panels move together: one "how much energy" knob for the yard.
# Small and large are the sensitivity study's battery_640/solar_150 and
# battery_1920/solar_350 rows, taken together.
ENERGY = {
    "s": {"label": "small", "battery_wh": 640, "solar_wp": 150},
    "m": {"label": "current", "battery_wh": 1280, "solar_wp": 250},
    "l": {"label": "large", "battery_wh": 1920, "solar_wp": 350},
}
BOXES = (1, 2)
CURRENT = {"motors": 2, "cruise_w": 25, "energy": "m", "boxes": 2}  # the design as it stands


@dataclass(frozen=True)
class Build:
    id: str
    boat: str  # name shown on the page, and which model to draw
    design_path: str
    label: str  # plain words for John
    variant: Variant
    options: dict


def kayak_id(motors: int, cruise_w: int, energy: str, boxes: int) -> str:
    return f"k-m{motors}-p{cruise_w}-e{energy}-b{boxes}"


def _kayak(motors: int, cruise_w: int, energy: str, boxes: int) -> Build:
    e = ENERGY[energy]
    changes = [
        ("propulsion", "thruster_count", motors),
        ("propulsion", "max_drive_w", 100 if motors == 2 else 50),
        ("propulsion", "cruise_drive_w", cruise_w),
        ("power", "battery_wh", e["battery_wh"]),
        ("power", "solar_wp", e["solar_wp"]),
        ("hazards", "electronics_boxes", boxes),
    ]
    label = (
        f"{motors} motor{'s' if motors > 1 else ''}, {cruise_w} W cruise, "
        f"{e['label']} battery and panels ({e['battery_wh']} Wh, {e['solar_wp']} W), "
        f"{boxes} electronics box{'es' if boxes > 1 else ''}"
    )
    opts = {"motors": motors, "cruise_w": cruise_w, "energy": e["label"], "boxes": boxes}
    bid = kayak_id(motors, cruise_w, energy, boxes)
    return Build(bid, "v4 kayak", KAYAK, label, Variant("boatyard", label, tuple(changes)), opts)


def _rev_b_parts(wing_factor: float) -> dict:
    """Rev B's knockdown part-damage table with the wing's entry scaled."""
    from boatsim.config import load_design

    parts = dict(load_design(REV_B).hazards["p_part"])
    parts["sail"] = round(parts["sail"] * wing_factor, 9)
    return parts


def _builds() -> dict[str, Build]:
    out = {}
    for m in MOTORS:
        for p in CRUISE_W:
            for e in ENERGY:
                for b in BOXES:
                    k = _kayak(m, p, e, b)
                    out[k.id] = k
    out["revb"] = Build(
        "revb",
        "Randolph Rev B",
        REV_B,
        "Randolph Rev B as published (our model)",
        Variant("boatyard", "Rev B as published"),
        {"wing": "published"},
    )
    out["revb-spar"] = Build(
        "revb-spar",
        "Randolph Rev B",
        REV_B,
        "Randolph Rev B with a stronger wing spar (our GUESS: a tenth of the wing damage)",
        Variant("boatyard", "Rev B, stronger spar", (("hazards", "p_part", _rev_b_parts(0.1)),)),
        {"wing": "stronger spar"},
    )
    return out


BUILDS = _builds()


@dataclass(frozen=True)
class BoatyardVoyage(SensitivityVoyage):
    """A MonthlyVoyage of one yard build (looked up in BUILDS, not VARIANTS)."""

    def spec(self) -> Variant:
        return BUILDS[self.variant].variant


def job_for(bid: str, **kw) -> BoatyardVoyage:
    return BoatyardVoyage(design_path=BUILDS[bid].design_path, variant=bid, **kw)


def pick(ids: list[str] | None, shard: str | None) -> list[str]:
    """Build ids to run: the given ones (default all), then shard 'i/n' of them."""
    ids = list(ids or BUILDS)
    for b in ids:
        if b not in BUILDS:
            raise SystemExit(f"unknown build {b!r}")
    if shard:
        i, n = (int(x) for x in shard.split("/"))
        ids = ids[i - 1 :: n]
    return ids


# --- Odds batch --------------------------------------------------------------


def _odds_task(args):
    from boatsim.runner.parallel import _call

    bid, task = args
    row = _call(task)
    row["build"] = bid
    return row


def run_odds(year: int, ids, every_days: int = 10, workers: int = 4, **kw):
    """Every build over the same April to June launches and seeds as the
    sensitivity study (seed = year * 1000 + i), unknown failure off."""
    import pandas as pd

    from boatsim.mc.months import summarise

    starts = window_launches(year, every_days)
    tasks = []
    for bid in ids:
        job = job_for(bid, unknown_p_by_60_days=0.0, **kw)
        tasks += [(bid, (job, summarise, s, year * 1000 + i)) for i, s in enumerate(starts)]
    if workers == 1:
        rows = [_odds_task(t) for t in tasks]
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            rows = list(pool.map(_odds_task, tasks, chunksize=4))
    return pd.DataFrame(rows)


def odds_table(df) -> dict[str, dict]:
    """Per build: finish odds with a 95% range, finishes by day 150, median days,
    odds with a 10% unknown-failure chance put back, and how voyages ended."""
    from boatsim.mc.months import swept_odds, wilson

    out = {}
    for bid, g in df.groupby("build"):
        ok = g["outcome"] == "arrived"
        k = int(ok.sum())
        p, lo, hi = wilson(k, len(g))
        med = g.loc[ok, "days"].median() if k else math.nan
        out[bid] = {
            "voyages": len(g),
            "finished": k,
            "odds": _r(p, 3),
            "low95": _r(lo, 3),
            "high95": _r(hi, 3),
            "within_150": int((ok & (g["days"] <= 150.0)).sum()),
            "median_days": _r(med, 1),
            "odds_unknown_10": _r(swept_odds(g, 0.10), 3),
            "endings": {str(e): int(n) for e, n in g["ending"].value_counts().items()},
        }
    return out


def _r(x, nd):
    x = float(x)
    return None if not math.isfinite(x) else round(x, nd)


# --- Replays -----------------------------------------------------------------


# Columns left out of yard replays: sunlight sampled every few hours aliases day
# and night, and the page doesn't draw currents. Positions to 1e-3 deg (~100 m).
DROP_COLUMNS = ("current_u", "current_v", "ghi")
QUIET_EVENTS = ("message_sent", "message_received", "mission_updated")  # not shown as notes


def thin(rep: dict, stride_h: float = STRIDE_H) -> dict:
    """A voyage replay made small for the yard: one row every stride_h hours (and
    the last row), no sunlight or current columns, positions to 1e-3 deg, the
    routine satellite-traffic events left out (every notable event stays), and
    the units moved to the index."""
    from boatsim.runner.replay import COLUMNS, FLAGS

    h = rep["h"]
    keep, nxt = [], 0.0
    for i, t in enumerate(h):
        if t + 1e-6 >= nxt:
            keep.append(i)
            nxt = t + stride_h
    if h and keep[-1] != len(h) - 1:
        keep.append(len(h) - 1)
    out = {k: v for k, v in rep.items() if k not in DROP_COLUMNS and k != "units"}
    for col in ("h", *COLUMNS, *FLAGS):
        if col in out:
            out[col] = [rep[col][i] for i in keep]
    for col in ("lat", "lon"):
        out[col] = [None if x is None else round(x, 3) for x in out[col]]
    out["events"] = [e for e in rep["events"] if e["kind"] not in QUIET_EVENTS]
    out["stride_h"] = stride_h
    return out


class _ReplayReduce:
    def __init__(self, bid: str):
        self.bid = bid

    def __call__(self, log) -> dict:
        from boatsim.runner.replay import to_replay

        rep = thin(to_replay(log, label=BUILDS[self.bid].boat))
        rep["build"] = self.bid
        return rep


def _replay_task(args):
    from boatsim.runner.parallel import _call

    return _call(args)


def run_replays(year: int, ids, months=(4, 5, 6), workers: int = 4, **kw) -> list[dict]:
    """The 1st and 15th launches of the months, seeds as runner.replay."""
    from boatsim.mc.months import launches

    every = launches(year)
    starts = [t for t in every if t.month in months]
    tasks = []
    for bid in ids:
        job = job_for(bid, **kw)
        tasks += [(job, _ReplayReduce(bid), s, year * 1000 + every.index(s)) for s in starts]
    if workers == 1:
        return [_replay_task(t) for t in tasks]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(_replay_task, tasks))


def replay_file(bid: str, start: str) -> str:
    return f"{bid}/{start[:10]}.json"


def write_replays(reps: list[dict], out: Path) -> None:
    for rep in reps:
        p = out / replay_file(rep["build"], rep["start"])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(rep, separators=(",", ":")))


# --- Index for the page --------------------------------------------------------


def build_index(odds: dict[str, dict], replay_dir: Path, meta: dict) -> dict:
    builds = []
    for bid, b in BUILDS.items():
        reps = []
        for f in sorted((replay_dir / bid).glob("*.json")) if (replay_dir / bid).exists() else []:
            r = json.loads(f.read_text())
            reps.append(
                {
                    "file": replay_file(bid, r["start"]),
                    "start": r["start"],
                    "outcome": r["outcome"],
                    "days": r["days"],
                }
            )
        builds.append(
            {
                "id": bid,
                "boat": b.boat,
                "label": b.label,
                "options": b.options,
                "current": b.options == {**CURRENT, "energy": ENERGY[CURRENT["energy"]]["label"]},
                "odds": odds.get(bid),
                "replays": reps,
            }
        )
    return {
        "schema": SCHEMA,
        "options": {
            "motors": list(MOTORS),
            "cruise_w": list(CRUISE_W),
            "energy": [{"id": k, **v} for k, v in ENERGY.items()],
            "boxes": list(BOXES),
            "id_pattern": "k-m{motors}-p{cruise_w}-e{energy id}-b{boxes}",
            "rev_b": ["revb", "revb-spar"],
        },
        "stride_h": STRIDE_H,
        "units": _units(),
        **meta,
        "builds": builds,
    }


def _units() -> dict:
    """Column units, as in the voyage replays, less the columns the yard drops."""
    from types import SimpleNamespace

    from boatsim.runner.replay import to_replay

    log = SimpleNamespace(
        start=None, rows=[], events=[], end=None, seed=0, outcome="", days=0.0,
        t_start_line=None, t_finish_line=None,
    )  # fmt: skip
    units = to_replay(log)["units"]
    return {k: v for k, v in units.items() if k not in DROP_COLUMNS}


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m boatsim.mc.boatyard")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("odds", "replays"):
        r = sub.add_parser(name)
        r.add_argument("year", type=int)
        r.add_argument("--builds", nargs="*", default=None)
        r.add_argument("--shard", default=None, help="i/n: run every n-th build from the i-th")
        r.add_argument("--workers", type=int, default=os.cpu_count() or 4)
        r.add_argument("--max-days", type=float, default=150.0)
        r.add_argument("--out", required=True)
        r.add_argument("--no-currents", action="store_true", help="try-out only: zero current")
    sub.choices["odds"].add_argument("--every-days", type=int, default=10)
    sub.choices["replays"].add_argument("--months", type=int, nargs="*", default=[4, 5, 6])
    b = sub.add_parser("build", help="combine odds CSVs and replays into the page's index")
    b.add_argument("--odds", nargs="*", default=[])
    b.add_argument("--replays", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--commit", default=None)
    a = p.parse_args(argv)

    if a.cmd == "odds":
        ids = pick(a.builds, a.shard)
        df = run_odds(
            a.year, ids, a.every_days, a.workers,
            max_days=a.max_days, currents=not a.no_currents,
        )  # fmt: skip
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        tag = f"_{a.shard.replace('/', 'of')}" if a.shard else ""
        df.to_csv(out / f"odds_{a.year}{tag}.csv", index=False)
        print(df.groupby("build")["outcome"].apply(lambda s: (s == "arrived").mean()).to_string())
    elif a.cmd == "replays":
        ids = pick(a.builds, a.shard)
        reps = run_replays(
            a.year, ids, tuple(a.months), a.workers,
            max_days=a.max_days, currents=not a.no_currents,
        )  # fmt: skip
        write_replays(reps, Path(a.out))
        for r in reps:
            print(f"{r['build']:<16} {r['start']}  {r['outcome']:<12} {r['days']:6.1f} d")
    else:
        import pandas as pd

        out = Path(a.out)
        replay_dir = Path(a.replays)
        odds, meta = {}, {}
        if a.odds:
            df = pd.concat([pd.read_csv(x) for x in a.odds], ignore_index=True)
            odds = odds_table(df)
            meta["odds_source"] = {
                "years": [int(df["year"].min()), int(df["year"].max())],
                "months": sorted(int(m) for m in df["month"].unique()),
                "voyages_per_build": int(df.groupby("build").size().max()),
                "note": (
                    "April to June launches every 10 days, real weather and currents, same "
                    "seeds for every build; unknown failure off (odds_unknown_10 puts a 10% "
                    "chance by day 60 back in). Microtransat finish on our target."
                ),
            }
        if a.commit:
            meta["commit"] = a.commit
        if replay_dir.resolve() != out.resolve():
            import shutil

            for bid in BUILDS:
                if (replay_dir / bid).exists():
                    shutil.copytree(replay_dir / bid, out / bid, dirs_exist_ok=True)
        out.mkdir(parents=True, exist_ok=True)
        idx = build_index(odds, out, meta)
        (out / "index.json").write_text(json.dumps(idx, indent=1))
        size = sum(f.stat().st_size for f in out.rglob("*.json"))
        print(f"{len(idx['builds'])} builds, {size / 1e6:.1f} MB in {out}")


if __name__ == "__main__":
    main()
