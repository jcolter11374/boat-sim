"""Check a weather challenge's stars on real runs (Ravi, QA).

Sails the challenge in its own weather bundle: the autopilot ghost, plus fixed
order sets (a heading and a power held to the end), judges each with
boatsim.sandbox.stars, and fails unless:
  - three stars can be earned (some fixed plan gets them),
  - every star level is reachable, and
  - the ghost alone never gets three.

    python tools/challenge_stars.py sandys-shadow --bundle sea3d/public/challenges/challenge_sandys-shadow.npz \
        --ibtracs ibtracs.csv --out stars.json

The hourly storm centre goes into the JSON too, for the page's goal chip.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import timedelta

from boatsim.sandbox import run as R
from boatsim.sandbox.helm import Game
from boatsim.sandbox.stars import RULES, centre_at, judge, storm_track

DAYS = {"sandys-shadow": 9.0}
PLANS: dict[str, tuple | None] = {
    "ghost (no orders)": None,
    "finish 25%": ("finish", 0.25),
    "finish 50%": ("finish", 0.5),
    "finish 80%": ("finish", 0.8),
    "east 15%": (90.0, 0.15),
    "east 25%": (90.0, 0.25),
    "east 50%": (90.0, 0.5),
    "east 80%": (90.0, 0.8),
    "east-north-east 25%": (70.0, 0.25),
    "south-east 25%": (135.0, 0.25),
    "south-east 50%": (135.0, 0.5),
    "south 50%": (180.0, 0.5),
}


def sail(env, cid: str, plan, days: float) -> tuple[list[dict], str]:
    g = Game(env, challenge=cid, max_days=days + 1)
    if plan:
        g.order(*plan)
    end = g.start + timedelta(days=days)
    while g.mine.state.t < end and not g.status()["over"]:
        left = (end - g.mine.state.t).total_seconds() / 3600
        r = g.run(
            hours=min(24.0, left),
            soc_below=None,
            wind_above=None,
            land_within_km=None,
            ghost_passes=False,
            silence=False,
        )
        if r["stopped"] == "over":
            break
    return g.track(stride_h=1.0)["boat"], g.status()["boat"]["outcome"]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("challenge")
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--ibtracs", required=True)
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    rule, days = RULES[a.challenge], DAYS[a.challenge]
    track = storm_track(a.ibtracs, rule.storm, rule.season)
    if len(track) < 4:
        print(f"no best track for {rule.storm} {rule.season} in {a.ibtracs}")
        return 2
    with open(a.bundle, "rb") as f:
        env = R.open_bundle(f.read())
    results = {}
    print(
        f"| {a.challenge} plan | stars | closest to {rule.storm.title()} | ends at | battery low |"
    )
    print("|---|---|---|---|---|")
    for name, plan in PLANS.items():
        rows, outcome = sail(env, a.challenge, plan, days)
        j = judge(rows, outcome, track, rule)
        results[name] = {**j, "outcome": outcome}
        print(
            f"| {name} | {'★' * j['stars'] or '-'} | {j['closest_km']:.0f} km | {j['end_lon']:.1f}° "
            f"| {j['battery_low']:.0%} |",
            flush=True,
        )
    got = [r["stars"] for r in results.values()]
    problems = []
    if results["ghost (no orders)"]["stars"] >= 3:
        problems.append("the ghost earns three stars on its own")
    for n in (1, 2, 3):
        if not any(s >= n for s in got):
            problems.append(f"no plan earns {n} star{'s' if n > 1 else ''}")
    t0 = track[0][0]
    hourly = []
    for h in range(int((track[-1][0] - t0).total_seconds() // 3600) + 1):
        t = t0 + timedelta(hours=h)
        c = centre_at(track, t)
        hourly.append([t.isoformat() + "Z", round(c[0], 3), round(c[1], 3)])
    if a.out:
        with open(a.out, "w") as f:
            json.dump(
                {
                    "challenge": a.challenge,
                    "rule": rule.__dict__,
                    "runs": results,
                    "storm_hourly": hourly,
                    "problems": problems,
                },
                f,
                indent=1,
            )
    for p in problems:
        print(f"PROBLEM: {p}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
