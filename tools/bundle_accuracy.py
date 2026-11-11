"""How far the browser's weather bundle drifts from the full-data voyage replays (#335).

For each bundle cut (ERA5 grid in degrees, hours between weather steps) this cuts
a bundle from the cached full data, sails every committed replay's launch on it
(same design file, seed and drop as the replay), and compares the days and the
outcome with the replay. A control sails the same launches on the FULL data with
the drop moved 1e-9 degrees: the chaos floor, i.e. how much any tiny change moves
a voyage, which no bundle can beat.

    python tools/bundle_accuracy.py --year 2020 --cuts 1.0:6 1.0:3 0.5:6 --out runs/bundle-accuracy

Needs the season's ERA5 and GLORYS caches (as the Sandbox data workflow fetches).
"""

from __future__ import annotations

import argparse
import json
import os
import statistics as st
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

VOYAGES = Path("sea3d/public/voyages")


def replays() -> list[dict]:
    out = []
    for f in sorted(VOYAGES.glob("voyage_*.json")):
        r = json.loads(f.read_text())
        r["_file"] = f.name
        out.append(r)
    return out


def sail_on_bundle(
    env, design_path: str, start: datetime, seed: int, max_days: float
) -> tuple[str, float]:
    """The browser's way (sandbox/run.py run_voyage), for any design file."""
    from boatsim.config import load_design
    from boatsim.oceandata.grid import OutsideCoverage
    from boatsim.runner.land import default_land
    from boatsim.runner.parallel import summarize
    from boatsim.runner.simulate import default_mission, simulate, standard_components

    design = load_design(design_path)
    drop = (design.voyage["drop_lat"], design.voyage["drop_lon"])
    c = standard_components(design, env, env, seed=seed, land=default_land())
    try:
        log = simulate(c, start, *drop, default_mission(drop), seed=seed, max_days=max_days)
    except OutsideCoverage:
        return "left_data_box", float("nan")
    s = summarize(log)
    return s["outcome"], float(s["days"])


def sail_full_nudged(
    design_path: str, start: datetime, seed: int, max_days: float
) -> tuple[str, float]:
    """The replays' way (runner.replay verify: MonthlyVoyage on the full data), drop moved 1e-9 deg."""
    from boatsim.mc.months import MonthlyVoyage
    from boatsim.runner.replay import to_replay

    @dataclass(frozen=True)
    class Nudged(MonthlyVoyage):
        def drop_point(self):
            lat, lon = super().drop_point()
            return lat + 1e-9, lon

    r = to_replay(Nudged(design_path=design_path, max_days=max_days)(start, seed), "x")
    return r["outcome"], float(r["days"])


def score(rows: list[dict]) -> dict:
    both = [
        abs(r["days"] - r["ref_days"])
        for r in rows
        if r["outcome"] == r["ref_outcome"] == "arrived"
    ]
    return {
        "voyages": len(rows),
        "same_outcome": sum(r["outcome"] == r["ref_outcome"] for r in rows),
        "both_arrived": len(both),
        "median_abs_days": round(st.median(both), 2) if both else None,
        "p90_abs_days": round(sorted(both)[int(0.9 * (len(both) - 1))], 1) if both else None,
        "worst_abs_days": round(max(both), 1) if both else None,
    }


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--year", type=int, default=2020)
    p.add_argument(
        "--cuts", nargs="+", default=["1.0:6", "1.0:3", "0.5:6"], help="ERA5 degrees:hours"
    )
    p.add_argument("--max-days", type=float, default=150.0)
    p.add_argument(
        "--control", action="store_true", help="also the full-data 1e-9 deg nudge control"
    )
    p.add_argument("--out", default="runs/bundle-accuracy")
    a = p.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    from boatsim.runner.replay import design_for
    from boatsim.sandbox import forcing
    from boatsim.sandbox.run import open_bundle

    reps = [r for r in replays() if r["start"].startswith(str(a.year))]
    table: list[dict] = []
    rows_all: dict[str, list[dict]] = {}

    def run(label: str, sail) -> tuple[list[dict], float]:
        rows = []
        t0 = time.time()
        for r in reps:
            outcome, days = sail(design_for(r), datetime.fromisoformat(r["start"]), r["seed"])
            rows.append(
                {
                    "file": r["_file"],
                    "boat": r["boat"],
                    "outcome": outcome,
                    "days": days,
                    "ref_outcome": r["outcome"],
                    "ref_days": r["days"],
                }
            )
            print(
                f"{label} {r['_file']}: {outcome} {days:.2f} (replay {r['outcome']} {r['days']:.2f})",
                flush=True,
            )
        rows_all[label] = rows
        return rows, time.time() - t0

    for cut in a.cuts:
        res, step = cut.split(":")
        forcing.ERA5_RES, forcing.ERA5_STEP_H = float(res), int(step)
        path = out / f"forcing_{a.year}_{res}deg_{step}h.npz"
        forcing.cut(a.year, path)
        mb = os.path.getsize(path) / 1e6
        weather_mb = sum(i.compress_size for i in zipfile.ZipFile(path).infolist()) / 1e6
        env = open_bundle(path)
        rows, secs = run(
            f"bundle {res}deg/{step}h",
            lambda d, s, seed, env=env: sail_on_bundle(env, d, s, seed, a.max_days),
        )
        boats = {}
        for b in sorted({r["boat"] for r in rows}):
            boats[b] = score([r for r in rows if r["boat"] == b])
        table.append(
            {
                "cut": f"{res} deg, every {step} h",
                "download_mb": round(mb, 1),
                "zip_mb": round(weather_mb, 1),
                "secs": round(secs),
                **score(rows),
                "per_boat": boats,
            }
        )
        path.unlink()  # keep the runner's disk free; the size is recorded

    if a.control:
        rows, secs = run(
            "full data, drop +1e-9 deg", lambda d, s, seed: sail_full_nudged(d, s, seed, a.max_days)
        )
        table.append(
            {
                "cut": "full data, drop moved 1e-9 deg (chaos floor)",
                "download_mb": None,
                "zip_mb": None,
                "secs": round(secs),
                **score(rows),
                "per_boat": {
                    b: score([r for r in rows if r["boat"] == b])
                    for b in sorted({r["boat"] for r in rows})
                },
            }
        )

    (out / "bundle_accuracy.json").write_text(
        json.dumps({"table": table, "rows": rows_all}, indent=1)
    )
    md = [
        "| Weather in the bundle | Download | Same outcome | Both arrived | Median days off | 90% within | Worst |",
        "|---|---|---|---|---|---|---|",
    ]
    for t in table:
        dl = f"{t['download_mb']} MB" if t["download_mb"] else "n/a"
        md.append(
            f"| {t['cut']} | {dl} | {t['same_outcome']}/{t['voyages']} | {t['both_arrived']} | "
            f"{t['median_abs_days']} | {t['p90_abs_days']} | {t['worst_abs_days']} |"
        )
    md += ["", "Per boat (median days off, worst):", ""]
    for t in table:
        md.append(
            f"- {t['cut']}: "
            + "; ".join(
                f"{b} {s['median_abs_days']} / {s['worst_abs_days']} ({s['same_outcome']}/{s['voyages']} same)"
                for b, s in t["per_boat"].items()
            )
        )
    text = "\n".join(md)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write("## Bundle accuracy (#335)\n\n" + text + "\n")


if __name__ == "__main__":
    main()
