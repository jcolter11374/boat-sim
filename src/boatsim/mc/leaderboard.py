"""Design leaderboard: fairness checks and paired ranking (roadmap item 5, #197).

Behind a flag: nothing here is shown anywhere yet. The CLI refuses to run
unless BOATSIM_LEADERBOARD=1, so the board can't go live by accident before
John picks it from the roadmap.

A board is a list of entries, one per design, each with its voyages on one
launch set:

    {"board": {"launch_set": "2020-AJ-v1", "holdout_set": "2021-AJ-v1"},
     "entries": [
       {"design": "k-p25", "design_sha256": "...", "badges": ["breaks 2.4 m cap"],
        "run": {"job": "42868553501/130013370715", "commit": "903c638",
                "numpy": "2.3.1", "cpu": "AMD EPYC 7763"},
        "launches": [{"start": "2020-04-01T12:00", "seed": 2020006,
                      "outcome": "arrived", "days": 71.4}, ...],
        "holdout": {"launches": [...]}}]}

The fairness rules (Ravi, agreed by Maya 11 Nov 2026):

1. Same sea, same dice: every entry sails the same launches with the same seeds.
2. Enough launches: at least MIN_LAUNCHES; one voyage is a coin toss.
3. Rank on the paired difference; say "too close to call" when it could be luck.
4. One headline metric fixed in advance: Microtransat finish rate ("arrived").
5. Frozen yardstick: one sim commit (and launch set) per board.
6. No tuning to the test: a hidden holdout set flags designs that drop there.
7. Same rules for every boat; exceptions are shown as badges (e.g. a Randolph
   design is "our model" of their boat; our kayak breaks the 2.4 m cap), and
   one class of boat per board: stock vessels (the 31 ft cruiser) never rank
   against the small autonomous boats.
8. Reproducible: design file hash and sim commit stored; and (#197) every
   entry scored in ONE job, because runner CPUs differ in the last bit and a
   long voyage is chaotic, so cross-job gaps can be machine noise.

Owner: Ravi (QA).
"""

from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path

from boatsim.mc.stats import sign_test, wilson

FLAG = "BOATSIM_LEADERBOARD"
MIN_LAUNCHES = 60
HEADLINE = "arrived"  # rule 4: the one metric, fixed before any results
Z95 = 1.96


def enabled() -> bool:
    return os.environ.get(FLAG) == "1"


def _key(launch: dict) -> tuple[str, int]:
    return launch["start"], int(launch["seed"])


def _finished(launch: dict) -> bool:
    return launch["outcome"] == HEADLINE


# --- Fairness checks ----------------------------------------------------------


def check_board(board: dict, min_launches: int = MIN_LAUNCHES) -> list[str]:
    """Every way the board breaks the rules, in plain words. Empty = fair."""
    out: list[str] = []
    entries = board.get("entries", [])
    if not entries:
        return ["the board has no entries"]
    names = [e.get("design", "?") for e in entries]
    if len(set(names)) != len(names):
        out.append("a design appears more than once (rule 8: one entry per design)")
    # Rule 1: identical launch set and seeds.
    ref = [_key(x) for x in entries[0].get("launches", [])]
    if len(set(ref)) != len(ref):
        out.append(f"{names[0]}: a launch appears twice")
    for e in entries[1:]:
        keys = [_key(x) for x in e.get("launches", [])]
        if sorted(keys) != sorted(ref):
            missing = len(set(ref) - set(keys))
            extra = len(set(keys) - set(ref))
            out.append(
                f"{e.get('design')}: not the same launches and seeds as {names[0]} "
                f"({missing} missing, {extra} extra) (rule 1)"
            )
    # Rule 2: enough launches.
    if len(ref) < min_launches:
        out.append(f"only {len(ref)} launches; a board needs at least {min_launches} (rule 2)")
    # Rules 5 and 8 (+ #197): one commit, one job, provenance recorded.
    for field_, rule in (("commit", "rule 5"), ("job", "#197: one job, one machine")):
        vals = {(e.get("run") or {}).get(field_) for e in entries}
        if None in vals or "" in vals:
            out.append(f"an entry has no run {field_} recorded (rule 8)")
        elif len(vals) > 1:
            out.append(f"entries come from {len(vals)} different run {field_}s ({rule})")
    for field_ in ("numpy", "cpu"):
        if any(not (e.get("run") or {}).get(field_) for e in entries):
            out.append(f"an entry has no {field_} recorded (#197)")
    for e in entries:
        if not e.get("design_sha256"):
            out.append(f"{e.get('design')}: no design file hash (rule 8)")
        for x in e.get("launches", []):
            if "outcome" not in x:
                out.append(f"{e.get('design')}: a launch has no outcome")
                break
    # Rule 7: one class of boat per board. A stock vessel (a 31 ft yacht) is
    # not ranked against the small drones; it gets its own board.
    classes = {e.get("class", DRONE_CLASS) for e in entries}
    if len(classes) > 1:
        out.append(
            f"the board mixes boat classes ({', '.join(sorted(classes))}); "
            "rank each class on its own board (rule 7)"
        )
    # Rule 6: a holdout set must be declared and every entry scored on it.
    if not (board.get("board") or {}).get("holdout_set"):
        out.append("no holdout set declared (rule 6)")
    elif any(not (e.get("holdout") or {}).get("launches") for e in entries):
        out.append("an entry has no holdout results (rule 6)")
    return out


