"""Mission report card (#26): a one-screen readout after every run.

For one voyage: did it arrive, how long it took, where it ended up, why it
failed, the moment things started going wrong, and what it cost. For a Monte
Carlo batch: the odds with an honest range, the causes of loss, and the odds by
launch month.

The idea comes from the build-launch-learn loop of games like Kerbal Space
Program (launch, read the debrief, tweak, relaunch). Only the idea: the look is
plain text and our own, and every number comes straight from the voyage log.

Honesty rules (from Ravi's drifter check, docs/qa/drifter-check-2026-11.md):
the simulated ocean is good for odds over many launches, not for the path of
any one boat. So a single-voyage card always says so, and a batch card always
shows the 95% range and warns when there are too few runs to trust.

Owner: Iris.
"""

from __future__ import annotations

import itertools
import math
import textwrap
from dataclasses import asdict, dataclass, field
from datetime import datetime

import pandas as pd

from boatsim.geo import distance_m
from boatsim.runner.arrival import FinishTarget
from boatsim.runner.simulate import VoyageLog
from boatsim.types import EventKind, Outcome

# --------------------------------------------------------------------- causes

# One cause per voyage. Keys are stable (Ravi's batch stores them); labels are
# what John reads.
CAUSES: dict[str, str] = {
    "arrived": "Finished: reached the target off Portugal (Microtransat rules)",
    "ship_strike": "Hit by a ship",
    "capsize": "Rolled over by a wave and didn't come back up",
    "part_failed": "A part broke and the boat was lost",
    "lost_other": "Lost at sea (other)",
    "aground": "Ran aground before reaching the finish (drifted ashore)",
    "disqualified": "Disqualified: silent too long (Microtransat rule: 10 days in a row, 15 total)",
    "battery_empty": "Battery ran flat; drifted until time ran out",
    "off_course_timeout": "Still at sea when time ran out (too slow or blown off course)",
    "left_data_box": "Blown far off course, out of the weather-data area",
}

# Batch outcome Ravi's runner adds when the boat leaves the 25-60N, 82W-5E
# weather box (the run stops there, so it can't arrive).
LEFT_DATA_BOX = "left_data_box"

# "How far to go": distance to the edge of the Microtransat target circle
# (runner/arrival.py), which is what counts as a finish.
_TARGET = FinishTarget()

SAFE_MODE_HOLD_SOC = 0.15  # safe mode stops the motors below this (autonomy/safemode.py)
STALL_WINDOW_DAYS = 5.0  # "losing ground" = farther from the finish than 5 days earlier
MIN_RUNS_FOR_ODDS = 30  # below this, the batch card calls the odds rough
MIN_RUNS_PER_MONTH = 10

SINGLE_TRACK_CAVEAT = (
    "One simulated voyage is a story, not a forecast. Our ocean model gets the "
    "Gulf Stream about right but can be 100-250 km off after 10 days, so trust "
    "odds from many runs, not this one track."
)


def km_to_finish(lat: float, lon: float, target: FinishTarget = _TARGET) -> float:
    """Great-circle km to the edge of the finish target circle (0 inside it)."""
    d = (distance_m(lat, lon, target.lat, target.lon) - target.radius_m) / 1000.0
    return max(0.0, d)


km_to_europe = km_to_finish  # old name, kept for callers


def _days(t: datetime, start: datetime) -> float:
    return (t - start).total_seconds() / 86400.0


def classify_cause(log: VoyageLog) -> str:
    """Pick the single cause that ended (or ruined) this voyage."""
    if log.outcome == Outcome.ARRIVED:
        return "arrived"
    if log.outcome == Outcome.AGROUND:
        return "aground"
    if log.outcome == Outcome.DISQUALIFIED:
        return "disqualified"
    if log.outcome == Outcome.LOST:
        # The last damaging event before the end is what sank it.
        for e in reversed(log.events):
            if e.kind == EventKind.SHIP_STRIKE and "survived" not in e.detail:
                return "ship_strike"
            if e.kind == EventKind.LOST:
                if "inverted" in e.detail or "keel" in e.detail:
                    return "capsize"
                return "lost_other"
        if any(e.kind == EventKind.PART_FAILED for e in log.events):
            return "part_failed"
        return "lost_other"
    # Timed out at sea.
    if any(e.kind == EventKind.BATTERY_EMPTY for e in log.events):
        return "battery_empty"
    return "off_course_timeout"


@dataclass
class Trouble:
    day: float
    what: str


