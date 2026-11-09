"""Sensitivity study (issue #21): which change to the design or its settings
moves the odds for April to June launches?

Each variant is the v4 kayak with one thing changed: how the base station
talks to it, the battery, the solar panels, the cruise power, or the safe-mode
battery rules. Every variant sails the SAME launches with the SAME seeds, so
the weather, the forecast error and the hazard dice are identical; only the
change differs. That pairing is what makes small differences visible: a voyage
that arrives in one variant and not in the other is a real effect of the
change (or of the dice being rolled at different moments once the boats
diverge), not a different year's weather.

Read the result with two cautions:

* **Ceiling.** About 93% of April to June launches already arrive in the
  baseline, so a change can't gain many arrivals. The report also shows
  median days at sea and the odds with the 'unknown failure' guess put back
  (months.swept_odds): a faster crossing spends fewer days exposed to
  failures we haven't modelled, so it scores better there.
* **Noise.** With n paired voyages, a gain or loss of a few arrivals is
  within chance. The sign test on the voyages that flipped says how likely
  that split is if the change did nothing.

Dollar costs aren't in yet: the parts catalogue (#25) will price battery and
panel changes. Settings changes (cruise power, safe mode, base policy) are free.
Airtime per voyage is reported, since it is an output to minimise.

Not in this batch: one thruster instead of two. The vessel model still rolls
failure dice for both thruster positions, so a one-thruster boat would be
judged unfairly. Needs a vessel change first.

Owner: Ravi.
"""

from __future__ import annotations

import argparse
import math
import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from boatsim.mc.months import (
    MAX_DAYS,
    MONTHS,
    WINDOW,
    MeteredVessel,
    MonthlyVoyage,
    summarise,
    swept_odds,
    wilson,
)


@dataclass(frozen=True)
class Variant:
    group: str  # what kind of change: comms, battery, solar, cruise, safe mode
    label: str  # plain words for John
    # (design section, key, new value), e.g. ("power", "battery_wh", 640)
    design: tuple[tuple[str, str, float], ...] = ()
    # "replan": the team's ForecastReplanPolicy; "no_corrections": same daily
    # "all well" message but never a new route; "silent": base sends nothing.
    base: str = "replan"
    safemode: tuple[tuple[str, object], ...] = ()  # SafeModeAutopilot keyword overrides


# All values are trial settings to compare, not recommendations.
VARIANTS: dict[str, Variant] = {
    "baseline": Variant("baseline", "The design as it stands"),
    "no_corrections": Variant(
        "comms",
        "Base never changes the route (still sends a daily 'all well')",
        base="no_corrections",
    ),
    "silent_base": Variant(
        "comms",
        "Base sends nothing; boat follows its stored route, then heads east",
        base="silent",
    ),
    "battery_640": Variant(
        "battery", "Half the battery (one 50 Ah pack, 640 Wh)", (("power", "battery_wh", 640),)
    ),
    "battery_1920": Variant(
        "battery", "Half again the battery (1920 Wh)", (("power", "battery_wh", 1920),)
    ),
    "solar_150": Variant("solar", "Smaller panels (150 W)", (("power", "solar_wp", 150),)),
    "solar_350": Variant("solar", "Bigger panels (350 W)", (("power", "solar_wp", 350),)),
    "cruise_10w": Variant(
        "cruise", "Slower cruise (10 W motor power)", (("propulsion", "cruise_drive_w", 10),)
    ),
    "cruise_25w": Variant(
        "cruise", "Faster cruise (25 W motor power)", (("propulsion", "cruise_drive_w", 25),)
    ),
    "hold_at_30": Variant(
        "safe mode",
        "Stop motors earlier: below 30% charge, restart at 40%",
        safemode=(("hold_below_soc", 0.30), ("resume_above_soc", 0.40)),
    ),
    "no_throttle_back": Variant(
        "safe mode",
        "Never slow down on low battery; only stop at 15%",
        safemode=(("throttle_steps", ((0.15, 1.0),)),),
    ),
}

FIRST_BATCH = tuple(VARIANTS)


def patched_design(design, changes):
    """The design with (section, key, value) changes applied."""
    for section, key, value in changes:
        design = replace(design, **{section: {**getattr(design, section), key: value}})
    return design