# --- Paired comparison -------------------------------------------------------


@dataclass(frozen=True)
class Pair:
    a: str
    b: str
    n: int
    a_only: int  # launches A finished and B didn't
    b_only: int
    gap: float  # finish rate A minus B
    lo: float  # 95% interval on the gap (paired)
    hi: float
    p: float  # two-sided exact sign test on the flipped launches

    @property
    def clear(self) -> bool:
        """True when the interval on the gap excludes zero: not just luck."""
        return self.lo > 0 or self.hi < 0

    def words(self) -> str:
        if not self.clear:
            return (
                f"{self.a} vs {self.b}: too close to call, could be luck "
                f"({self.a} finished {self.a_only} launches {self.b} didn't, and the reverse "
                f"{self.b_only}; gap {self.gap:+.0%}, 95% {self.lo:+.0%} to {self.hi:+.0%})"
            )
        win, lose = (self.a, self.b) if self.gap > 0 else (self.b, self.a)
        return (
            f"{win} beats {lose}: {max(self.a_only, self.b_only)} launches to "
            f"{min(self.a_only, self.b_only)} (gap {abs(self.gap):.0%}, 95% "
            f"{min(abs(self.lo), abs(self.hi)):.0%} to {max(abs(self.lo), abs(self.hi)):.0%}, "
            f"sign test p = {self.p:.2g})"
        )


def paired(a: dict, b: dict) -> Pair:
    """Launch-by-launch comparison of two entries on the same launches (rule 3).

    The interval is the standard one for the difference of two matched
    proportions (Wald, McNemar layout), widened by a continuity term of 1/n; with
    no flipped launches it is exactly zero-width at zero, i.e. "no evidence".
    """
    fa = {_key(x): _finished(x) for x in a["launches"]}
    fb = {_key(x): _finished(x) for x in b["launches"]}
    keys = sorted(set(fa) & set(fb))
    n = len(keys)
    a_only = sum(fa[k] and not fb[k] for k in keys)
    b_only = sum(fb[k] and not fa[k] for k in keys)
    if n == 0:
        return Pair(a["design"], b["design"], 0, 0, 0, math.nan, math.nan, math.nan, 1.0)
    gap = (a_only - b_only) / n
    var = ((a_only + b_only) - (a_only - b_only) ** 2 / n) / n**2
    half = Z95 * math.sqrt(max(var, 0.0)) + (1.0 / n if a_only + b_only else 0.0)
    return Pair(
        a["design"],
        b["design"],
        n,
        a_only,
        b_only,
        gap,
        gap - half,
        gap + half,
        sign_test(a_only, b_only),
    )


def finish_rate(e: dict, launches_key: str = "launches") -> tuple[float, float, float]:
    xs = e[launches_key] if launches_key == "launches" else e[launches_key]["launches"]
    return wilson(sum(_finished(x) for x in xs), len(xs))


