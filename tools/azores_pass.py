"""What going by the Azores costs (John, 24 Nov 2026: "Azores and a dock in Portugal").

Sails every launch day asked for twice in the game's own simulator (boatsim.sandbox.helm.Game,
the browser's weather bundle): once on the autopilot all the way, once on the autopilot with the
"azores" order given the first time she is east of 42W (where the game asks). One JSON line a
voyage: how it ended, in how many days, and how near she came to Pico's summit (km). "refused" is
an order the boat could not take (her link to base was already dead). An "s" field is the seconds
the run took.

    PYTHONPATH=src python tools/azores_pass.py sea3d/public/sandbox/forcing_2020.npz [every_n_days] > out.jsonl
    PYTHONPATH=src python tools/azores_pass.py --summary out.jsonl

All 91 days of April to June take about 20 minutes. Results of 24 Nov 2026:
docs/qa/data/azores-pass-2026-11-24.jsonl, written up in docs/qa/azores-pass-2026-11.md.
"""

from __future__ import annotations

import json
import statistics
import sys
import time
from collections import Counter
from datetime import date, timedelta

PICO = (38.47, -28.40)  # the summit
ASK_AT_LON = -42.0


def sail(env, day: str, plan: str) -> dict:
    from boatsim.geo import distance_m
    from boatsim.sandbox.helm import Game

    g = Game(env, choices=None, day=day)
    ordered, refused, near = False, False, 1e9
    while True:
        out = g.run(
            hours=6,
            land_within_km=None,
            breakdown=False,
            ghost_passes=False,
            order_arrives=False,
            silence=False,
        )
        b = out["status"]["boat"]
        near = min(near, distance_m(b["lat"], b["lon"], *PICO) / 1000)
        if out["status"].get("over"):
            break
        if plan == "azores" and not ordered and b["lon"] >= ASK_AT_LON:
            ordered = True
            refused = not g.order("azores", 0.5).get("accepted")
    me = g.result()["boat"]
    return {
        "day": day,
        "plan": plan,
        "outcome": me["outcome"],
        "days": round(me["days"], 1),
        "near_pico_km": round(near),
        "refused": refused,
    }


def summary(path: str) -> None:
    by: dict[str, dict[str, dict]] = {}
    with open(path) as f:
        for line in f:
            if line.startswith("{"):
                r = json.loads(line)
                by.setdefault(r["day"], {})[r["plan"]] = r
    # The order was taken where the two voyages differ at all (the dice are the same for both).
    key = ("outcome", "days", "near_pico_km")
    went = [d for d in by if any(by[d]["azores"][k] != by[d]["auto"][k] for k in key)]
    dead = sum(by[d]["azores"]["refused"] for d in by)
    print(
        f"launch days: {len(by)}; the order was taken on {len(went)}; link already dead on {dead}"
    )
    print("  autopilot's own route:", dict(Counter(by[d]["auto"]["outcome"] for d in went)))
    print("  by the Azores:        ", dict(Counter(by[d]["azores"]["outcome"] for d in went)))
    fin = [d for d in went if by[d]["auto"]["outcome"] == "arrived"]
    both = sorted(
        by[d]["azores"]["days"] - by[d]["auto"]["days"]
        for d in fin
        if by[d]["azores"]["outcome"] == "arrived"
    )
    n = len(both)
    print(
        f"  finished both ways: {n}; extra days: median {statistics.median(both):.1f}, "
        f"middle 8 in 10 from {both[n // 10]:.1f} to {both[9 * n // 10]:.1f}, "
        f"least {both[0]:.1f}, most {both[-1]:.1f}"
    )
    bad = [(d, by[d]["azores"]["outcome"]) for d in fin if by[d]["azores"]["outcome"] != "arrived"]
    print(
        f"  finished on the autopilot's route but not by the Azores: {len(bad)} of {len(fin)}: {bad}"
    )
    near = sorted(
        by[d]["azores"]["near_pico_km"] for d in went if by[d]["azores"]["outcome"] == "arrived"
    )
    print(
        f"  nearest to Pico's summit: median {statistics.median(near):.0f} km, {near[0]} to {near[-1]}"
    )


def main(argv: list[str]) -> None:
    if argv[:1] == ["--summary"]:
        return summary(argv[1])
    from boatsim.sandbox.run import open_bundle

    env = open_bundle(argv[0])
    step = int(argv[1]) if len(argv) > 1 else 1
    for k in range(0, 91, step):
        day = (date(2020, 4, 1) + timedelta(days=k)).isoformat()
        for plan in ("auto", "azores"):
            t = time.time()
            r = sail(env, day, plan)
            r["s"] = round(time.time() - t, 1)
            print(json.dumps(r), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