@dataclass(frozen=True)
class SensitivityVoyage(MonthlyVoyage):
    """MonthlyVoyage with one variant applied."""

    variant: str = "baseline"

    def components(self, seed: int = 0):
        from boatsim.autonomy import SafeModeAutopilot
        from boatsim.basestation import ForecastReplanPolicy, HoldCoursePolicy
        from boatsim.config import load_design
        from boatsim.runner.simulate import default_mission
        from boatsim.vessel import KayakVessel

        v = VARIANTS[self.variant]
        c = super().components(seed)
        design = patched_design(load_design(self.design_path), v.design)
        if v.design:
            inner = KayakVessel(design)
            inner.hazards = c.vessel.inner.hazards  # keeps the unknown-p override
            c.vessel = MeteredVessel(inner)
        if v.design or v.safemode:
            prop = design.propulsion
            c.autopilot = SafeModeAutopilot(
                cruise_fraction=prop["cruise_drive_w"] / prop["max_drive_w"], **dict(v.safemode)
            )
        if v.base == "no_corrections":
            c.base = ForecastReplanPolicy(route=default_mission().waypoints, min_gain_h=math.inf)
        elif v.base == "silent":
            c.base = HoldCoursePolicy()
        elif v.base != "replan":
            raise ValueError(f"unknown base policy {v.base!r}")
        return c


def window_launches(year: int, every_days: int = 10, months=WINDOW) -> list[datetime]:
    """Launch times (noon UTC) every `every_days` days through the window."""
    out, t = [], datetime(year, months[0], 1, 12)
    while t.month in months:
        out.append(t)
        t += timedelta(days=every_days)
    return out


def _tagged(args):
    from boatsim.runner.parallel import _call

    name, task = args
    row = _call(task)
    row["variant"] = name
    return row


def run_year(
    year: int,
    variants=FIRST_BATCH,
    every_days: int = 10,
    workers: int | None = 4,
    **job_kw,
) -> pd.DataFrame:
    """Every variant over the same launches and seeds (seed = year * 1000 + i)."""
    starts = window_launches(year, every_days)
    tasks = []
    for name in variants:
        job = SensitivityVoyage(variant=name, **job_kw)
        tasks += [(name, (job, summarise, s, year * 1000 + i)) for i, s in enumerate(starts)]
    workers = workers or os.cpu_count() or 1
    if workers == 1:
        rows = [_tagged(t) for t in tasks]
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            rows = list(pool.map(_tagged, tasks))
    return pd.DataFrame(rows)


# --- Report -----------------------------------------------------------------


def sign_test(gained: int, lost: int) -> float:
    """Two-sided exact sign test: chance of a split at least this lopsided
    among the flipped voyages if the change made no difference."""
    n = gained + lost
    if n == 0:
        return 1.0
    k = min(gained, lost)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return min(1.0, 2 * tail)


def compare(df: pd.DataFrame) -> pd.DataFrame:
    """One row per variant, paired against the baseline voyage by voyage."""
    key = ["start", "seed"]
    base = df[df["variant"] == "baseline"].set_index(key)
    base_ok = base["outcome"] == "arrived"
    rows = []
    for name in [v for v in VARIANTS if v in set(df["variant"])]:
        g = df[df["variant"] == name]
        ok = g["outcome"] == "arrived"
        k = int(ok.sum())
        p, lo, hi = wilson(k, len(g))
        pair = g.set_index(key)["outcome"].eq("arrived")
        common = pair.index.intersection(base_ok.index)
        gained = int((pair[common] & ~base_ok[common]).sum())
        lost = int((~pair[common] & base_ok[common]).sum())
        v = VARIANTS[name]
        air = g["airtime_usd"].median() if "airtime_usd" in g else math.nan
        rows.append(
            {
                "variant": name,
                "group": v.group,
                "label": v.label,
                "voyages": len(g),
                "arrived": k,
                "odds": p,
                "low95": lo,
                "high95": hi,
                "gained": gained,
                "lost": lost,
                "sign_p": sign_test(gained, lost),
                "median_days": g.loc[ok, "days"].median() if k else math.nan,
                "odds_unknown_10": swept_odds(g, 0.10),
                "odds_unknown_50": swept_odds(g, 0.50),
                "airtime_usd": air,
                "min_soc": g["min_soc"].median(),
            }
        )
    return pd.DataFrame(rows)