def rank(board: dict) -> list[dict]:
    """Rows in finish-rate order, grouped into tiers: a design joins the tier
    above unless it is clearly worse than EVERY design in that tier (rule 3).
    Designs in one tier are drawn as tied."""
    entries = sorted(
        board["entries"],
        key=lambda e: (-finish_rate(e)[0], e["design"]),
    )
    rows, tier, tier_members = [], 0, []
    for e in entries:
        if tier_members and all(paired(m, e).clear for m in tier_members):
            tier, tier_members = tier + 1, []
        tier_members.append(e)
        rate, lo, hi = finish_rate(e)
        rows.append(
            {
                "tier": tier + 1,
                "design": e["design"],
                "finish_rate": rate,
                "ci95": [lo, hi],
                "launches": len(e["launches"]),
                "badges": e.get("badges", []),
            }
        )
    return rows


def holdout_flags(board: dict) -> list[str]:
    """Rule 6: a design whose finish rate on the hidden holdout is clearly below
    its public rate (the two Wilson intervals don't overlap) looks tuned to the test."""
    out = []
    for e in board["entries"]:
        if not (e.get("holdout") or {}).get("launches"):
            continue
        pub, plo, _ = finish_rate(e)
        hold, _, hhi = finish_rate(e, "holdout")
        if hhi < plo:
            out.append(
                f"{e['design']}: {pub:.0%} on the public launches but {hold:.0%} on the "
                "holdout; it may be tuned to the test"
            )
    return out


def report(board: dict) -> str:
    lines = ["# Design leaderboard (fairness-checked, not published)", ""]
    problems = check_board(board)
    if problems:
        lines += ["**Not fair to rank yet:**", ""] + [f"- {p}" for p in problems] + [""]
    rows = rank(board)
    lines += [
        "| Tier | Design | Finish rate | 95% | Launches | Badges |",
        "|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['tier']} | {r['design']} | {r['finish_rate']:.0%} | "
            f"{r['ci95'][0]:.0%}-{r['ci95'][1]:.0%} | {r['launches']} | "
            f"{', '.join(r['badges'])} |"
        )
    lines += ["", "Designs in the same tier are too close to call.", ""]
    by = {e["design"]: e for e in board["entries"]}
    for a, b in combinations([r["design"] for r in rows], 2):
        lines.append(f"- {paired(by[a], by[b]).words()}")
    flags = holdout_flags(board)
    if flags:
        lines += ["", "Holdout check:", ""] + [f"- {f}" for f in flags]
    return "\n".join(lines) + "\n"


# --- Building a board (data side; the leaderboard workflow) -------------------

KAYAK_BADGE = "3.05 m hull: breaks the race's 2.4 m cap"

# The first board's entries: the plan build, its nearest rivals, and both
# Randolph boats as we model them. One job must score every entry (#197), and a
# free runner gets 6 hours, so the list stays short (about 0.3 min per voyage
# with 4 workers on the Boatyard grid runs; 8 builds x 78 launches ~ 3.5 h).
DEFAULT_ENTRIES = [
    "k-p25",
    "k-p20",
    "k-p30",
    "k-p25-brain.one-box",
    "k-p25-drive.hybrid",
    "k-p25-sol.solar-300-bat.two-100ah",
    "revc",
    "revb",
]


def launch_set_id(years, every_days: int) -> str:
    """Name of a launch set: which years, how often (seeds follow from it)."""
    ys = sorted(years)
    return f"{ys[0]}-{ys[-1]}-AprJun-every{every_days}d-v1"


def provenance() -> dict:
    """Where and with what this was run: the #197 fields."""
    import platform

    import numpy as np

    cpu = platform.processor() or ""
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    job = os.environ.get("GITHUB_RUN_ID", "local")
    job += "/" + os.environ.get("GITHUB_JOB", "") + "/" + os.environ.get("GITHUB_RUN_ATTEMPT", "")
    commit = os.environ.get("GITHUB_SHA") or _git_commit()
    return {"job": job, "commit": commit, "numpy": np.__version__, "cpu": cpu or "unknown"}


def _git_commit() -> str:
    import subprocess

    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def design_hash(build) -> str:
    """sha256 of the design file plus the build's changes to it (rule 8)."""
    import hashlib

    h = hashlib.sha256(Path(build.design_path).read_bytes())
    h.update(repr(build.variant.design).encode())
    return h.hexdigest()


DRONE_CLASS = "small autonomous boat"
STOCK_CLASS = "stock vessel"


def boat_class(design_path: str) -> str:
    """Which board a design belongs on: a stock vessel (its yaml has a `stock:`
    block, e.g. the 31 ft cruiser) or a small autonomous boat (kayak, Rev B/C)."""
    from boatsim.config import load_design

    return STOCK_CLASS if load_design(design_path).stock else DRONE_CLASS