def first_trouble(log: VoyageLog) -> Trouble | None:
    """The first moment things started going wrong, or None for a clean run.

    Earliest of: a knockdown, a broken part, a ship strike, a flat battery,
    the charge falling to the level where safe mode stops the motors, or the
    boat being farther from the finish than it was 5 days before (losing ground).
    """
    found: list[Trouble] = []
    labels = {
        EventKind.CAPSIZE: "knocked down by a wave",
        EventKind.PART_FAILED: "part broke",
        EventKind.SHIP_STRIKE: "hit by a ship",
        EventKind.BATTERY_EMPTY: "battery ran flat",
        EventKind.LOST: "lost",
        EventKind.AGROUND: "ran aground",
    }
    for e in log.events:
        if e.kind in labels:
            what = labels[e.kind] + (f" ({e.detail})" if e.detail else "")
            found.append(Trouble(_days(e.t, log.start), what))
            break  # events are in time order; the first is enough

    rows = log.rows
    for r in rows:
        if r.get("soc") is not None and r["soc"] <= SAFE_MODE_HOLD_SOC:
            found.append(
                Trouble(
                    _days(r["t"], log.start),
                    f"battery down to {r['soc']:.0%}; safe mode stops the motors to recharge",
                )
            )
            break

    if rows:
        # Losing ground: compare each logged point with the one ~5 days earlier.
        times = [_days(r["t"], log.start) for r in rows]
        dist = [km_to_finish(r["lat"], r["lon"]) for r in rows]
        j = 0
        for i in range(len(rows)):
            while times[i] - times[j] > STALL_WINDOW_DAYS:
                j += 1
            if times[i] - times[j] >= STALL_WINDOW_DAYS - 1e-9 and dist[i] > dist[j]:
                found.append(
                    Trouble(
                        times[i],
                        f"losing ground: {dist[i] - dist[j]:.0f} km farther from the finish "
                        f"than {STALL_WINDOW_DAYS:.0f} days earlier",
                    )
                )
                break
    return min(found, key=lambda x: x.day) if found else None


# ---------------------------------------------------------------- voyage card


@dataclass
class VoyageCard:
    launched: datetime
    seed: int
    outcome: str
    cause: str
    days: float
    end_lat: float | None
    end_lon: float | None
    km_to_go: float | None
    distance_sailed_km: float
    min_soc: float | None
    knockdowns: int
    parts_broken: list[str]
    trouble_day: float | None
    trouble: str | None
    airtime_usd: dict[str, float] | None = None
    build_cost_usd: float | None = None
    caveat: str = SINGLE_TRACK_CAVEAT

    def row(self) -> dict:
        """Flat fields for one row of a batch summary (Ravi's run_batch)."""
        return {
            "cause": self.cause,
            "trouble_day": self.trouble_day,
            "trouble": self.trouble,
            "end_lat": self.end_lat,
            "end_lon": self.end_lon,
            "km_to_go": self.km_to_go,
            "min_soc": self.min_soc,
            "knockdowns": self.knockdowns,
            "airtime_usd": None if self.airtime_usd is None else self.airtime_usd["total"],
        }

    def to_dict(self) -> dict:
        d = asdict(self)
        d["launched"] = self.launched.isoformat()
        return d


def voyage_card(
    log: VoyageLog, link: object | None = None, build_cost_usd: float | None = None
) -> VoyageCard:
    """Build the card for one voyage.

    link: the voyage's comms link; if it can price the voyage (IridiumSBDLink's
    `voyage_cost_usd`), the card shows the itemised airtime bill.
    build_cost_usd: the boat's parts cost. Not in the design config yet (the
    parts catalogue, #25, will supply it), so the card says "not priced" rather
    than guess.
    """
    rows = log.rows
    end_lat = rows[-1]["lat"] if rows else None
    end_lon = rows[-1]["lon"] if rows else None
    sailed = 0.0
    for a, b in itertools.pairwise(rows):
        sailed += distance_m(a["lat"], a["lon"], b["lat"], b["lon"]) / 1000.0
    socs = [r["soc"] for r in rows if r.get("soc") is not None]
    knockdowns = 0
    for e in log.events:
        if e.kind == EventKind.CAPSIZE:
            try:
                knockdowns += int(e.detail.split()[0])
            except (ValueError, IndexError):
                knockdowns += 1
    parts = [
        e.detail.split(" (")[0] for e in log.events if e.kind == EventKind.PART_FAILED and e.detail
    ]
    trouble = first_trouble(log)
    airtime = None
    price = getattr(link, "voyage_cost_usd", None)
    if price is not None:
        end = log.end or (rows[-1]["t"] if rows else log.start)
        airtime = price(log.start, end)
    return VoyageCard(
        launched=log.start,
        seed=log.seed,
        outcome=log.outcome.value,
        cause=classify_cause(log),
        days=round(log.days, 1),
        end_lat=None if end_lat is None else float(end_lat),
        end_lon=None if end_lon is None else float(end_lon),
        km_to_go=None
        if end_lat is None or log.outcome == Outcome.ARRIVED
        else float(round(km_to_finish(end_lat, end_lon))),
        distance_sailed_km=float(round(sailed)),
        min_soc=float(min(socs)) if socs else None,
        knockdowns=knockdowns,
        parts_broken=parts,
        trouble_day=None if trouble is None else round(trouble.day, 1),
        trouble=None if trouble is None else trouble.what,
        airtime_usd=airtime,
        build_cost_usd=build_cost_usd,
    )


