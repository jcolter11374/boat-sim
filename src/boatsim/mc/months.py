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
* Base station: ForecastReplanPolicy reading ErrorForecast (#12): the truth
  plus error that grows with lead time, seeded per voyage.
* Hazards: knockdowns, part damage and ship strikes drawn per voyage (seeded).
  Ship density is still 0 (issue #13), so ship strikes can't happen yet.
* Unknown failures: the batch runs with the design's catch-all "unknown
  failure" hazard switched off (--unknown-p 0) and the report puts it back
  exactly at several values (unknown_survival), so odds come out as a range.
* Spread (--spread): each boat gets its own drag, solar-loss and fouling
  multipliers (SPREAD), recorded in the spread_* columns. Off by default.

Outcomes: arrived (reached the Microtransat finish target, per the runner's
arrival rule), lost (sunk, stuck upside down, wrecked), timeout (still at sea
after max_days), aground (ran ashore first), disqualified (silent too long),
or left_data_box (drifted out of the 25-60N, 82W-5E weather
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
    if log.outcome.value == "aground":
        return "ran aground before the finish"
    if log.outcome.value == "disqualified":
        return "disqualified: silent too long"
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
            "unknown_p_run": getattr(log, "unknown", (math.nan, math.nan))[0],
            "unknown_shape": getattr(log, "unknown", (math.nan, math.nan))[1],
            **{f"spread_{k}": v for k, v in getattr(log, "spread", {}).items()},
            "ships": getattr(log, "ships", None),
        }
    )
    # Closest hurricane (Priya, #13 follow-up): only when IBTrACS is downloaded.
    from boatsim.oceandata.storms import default_tracks, encounter

    tracks = default_tracks()
    if tracks is not None and log.rows:
        out.update(encounter(log.rows, tracks))
    return out


@dataclass(frozen=True)
class MonthlyVoyage(StandardVoyage):
    """StandardVoyage plus an energy meter and a clean ending if the boat
    drifts out of the weather box."""

    max_days: float = MAX_DAYS
    # None keeps the design's value. 0 switches the "unknown failure" hazard off
    # so the report can sweep it exactly afterwards (see unknown_survival).
    unknown_p_by_60_days: float | None = None
    # Build every boat slightly differently (see SPREAD and apply_spread).
    spread: bool = False

    def components(self, seed: int = 0):
        from dataclasses import replace

        c = super().components(seed)
        if self.unknown_p_by_60_days is not None:
            v = c.vessel
            v.hazards = replace(v.hazards, unknown_p_by_60_days=self.unknown_p_by_60_days)
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
        c = self.components(seed)
        mult = apply_spread(c.vessel.inner, seed) if self.spread else {}
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
        hz = c.vessel.hazards
        log.unknown = (hz.unknown_p_by_60_days, hz.unknown_shape)
        log.spread = mult
        # Was the ship-traffic map on? (#13; read by viz batch_card, #86)
        log.ships = getattr(c.env, "ships", None) is not None
        return log


# Spread on the design numbers we least trust, as log-normal multipliers
# (median 1, sigma below). All three widths are GUESSES: they say "we could
# easily be this far off", not measured scatter. The Bay trial (tow test)
# should shrink the drag and solar ones.
SPREAD = {
    "drag": 0.15,  # hull form factor: calm-water drag about +-15 % (1 sigma)
    "solar": 0.12,  # panel mounting/shading loss: about +-12 % of solar output
    "fouling": 0.5,  # weed and barnacle growth rate: a factor of ~1.6 either way
}


def spread_multipliers(seed: int) -> dict[str, float]:
    """Per-voyage multipliers, from their own random stream so the voyage's
    weather-and-hazard dice are unchanged by switching spread on."""
    import numpy as np

    rng = np.random.default_rng([seed, 20])
    return {k: float(np.exp(rng.normal(0.0, sd))) for k, sd in SPREAD.items()}


def apply_spread(vessel, seed: int) -> dict[str, float]:
    """Scale a KayakVessel's drag, solar loss and fouling rate in place."""
    from dataclasses import replace

    m = spread_multipliers(seed)
    h, s = vessel.hull, vessel.solar
    vessel.hull = replace(
        h,
        form_factor=h.form_factor * m["drag"],
        fouling_frac_per_day=h.fouling_frac_per_day * m["fouling"],
    )
    # mounting_mismatch is a loss factor, so keep it at or below 1.
    vessel.solar = replace(s, mounting_mismatch=min(1.0, s.mounting_mismatch * m["solar"]))
    return m


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


SWEEP = (0.03, 0.10, 0.25, 0.50, 0.84)  # unknown_p_by_60_days values to report


def unknown_survival(days, p: float, shape: float):
    """Chance of no "unknown failure" over `days` at sea.

    The hazard is Weibull (vessel/hazards.py unknown_hazard_per_day), sized so
    P(fail by day 60) = p, so survival to day D is (1 - p) ** ((D / 60) ** shape).
    That failure ends the voyage and nothing else depends on it, so a batch run
    with it switched off gives the exact expected odds for any p by weighting
    each arrival with this survival. No re-runs needed for the sweep.
    """
    import numpy as np

    d = np.maximum(np.asarray(days, dtype=float), 0.0)
    return (1.0 - p) ** ((d / 60.0) ** shape)


def swept_odds(df: pd.DataFrame, p: float) -> float:
    """Expected arrival odds if unknown_p_by_60_days were p (needs a run with it off)."""
    arrived = (df["outcome"] == "arrived").to_numpy(dtype=float)
    if len(arrived) == 0:
        return math.nan
    shape = float(df["unknown_shape"].dropna().iloc[0]) if "unknown_shape" in df else 0.5
    return float((arrived * unknown_survival(df["days"], p, shape)).mean())


def sweep_table(df: pd.DataFrame, values=SWEEP) -> pd.DataFrame:
    rows = []
    for m in [None, *range(1, 13)]:
        g = df if m is None else df[df["month"] == m]
        row = {"month": "All" if m is None else MONTHS[m - 1], "voyages": len(g)}
        for p in values:
            row[f"p{p:g}"] = swept_odds(g, p) if len(g) else math.nan
        rows.append(row)
    return pd.DataFrame(rows)


WINDOW = (4, 5, 6)  # John's chosen launch window: April to June (Nov 2026, CLAUDE.md)


def window_headline(df: pd.DataFrame, months=WINDOW) -> list[str]:
    """The lines that lead every report: odds for launches in the chosen window."""
    g = df[df["month"].isin(months)]
    if len(g) == 0:
        return []
    names = f"{MONTHS[months[0] - 1]} to {MONTHS[months[-1] - 1]}"
    k = int((g["outcome"] == "arrived").sum())
    p, lo, hi = wilson(k, len(g))
    out = [
        f"## Chosen launch window ({names})",
        "",
        f"**{k} of {len(g)} arrived: {p:.0%} (95% range {lo:.0%} to {hi:.0%}).**",
    ]
    if "unknown_p_run" in g and (g["unknown_p_run"] == 0.0).all():
        sweep = ", ".join(f"{swept_odds(g, x):.0%} at {x:.0%}" for x in SWEEP)
        out += [
            "",
            (
                "That leaves out failures we haven't modelled. With the 'unknown failure' "
                f"guess put back (chance of a fatal surprise by day 60): {sweep}."
            ),
        ]
    return out + ["", "Every launch month, for context:", ""]


def report_markdown(df: pd.DataFrame) -> str:
    t = by_month(df)
    years = sorted(df["year"].unique())
    p, lo, hi = wilson(int((df["outcome"] == "arrived").sum()), len(df))
    lines = [
        "# Odds by launch month",
        "",
        *window_headline(df),
        (
            f"{len(df)} voyages: launches on the 1st and 15th of every month, "
            f"{years[0]} to {years[-1]}, real weather and currents. Overall: arrived "
            f"{p:.0%} (95% range {lo:.0%} to {hi:.0%})."
        ),
        "",
        (
            "Base station plans from a forecast with realistic error (#12). Ship traffic "
            "(#13) is in runs on code 7856a64 or later. ERA5 understates hurricane winds, "
            "so treat these odds as somewhat optimistic."
            + (
                " Each boat was built slightly differently: drag, solar loss and fouling "
                "rate were varied per voyage (spread_* columns)."
                if "spread_drag" in df
                else " Every boat uses the design numbers exactly (no spread)."
            )
            + (
                " This table also leaves out the 'unknown failure' hazard: see the "
                "range below for odds with it put back."
                if "unknown_p_run" in df and (df["unknown_p_run"] == 0.0).all()
                else ""
            )
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
    run_p = df["unknown_p_run"].dropna().unique() if "unknown_p_run" in df else []
    if len(run_p) == 1 and float(run_p[0]) == 0.0:
        sw = sweep_table(df)
        lines += [
            "",
            "## Odds as a range: the 'unknown failure' guess",
            "",
            (
                "The odds above have the catch-all hazard for failures we haven't "
                "modelled (unknown_p_by_60_days) switched off. This table puts it back "
                "at several values, from the design doc's 3% up to 84%, which on "
                "synthetic weather brings the odds down to about 15%, inside the 3-20% "
                "of the Microtransat record and the Randolph team's own estimate. Each arrival is weighted by its chance of "
                "surviving that hazard for as long as it took."
            ),
            "",
            "| Launch month | Voyages | "
            + " | ".join(f"unknown {p:.0%} by day 60" for p in SWEEP)
            + " |",
            "|---" * (2 + len(SWEEP)) + "|",
        ]
        for _, r in sw.iterrows():
            vals = " | ".join("" if r["voyages"] == 0 else f"{r[f'p{p:g}']:.0%}" for p in SWEEP)
            lines.append(f"| {r['month']} | {r['voyages']} | {vals} |")
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
    r.add_argument(
        "--unknown-p",
        type=float,
        default=None,
        help="override unknown_p_by_60_days (0 = off, so the report can sweep it)",
    )
    r.add_argument("--spread", action="store_true", help="vary drag, solar and fouling per boat")
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
        df = run_year(a.year, job_from_args(a), a.workers, a.months)
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


def job_from_args(a) -> MonthlyVoyage:
    """The batch job the `run` command builds from its options."""
    return MonthlyVoyage(
        design_path=a.design,
        currents=not a.no_currents,
        max_days=a.max_days,
        unknown_p_by_60_days=a.unknown_p,
        spread=a.spread,
    )


if __name__ == "__main__":
    main()
