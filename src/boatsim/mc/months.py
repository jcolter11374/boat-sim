"""Odds by launch month (issue #20, first batch).

Launches the v4 kayak from the drop point on fixed days of every month of a
year, through the real weather and currents of that year (ERA5 + GLORYS12),
with random hazards on, and records how each voyage ended plus how much sun
and power it had. One year per call, so GitHub Actions can run years side by
side (one job each, a few GB of weather cache per job).

What is in the first batch, and what isn't yet:

* Autopilot: SafeModeAutopilot(cruise_fraction=design cruise / max drive,
  0.15 for v4), so the boat throttles back on low battery instead of running a
  fixed 15 W.
* Base station: ForecastReplanPolicy with PerfectForecast. Until Priya's #12
  (forecast error) lands, base sees the future perfectly, so any benefit of
  course corrections here is optimistic.
* Hazards: knockdowns, part damage and ship strikes drawn per voyage (seeded).
  Ship density is still 0 (issue #13), so ship strikes can't happen yet.
* Not yet: spread on drag, solar derate and fouling (the parameter spread half
  of #20). Every voyage uses the design numbers.

Outcomes: arrived (any landfall in Europe, Azores included, per the runner's
arrival rule), lost (sunk, stuck upside down, wrecked), timeout (still at sea
after max_days), or left_data_box (drifted out of the 25-60N, 82W-5E weather
box, which in practice means it went badly astray).

Each row also carries Iris's report-card fields (viz/card.py card_row: cause,
first trouble, km to go, airtime cost), so the per-year CSVs feed batch_card
directly. "ending" is our own short cause, used in the causes table here.
"""

from __future__ import annotations

import argparse
import math
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from boatsim.geo import distance_m
from boatsim.runner.parallel import StandardVoyage, run_many
from boatsim.types import EventKind

LAUNCH_DAYS = (1, 15)  # launches per month: the 1st and the 15th
MAX_DAYS = 150.0  # GUESS: long enough that slow winter crossings can finish


class MeteredVessel:
    """Wraps a KayakVessel and adds up solar, drive and hotel energy (Wh)."""

    def __init__(self, inner):
        self.inner = inner
        self.solar_wh = 0.0
        self.drive_wh = 0.0
        self.hotel_wh = 0.0
        self.ghi_wh_m2 = 0.0  # sunlight that fell on a flat square metre
        self.hours = 0.0

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def initial_state(self, t, lat, lon):
        return self.inner.initial_state(t, lat, lon)

    def sense(self, state, rng):
        return self.inner.sense(state, rng)

    def step(self, state, cmd, env, dt, rng):
        new, events = self.inner.step(state, cmd, env, dt, rng)
        h = dt.total_seconds() / 3600.0
        self.solar_wh += getattr(new, "solar_w", 0.0) * h
        self.drive_wh += getattr(new, "drive_w", 0.0) * h
        self.hotel_wh += getattr(new, "hotel_w", 0.0) * h
        self.ghi_wh_m2 += env.ghi * h
        self.hours += h
        return new, events


def launches(year: int, days: Iterable[int] = LAUNCH_DAYS) -> list[datetime]:
    """Every launch time of a year (noon UTC on the given days of each month)."""
    return [datetime(year, m, d, 12) for m in range(1, 13) for d in days]


def cause_of_end(log) -> str:
    """Short reason a voyage ended, for the causes-of-loss table."""
    if getattr(log, "left_data_box", False):
        return "left the weather box"
    if log.outcome.value == "arrived":
        return "arrived"
    if log.outcome.value == "timeout":
        return "still at sea"
    for e in reversed(log.events):
        if e.kind == EventKind.SHIP_STRIKE:
            return "ship strike"
        if e.kind == EventKind.LOST:
            return e.detail or "lost"
    return "lost (other)"