def card_row(log: VoyageLog, link: object | None = None, outcome: str | None = None) -> dict:
    """Shortcut for batches: the card's flat fields for one summary row.

    Plain floats, ints, strings and None only, so it pickles cheaply from a
    worker process. Pass outcome="left_data_box" when the batch stopped the
    run because the boat left the weather box.
    """
    row = voyage_card(log, link).row()
    if outcome == LEFT_DATA_BOX:
        row["cause"] = LEFT_DATA_BOX
    return {k: (float(v) if isinstance(v, float) else v) for k, v in row.items()}


def _pos(lat: float, lon: float) -> str:
    return f"{abs(lat):.1f}°{'N' if lat >= 0 else 'S'} {abs(lon):.1f}°{'W' if lon < 0 else 'E'}"


def render_voyage(card: VoyageCard) -> str:
    """The card as plain text, one screen."""
    headline = "ARRIVED" if card.outcome == Outcome.ARRIVED.value else "DID NOT ARRIVE"
    lines = [
        f"VOYAGE REPORT  launched {card.launched:%d %b %Y}  (run seed {card.seed})",
        "=" * 64,
        f"{headline}: {CAUSES[card.cause]}",
        f"Time at sea      {card.days:.1f} days",
    ]
    if card.end_lat is not None:
        where = _pos(card.end_lat, card.end_lon)
        if card.km_to_go:
            where += f", about {card.km_to_go:,.0f} km short of the finish"
        lines.append(f"Ended at         {where}")
    lines.append(f"Distance sailed  {card.distance_sailed_km:,.0f} km over the ground")
    if card.min_soc is not None:
        lines.append(f"Lowest battery   {card.min_soc:.0%}")
    lines.append(f"Knockdowns       {card.knockdowns}")
    lines.append(
        f"Parts broken     {', '.join(card.parts_broken) if card.parts_broken else 'none'}"
    )
    if card.trouble is None:
        lines.append("Trouble started  never: a clean run")
    else:
        lines.append(f"Trouble started  day {card.trouble_day:.1f}: {card.trouble}")
    lines.append("-" * 64)
    if card.build_cost_usd is None:
        lines.append("Build cost       not priced yet (parts catalogue, #25)")
    else:
        lines.append(f"Build cost       ${card.build_cost_usd:,.0f}")
    if card.airtime_usd is not None:
        a = card.airtime_usd
        lines.append(
            f"Satellite bill   ${a['total']:,.2f} (line rental ${a['line_rental']:,.2f}, "
            f"messages ${a['messages']:,.2f}, empty mailbox checks "
            f"${a['empty_mailbox_checks']:,.2f})"
        )
    lines.append("-" * 64)
    lines.extend(textwrap.wrap(card.caveat, 64))
    return "\n".join(lines)


# ----------------------------------------------------------------- batch card


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float, float]:
    """Arrival fraction with a 95% Wilson interval, same as BatchResult.success_rate."""
    if n == 0:
        return 0.0, 0.0, 0.0
    p = k / n
    denom = 1 + z**2 / n
    centre = (p + z**2 / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z**2 / (4 * n**2)) / denom
    return p, max(0.0, centre - half), min(1.0, centre + half)


@dataclass
class MonthOdds:
    month: int  # 1..12, launch month
    runs: int
    arrived: int
    rate: float
    low: float
    high: float