def report_markdown(df: pd.DataFrame) -> str:
    t = compare(df)
    years = sorted(df["year"].unique())
    months = sorted(df["month"].unique())
    n = int(t["voyages"].max())
    lines = [
        "# Sensitivity study: April to June launches",
        "",
        (
            f"Each row is the v4 kayak with one change, sailing the same {n} launches "
            f"({MONTHS[months[0] - 1]} to {MONTHS[months[-1] - 1]}, {years[0]} to "
            f"{years[-1]}, real weather and currents) with the same random dice. "
            "'Gained' and 'lost' count voyages that arrive with the change but not "
            "without it, and the other way round. 'Chance' is how likely that split "
            "is if the change did nothing; above about 5% treat it as noise."
        ),
        "",
        (
            "The 'unknown failure' hazard is off in the runs and put back in the two "
            "'with unknown' columns (10% and 50% chance of a fatal surprise by day 60). "
            "Those columns reward faster crossings. Ship traffic (#13) is not "
            "modelled yet. Build cost isn't priced until the parts catalogue (#25)."
        ),
        "",
        (
            "| Change | Arrived | Odds (95% range) | Gained | Lost | Chance | "
            "Median days | With unknown 10% | With unknown 50% | Airtime $ | "
            "Lowest charge |"
        ),
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in t.itertuples():
        same = r.variant == "baseline"
        lines.append(
            f"| {r.label} | {r.arrived}/{r.voyages} | {r.odds:.0%} ({r.low95:.0%} to "
            f"{r.high95:.0%}) | {'' if same else r.gained} | {'' if same else r.lost} | "
            f"{'' if same else f'{r.sign_p:.0%}'} | {r.median_days:.0f} | "
            f"{r.odds_unknown_10:.0%} | {r.odds_unknown_50:.0%} | {r.airtime_usd:.0f} | "
            f"{r.min_soc:.0%} |"
        )
    lines += ["", "How voyages ended:", "", "| Change | " + " | ".join(_endings(df)) + " |"]
    lines.append("|---" * (1 + len(_endings(df))) + "|")
    for name in t["variant"]:
        counts = df[df["variant"] == name]["ending"].value_counts()
        cells = " | ".join(str(int(counts.get(e, 0))) for e in _endings(df))
        lines.append(f"| {VARIANTS[name].label} | {cells} |")
    return "\n".join(lines) + "\n"


def _endings(df: pd.DataFrame) -> list[str]:
    return list(df["ending"].value_counts().index)


# --- CLI --------------------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m boatsim.mc.sensitivity")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run every variant over one year's April to June launches")
    r.add_argument("year", type=int)
    r.add_argument("--variants", nargs="*", default=list(FIRST_BATCH), choices=list(VARIANTS))
    r.add_argument("--every-days", type=int, default=10)
    r.add_argument("--design", default="configs/v4_kayak.yaml")
    r.add_argument("--out", default="runs/sensitivity")
    r.add_argument("--workers", type=int, default=4)
    r.add_argument("--max-days", type=float, default=MAX_DAYS)
    r.add_argument("--unknown-p", type=float, default=0.0, help="0 = off, swept in the report")
    r.add_argument("--no-currents", action="store_true", help="try-out only: zero current")
    r.add_argument("--constant", action="store_true", help="test only: constant made-up weather")
    s = sub.add_parser("report", help="combine per-year CSVs into the sensitivity report")
    s.add_argument("csvs", nargs="+")
    s.add_argument("--out", default="runs/sensitivity")
    a = p.parse_args(argv)

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.cmd == "run":
        if "baseline" not in a.variants:
            a.variants = ["baseline", *a.variants]
        df = run_year(
            a.year,
            a.variants,
            a.every_days,
            a.workers,
            design_path=a.design,
            weather="constant" if a.constant else "reanalysis",
            currents=not a.no_currents,
            max_days=a.max_days,
            unknown_p_by_60_days=a.unknown_p,
        )
        df.to_csv(out / f"sensitivity_{a.year}.csv", index=False)
        print(df[["variant", "start", "outcome", "days", "ending"]].to_string())
    else:
        df = pd.concat([pd.read_csv(x, parse_dates=["start"]) for x in a.csvs], ignore_index=True)
        df.to_csv(out / "sensitivity_all.csv", index=False)
        compare(df).to_csv(out / "sensitivity_compare.csv", index=False)
        md = report_markdown(df)
        (out / "sensitivity_report.md").write_text(md)
        print(md)


if __name__ == "__main__":
    main()