def summarise(log) -> dict:
    """run_many reduce step: runner.parallel.summarize, Iris's card fields
    (cause, first trouble, km to go, airtime) and our sun and power numbers."""
    from boatsim.runner.parallel import summarize
    from boatsim.viz.card import card_row

    left = getattr(log, "left_data_box", False)
    out = summarize(log)
    out.update(card_row(log, getattr(log, "link", None), outcome="left_data_box" if left else None))
    m = getattr(log, "meter", {}) or {}
    days = max(log.days, 1e-9)
    hours = max(m.get("hours", 0.0), 1e-9)
    socs = [r["soc"] for r in log.rows]
    drop = getattr(log, "drop", (float("nan"), float("nan")))
    end = (out["end_lat"], out["end_lon"])
    out.update(
        {
            "outcome": "left_data_box" if getattr(log, "left_data_box", False) else out["outcome"],
            "month": log.start.month,
            "year": log.start.year,
            "ending": cause_of_end(log),
            "km_from_drop": distance_m(*drop, *end) / 1000.0 if end[0] is not None else math.nan,
            "min_soc": min(socs) if socs else math.nan,
            "sun_kwh_m2_day": m.get("ghi_wh_m2", 0.0) / 1000.0 / days,
            "solar_wh_day": m.get("solar_wh", 0.0) / days,
            "drive_w_avg": m.get("drive_wh", 0.0) / hours,
            "hotel_wh_day": m.get("hotel_wh", 0.0) / days,
        }
    )
    return out


@dataclass(frozen=True)
class MonthlyVoyage(StandardVoyage):
    """StandardVoyage plus an energy meter and a clean ending if the boat
    drifts out of the weather box."""

    max_days: float = MAX_DAYS

    def components(self):
        c = super().components()
        c.vessel = MeteredVessel(c.vessel)
        return c

    def __call__(self, start: datetime, seed: int):
        from boatsim.config import load_design
        from boatsim.oceandata.grid import OutsideCoverage
        from boatsim.runner import VoyageLog, simulate
        from boatsim.runner.simulate import default_mission
        from boatsim.types import Outcome

        voyage = load_design(self.design_path).voyage
        drop = (voyage["drop_lat"], voyage["drop_lon"])
        c = self.components()
        try:
            log = simulate(c, start, *drop, default_mission(), seed=seed, max_days=self.max_days)
        except OutsideCoverage:
            # The runner raised mid-voyage, so its log is gone: keep what we know.
            log = VoyageLog(start=start, seed=seed, outcome=Outcome.TIMEOUT)
            log.end = start + timedelta(hours=c.vessel.hours)
            log.left_data_box = True
        v = c.vessel
        log.meter = {
            "solar_wh": v.solar_wh,
            "drive_wh": v.drive_wh,
            "hotel_wh": v.hotel_wh,
            "ghi_wh_m2": v.ghi_wh_m2,
            "hours": v.hours,
        }
        log.drop = drop
        log.link = c.link  # for the card's airtime cost; stays in the worker
        return log


def run_year(
    year: int,
    job: MonthlyVoyage,
    workers: int | None = None,
    only_months: list[int] | None = None,
) -> pd.DataFrame:
    starts = [t for t in launches(year) if not only_months or t.month in only_months]
    rows = run_many(job, starts, seed=year * 1000, workers=workers, reduce=summarise)
    return pd.DataFrame(rows)


# --- Odds by month ----------------------------------------------------------


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float, float]:
    if n == 0:
        return float("nan"), float("nan"), float("nan")
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return p, max(0.0, centre - half), min(1.0, centre + half)


MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def by_month(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for m in range(1, 13):
        g = df[df["month"] == m]
        k = int((g["outcome"] == "arrived").sum())
        p, lo, hi = wilson(k, len(g))
        arrived = g[g["outcome"] == "arrived"]
        rows.append(
            {
                "month": MONTHS[m - 1],
                "voyages": len(g),
                "arrived": k,
                "odds": p,
                "low95": lo,
                "high95": hi,
                "median_days_if_arrived": arrived["days"].median() if len(arrived) else math.nan,
                "sun_kwh_m2_day": g.get("sun_kwh_m2_day", pd.Series(dtype=float)).median(),
                "solar_wh_day": g.get("solar_wh_day", pd.Series(dtype=float)).median(),
                "drive_w_avg": g.get("drive_w_avg", pd.Series(dtype=float)).median(),
                "min_soc": g.get("min_soc", pd.Series(dtype=float)).median(),
            }
        )
    return pd.DataFrame(rows)


def report_markdown(df: pd.DataFrame) -> str:
    t = by_month(df)
    years = sorted(df["year"].unique())
    p, lo, hi = wilson(int((df["outcome"] == "arrived").sum()), len(df))
    lines = [
        "# Odds by launch month (first batch)",
        "",
        (
            f"{len(df)} voyages: launches on the 1st and 15th of every month, "
            f"{years[0]} to {years[-1]}, real weather and currents. Overall: arrived "
            f"{p:.0%} (95% range {lo:.0%} to {hi:.0%})."
        ),
        "",
        (
            "Base station sees a perfect forecast until #12 lands, and design numbers "
            "have no spread yet, so treat these odds as optimistic."
        ),
        "",
        (
            "| Launch month | Voyages | Arrived | Odds (95% range) | Median days if arrived "
            "| Sun kWh/m²/day | Solar Wh/day | Avg drive W | Lowest charge |"
        ),
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in t.itertuples():
        if r.voyages == 0:
            lines.append(f"| {r.month} | 0 | | no launches | | | | | |")
            continue
        lines.append(
            f"| {r.month} | {r.voyages} | {r.arrived} | {r.odds:.0%} ({r.low95:.0%} to "
            f"{r.high95:.0%}) | {r.median_days_if_arrived:.0f} | {r.sun_kwh_m2_day:.2f} "
            f"| {r.solar_wh_day:.0f} | {r.drive_w_avg:.1f} | {r.min_soc:.0%} |"
        )
    lines += ["", "How voyages ended:", "", "| Ending | Voyages |", "|---|---|"]
    for cause, n in df["ending"].value_counts().items():
        lines.append(f"| {cause} | {n} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m boatsim.mc.months")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run every launch of one year")
    r.add_argument("year", type=int)
    r.add_argument("--design", default="configs/v4_kayak.yaml")
    r.add_argument("--out", default="runs/months")
    r.add_argument("--workers", type=int, default=4)
    r.add_argument("--max-days", type=float, default=MAX_DAYS)
    r.add_argument("--months", type=int, nargs="*", help="only these launch months (1-12)")
    r.add_argument("--no-currents", action="store_true", help="try-out only: zero current")
    r.add_argument("--prefetch", action="store_true", help="fetch the ERA5 days first")
    s = sub.add_parser("report", help="combine per-year CSVs into the by-month report")
    s.add_argument("csvs", nargs="+")
    s.add_argument("--out", default="runs/months")
    a = p.parse_args(argv)

    if a.cmd == "run":
        if a.prefetch:
            from boatsim.oceandata import era5

            first = datetime(a.year, min(a.months or [1]), 1)
            last = datetime(a.year, max(a.months or [12]), 28) + timedelta(days=a.max_days + 4)
            era5.fetch_days(era5.days_between(first.date(), last.date()), workers=a.workers)
        job = MonthlyVoyage(design_path=a.design, currents=not a.no_currents, max_days=a.max_days)
        df = run_year(a.year, job, a.workers, a.months)
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        df.to_csv(out / f"voyages_{a.year}.csv", index=False)
        print(df.to_string())
    else:
        df = pd.concat([pd.read_csv(x, parse_dates=["start"]) for x in a.csvs], ignore_index=True)
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        df.to_csv(out / "voyages_all.csv", index=False)
        by_month(df).to_csv(out / "odds_by_month.csv", index=False)
        md = report_markdown(df)
        (out / "odds_report.md").write_text(md)
        print(md)


if __name__ == "__main__":
    main()