@dataclass
class BatchCard:
    runs: int
    arrived: int
    rate: float
    low: float
    high: float
    days_median: float | None  # of arrivals
    days_range: tuple[float, float] | None
    causes: dict[str, int]  # cause key -> runs; empty if the batch didn't record causes
    months: list[MonthOdds] = field(default_factory=list)
    airtime_median_usd: float | None = None
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def batch_card(summary: pd.DataFrame) -> BatchCard:
    """Build the card for a Monte Carlo batch.

    Needs the `start` and `outcome` columns of BatchResult.summary; uses
    `days`, `cause` (from card_row) and `airtime_usd` when present.
    """
    n = len(summary)
    arrived_mask = summary["outcome"] == Outcome.ARRIVED.value if n else pd.Series(dtype=bool)
    k = int(arrived_mask.sum())
    rate, lo, hi = wilson(k, n)

    days_median = days_range = None
    if k and "days" in summary:
        d = summary.loc[arrived_mask, "days"].astype(float)
        days_median = round(float(d.median()), 1)
        days_range = (round(float(d.min()), 1), round(float(d.max()), 1))

    causes: dict[str, int] = {}
    if "cause" in summary and n:
        cause = summary["cause"].where(summary["outcome"] != LEFT_DATA_BOX, LEFT_DATA_BOX)
        counts = cause.value_counts()
        causes = {c: int(counts[c]) for c in CAUSES if c in counts}
        for c in counts.index:  # anything unexpected still shows up
            causes.setdefault(str(c), int(counts[c]))

    months: list[MonthOdds] = []
    if n:
        launch_month = pd.to_datetime(summary["start"]).dt.month
        for m in sorted(launch_month.unique()):
            sel = launch_month == m
            mk, mn = int(arrived_mask[sel].sum()), int(sel.sum())
            r, a, b = wilson(mk, mn)
            months.append(MonthOdds(int(m), mn, mk, r, a, b))

    airtime = None
    if "airtime_usd" in summary and summary["airtime_usd"].notna().any():
        airtime = round(float(summary["airtime_usd"].dropna().median()), 2)

    warnings = []
    if n < MIN_RUNS_FOR_ODDS:
        warnings.append(f"Only {n} runs: treat these odds as rough (aim for {MIN_RUNS_FOR_ODDS}+).")
    thin = [m for m in months if m.runs < MIN_RUNS_PER_MONTH]
    if months and thin:
        warnings.append(
            f"{len(thin)} launch month(s) have fewer than {MIN_RUNS_PER_MONTH} runs; "
            "their odds can swing a lot with more runs."
        )
    if "cause" not in summary:
        warnings.append("This batch didn't record causes of loss (add card_row to run_batch).")
    warnings.append(
        "Odds are only as good as the model: ocean currents checked against real "
        "drifters (#19); ship traffic not modelled yet (#13), so collisions are missing."
    )

    return BatchCard(
        runs=n,
        arrived=k,
        rate=rate,
        low=lo,
        high=hi,
        days_median=days_median,
        days_range=days_range,
        causes=causes,
        months=months,
        airtime_median_usd=airtime,
        warnings=warnings,
    )


_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _bar(p: float, width: int = 20) -> str:
    filled = round(p * width)
    return "#" * filled + "." * (width - filled)


def render_batch(card: BatchCard) -> str:
    """The batch card as plain text, one screen."""
    lines = [
        f"BATCH REPORT  {card.runs} simulated voyages",
        "=" * 64,
        (
            f"Chance of finishing        {card.rate:.0%}   "
            f"(95% range {card.low:.0%} to {card.high:.0%})"
        ),
        f"Arrived {card.arrived} of {card.runs}",
    ]
    if card.days_median is not None:
        a, b = card.days_range
        lines.append(
            f"Days at sea (arrivals)     median {card.days_median:.0f}, from {a:.0f} to {b:.0f}"
        )
    if card.airtime_median_usd is not None:
        lines.append(f"Satellite bill (median)    ${card.airtime_median_usd:,.2f} per voyage")
    if card.causes:
        lines.append("-" * 64)
        lines.append("How each voyage ended")
        for c, count in sorted(card.causes.items(), key=lambda kv: -kv[1]):
            label = CAUSES.get(c, c)
            lines.append(f"  {count / card.runs:4.0%}  {count:4d}  {label}")
    if card.months:
        lines.append("-" * 64)
        lines.append("Odds by launch month   (# = arrival odds, [] = 95% range)")
        for m in card.months:
            lines.append(
                f"  {_MONTHS[m.month - 1]}  {_bar(m.rate)}  {m.rate:4.0%}  "
                f"[{m.low:.0%}-{m.high:.0%}]  {m.arrived}/{m.runs}"
            )
    lines.append("-" * 64)
    for w in card.warnings:
        lines.extend(textwrap.wrap(w, 64, initial_indent="! ", subsequent_indent="  "))
    return "\n".join(lines)
