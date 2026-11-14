"""Is the ghost a fair rival? A survey anyone can rerun (Rosa, M5 piece G1).

In "Take the helm" the autopilot sails the player's boat beside them as a ghost:
same build, launch day, weather and breakdown dice (sandbox/helm.py). Fair also
means it sails sensibly, so that beating it takes a decision. This survey asks the
plainest question about that: does a player who gives ONE order at the start and
never touches the boat again beat the ghost?

    python -m boatsim.sandbox.rival_survey site/sandbox/forcing_2020.npz
    python -m boatsim.sandbox.rival_survey forcing_2020.npz --every 1 --json out.json

For each launch day and each fixed order it plays the game to the end with nothing
stopping the clock, and tallies the verdicts the results card would give. The
target for M5 (Maya, 14 Nov 2026): no fixed order beats the ghost on more than a
quarter of the days the ghost finishes, the middle margin is within a day either
way, and the ghost finishes at least as often as it does today.

Needs only what the page's simulator needs (numpy, pyyaml).
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

from boatsim.sandbox.helm import Game, launch_days

# One order, given at the drop: (name, heading, power as a share of full drive power).
# None: no order at all, so the boat stays on the ghost's own autopilot (a dead heat, #327).
FIXED_ORDERS: tuple[tuple[str, str | None, float], ...] = (
    ("no order", None, 0.0),
    ("finish, quarter power", "finish", 0.25),
    ("finish, 35% power", "finish", 0.35),
    ("finish, half power", "finish", 0.5),
    ("finish, full power", "finish", 1.0),
    ("route, full power", "route", 1.0),
)
VERDICTS = ("won", "lost", "draw", "neither_finished")
# Nothing stops the clock: the scripted player never looks up.
_QUIET = {
    "breakdown": False,
    "ghost_passes": False,
    "silence": False,
    "order_arrives": False,
    "land_within_km": None,
}

# The M5 target.
MAX_WIN_SHARE = 0.25
MAX_MEDIAN_MARGIN_DAYS = 1.0


def play(env, day: str | None, heading: str | None, power: float, **game_kw) -> dict:
    """One game to its end on one fixed order; the results card. `day` None: the
    launch is named in `game_kw` (launch_index, as the tests' short bundles need)."""
    g = Game(env, **({"day": day} if day is not None else {}), **game_kw)
    if heading is not None:
        g.order(heading, power)
    while not g.run(hours=None, **_QUIET)["status"]["over"]:
        pass
    return g.result()


def survey(env, days: list[str], orders=FIXED_ORDERS, log=None, **game_kw) -> dict:
    """Every fixed order on every day. Returns the rows (one per day and order)
    and, per order, the tally of verdicts and the median margin in days over the
    days both boats finished (positive: the player finished first)."""
    rows = []
    for day in days:
        for name, heading, power in orders:
            r = play(env, day, heading, power, **game_kw)
            rows.append(
                {
                    "day": day,
                    "order": name,
                    "verdict": r["verdict"],
                    "margin_days": r["margin_days"],
                    "boat": r["boat"]["outcome"],
                    "boat_days": r["boat"]["days"],
                    "ghost": r["ghost"]["outcome"],
                    "ghost_days": r["ghost"]["days"],
                }
            )
            if log:
                log(rows[-1])
    return {"days": days, "rows": rows, "orders": summarise(rows)}


def summarise(rows: list[dict]) -> dict:
    out: dict[str, dict] = {}
    for r in rows:
        o = out.setdefault(
            r["order"], {v: 0 for v in VERDICTS} | {"margins": [], "ghost_finished": 0}
        )
        o[r["verdict"]] += 1
        o["ghost_finished"] += r["ghost"] == "arrived"
        if r["margin_days"] is not None:
            o["margins"].append(r["margin_days"])
    for o in out.values():
        m = o.pop("margins")
        o["both_finished"] = len(m)
        o["median_margin_days"] = statistics.median(m) if m else None
        # The share of the ghost's finishes that this order beat.
        o["win_share"] = o["won"] / o["ghost_finished"] if o["ghost_finished"] else None
    return out


def unfair(summary: dict) -> list[str]:
    """The fixed orders that beat the ghost too often or by too much, in words; empty when the ghost is a fair rival."""
    bad = []
    for name, o in summary.items():
        if o["win_share"] is not None and o["win_share"] > MAX_WIN_SHARE:
            bad.append(
                f"'{name}' beats the ghost on {o['won']} of the {o['ghost_finished']} days it finishes"
            )
        elif (
            o["median_margin_days"] is not None and o["median_margin_days"] > MAX_MEDIAN_MARGIN_DAYS
        ):
            bad.append(
                f"'{name}' finishes {o['median_margin_days']:.1f} days ahead of the ghost in the middle"
            )
    return bad


def table(summary: dict) -> str:
    head = f"{'the one order':<24}{'won':>5}{'lost':>6}{'level':>7}{'neither':>9}{'middle margin (days)':>23}"
    lines = [head]
    for name, o in summary.items():
        m = o["median_margin_days"]
        lines.append(
            f"{name:<24}{o['won']:>5}{o['lost']:>6}{o['draw']:>7}{o['neither_finished']:>9}"
            f"{f'{m:+.1f}' if m is not None else '-':>23}"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    from boatsim.sandbox.run import open_bundle

    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("bundle", type=Path, help="the season's weather bundle (forcing_2020.npz)")
    ap.add_argument(
        "--every", type=int, default=4, help="every Nth launch day (default 4: 20 days of 2020)"
    )
    ap.add_argument("--json", type=Path, help="also write the rows and the summary here")
    a = ap.parse_args(argv)
    env = open_bundle(a.bundle.read_bytes())
    days = [d["date"] for d in launch_days(env)][:: a.every]

    def log(r: dict) -> None:
        m = r["margin_days"]
        print(
            f"{r['day']}  {r['order']:<24}{r['verdict']:<18}"
            f"{f'{m:+.1f} d' if m is not None else '':>9}  ghost {r['ghost']} {r['ghost_days']:.1f} d",
            flush=True,
        )

    res = survey(env, days, log=log)
    print(
        f"\n{len(days)} launch days, our kayak, breakdowns on. Positive margin: the player finished first."
    )
    print(table(res["orders"]))
    bad = unfair(res["orders"])
    print("\nFair rival: " + ("yes" if not bad else "not yet\n  " + "\n  ".join(bad)))
    if a.json:
        a.json.write_text(json.dumps(res, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