def badges(build) -> list[str]:
    if build.boat == "v4 kayak":
        return [KAYAK_BADGE]
    return [f"our model of {build.boat}"]


def score_year(year: int, ids, every_days: int, workers: int):
    """Every build over one year's launches, in this process (rule 8, #197)."""
    from boatsim.mc.boatyard import run_odds

    df = run_odds(year, ids, every_days=every_days, workers=workers)
    return df[["build", "start", "seed", "outcome", "days"]]


def assemble(public, holdout, every_days: int, public_years, holdout_years) -> dict:
    """One board from per-launch rows (DataFrames with build, start, seed, outcome, days)."""
    from boatsim.mc.boatyard import BUILDS

    run = provenance()

    def rows(df, bid):
        g = df[df["build"] == bid].sort_values("start")
        return [
            {
                "start": str(r.start)[:16].replace(" ", "T"),
                "seed": int(r.seed),
                "outcome": r.outcome,
                "days": float(r.days),
            }
            for r in g.itertuples()
        ]

    entries = []
    for bid in sorted(set(public["build"])):
        b = BUILDS[bid]
        e = {
            "design": bid,
            "label": b.label,
            "design_sha256": design_hash(b),
            "class": boat_class(b.design_path),
            "badges": badges(b),
            "run": run,
            "launches": rows(public, bid),
        }
        if holdout is not None:
            e["holdout"] = {"launches": rows(holdout, bid)}
        entries.append(e)
    return {
        "board": {
            "launch_set": launch_set_id(public_years, every_days),
            "holdout_set": launch_set_id(holdout_years, every_days) if holdout_years else None,
            "headline": HEADLINE,
            "min_launches": MIN_LAUNCHES,
        },
        "entries": entries,
    }


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m boatsim.mc.leaderboard")
    sub = p.add_subparsers(dest="cmd")
    r = sub.add_parser("report", help="check and rank a board JSON")
    r.add_argument("board", help="board JSON (see module doc)")
    r.add_argument("--strict", action="store_true", help="exit 1 if any fairness rule fails")
    y = sub.add_parser("score-year", help="run every build over one year's launches (one job)")
    y.add_argument("year", type=int)
    y.add_argument("--every-days", type=int, default=7)
    y.add_argument("--builds", nargs="*", default=None)
    y.add_argument("--workers", type=int, default=4)
    y.add_argument("--out", required=True)
    b = sub.add_parser("assemble", help="build the board JSON from score-year CSVs")
    b.add_argument("--public", nargs="+", required=True)
    b.add_argument("--holdout", nargs="*", default=[])
    b.add_argument("--every-days", type=int, default=7)
    b.add_argument("--out", required=True)
    b.add_argument("--strict", action="store_true", help="exit 1 if any fairness rule fails")
    argv = list(argv) if argv is not None else None
    # Old form: `python -m boatsim.mc.leaderboard board.json [--strict]`.
    import sys

    raw = argv if argv is not None else sys.argv[1:]
    if raw and raw[0] not in ("report", "score-year", "assemble", "-h", "--help"):
        raw = ["report", *raw]
    a = p.parse_args(raw)
    if not enabled():
        raise SystemExit(f"the leaderboard is behind a flag: set {FLAG}=1 to run it")
    if a.cmd == "score-year":
        from boatsim.mc.boatyard import pick

        df = score_year(a.year, pick(a.builds or DEFAULT_ENTRIES, None), a.every_days, a.workers)
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(a.out, index=False)
        print(f"{len(df)} voyages, {df['build'].nunique()} builds, year {a.year}")
        return
    if a.cmd == "assemble":
        import pandas as pd

        def load(paths):
            return pd.concat([pd.read_csv(x) for x in paths], ignore_index=True) if paths else None

        pub, hold = load(a.public), load(a.holdout)
        board = assemble(
            pub,
            hold,
            a.every_days,
            sorted({int(str(s)[:4]) for s in pub["start"]}),
            sorted({int(str(s)[:4]) for s in hold["start"]}) if hold is not None else [],
        )
        Path(a.out).write_text(json.dumps(board, indent=1))
        print(report(board))
        if a.strict and check_board(board):
            raise SystemExit(1)
        return
    board = json.loads(Path(a.board).read_text())
    print(report(board))
    if a.strict and check_board(board):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
