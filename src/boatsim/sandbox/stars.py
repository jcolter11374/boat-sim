"""Stars for the weather challenges (Ravi, QA; plan: simulator/gameplay/sandy-first-mission-plan.md,
approved by Elena 12 Nov 2026).

A pure judge: the boat's logged track (hourly or finer) plus the storm's best
track in, 0 to 3 stars out. Stars stack: two needs one, three needs two. It is
scored on the hourly track, with the storm centre interpolated to each row's
time, so a fast storm can't slip between 6-hourly points (Rosa).

The thresholds were set from runs in the challenge's own weather, so that a
well-played run earns three stars and the autopilot ghost alone never does.
"""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from datetime import datetime
from itertools import pairwise

from boatsim.geo import distance_m

# Outcomes that mean the boat is no longer sailing (sandbox.helm OUTCOME keys).
NOT_SAILING = {"lost", "sunk", "aground", "landfall", "disqualified"}


@dataclass(frozen=True)
class StormStars:
    """Sandy's shadow and its kind: keep clear of a storm and run the right way."""

    storm: str  # IBTrACS NAME
    season: int
    goal_km: float  # ★: never closer than this to the centre, and still sailing at the end
    clear_km: float  # ★★: never closer than this
    east_of: float  # ★★★: end east of this longitude ...
    soc_min: float  # ... with the battery never below this share


# Set from the CI run on Sandy's best track (PR #389, 12 Nov): running east keeps 315 to 385 km
# from the centre, south 338 km, south-east 186 to 259 km; the ghost's usual route passes 16 km
# from it, so the ghost earns no stars here. The first plan's 300/400 km left no ★★ at all.
SANDY = StormStars(
    storm="SANDY", season=2012, goal_km=250.0, clear_km=300.0, east_of=-68.0, soc_min=0.20
)
RULES = {"sandys-shadow": SANDY}


def _t(x) -> datetime:
    if isinstance(x, datetime):
        return x.replace(tzinfo=None)
    return datetime.fromisoformat(str(x).replace("Z", "")).replace(tzinfo=None)


def storm_track(csv_path, name: str, season: int) -> list[tuple[datetime, float, float]]:
    """Every best-track point of one storm, (time, lat, lon), in time order. All
    points count, before and after it is a hurricane: the centre is the centre."""
    out = []
    with open(csv_path, newline="") as f:
        rows = csv.DictReader(f)
        for r in rows:
            if r.get("NAME", "").strip() != name or r.get("SEASON", "").strip() != str(season):
                continue
            try:
                out.append((_t(r["ISO_TIME"]), float(r["LAT"]), float(r["LON"])))
            except (ValueError, KeyError):
                continue  # the units row, or a gap
    out.sort()
    return out


def storm_track_from(points) -> list[tuple[datetime, float, float]]:
    """A goal record's track ([iso, lat, lon], challenges.hourly) in the judge's form (Sam)."""
    return sorted((_t(t), float(lat), float(lon)) for t, lat, lon in points)


def centre_at(track, t: datetime) -> tuple[float, float] | None:
    """The storm centre at t, straight-line between best-track points; None outside the track."""
    t = _t(t)
    if not track or t < track[0][0] or t > track[-1][0]:
        return None
    for (t0, a0, o0), (t1, a1, o1) in pairwise(track):
        if t0 <= t <= t1:
            f = 0.0 if t1 == t0 else (t - t0).total_seconds() / (t1 - t0).total_seconds()
            return a0 + f * (a1 - a0), o0 + f * (o1 - o0)
    return track[-1][1], track[-1][2]


def closest_km(rows, track) -> float:
    """Closest approach of the boat's rows (t, lat, lon) to the storm centre, km."""
    best = math.inf
    for r in rows:
        c = centre_at(track, r["t"])
        if c is not None:
            best = min(best, distance_m(r["lat"], r["lon"], c[0], c[1]) / 1000.0)
    return best


def judge(rows, outcome: str, track, rule: StormStars) -> dict:
    """Stars for one run: rows are the boat's logged track (t, lat, lon, soc),
    outcome its result at the end. Returns the stars and the numbers behind them."""
    near = closest_km(rows, track)
    socs = [r["soc"] for r in rows if r.get("soc") is not None]
    low = min(socs) if socs else 0.0
    end = rows[-1] if rows else {"lon": -math.inf}
    sailing = outcome not in NOT_SAILING
    one = sailing and near > rule.goal_km
    two = one and near > rule.clear_km
    three = two and end["lon"] > rule.east_of and low >= rule.soc_min
    return {
        "stars": int(one) + int(two) + int(three),
        "closest_km": round(near, 1),
        "end_lon": round(end["lon"], 2),
        "battery_low": round(low, 3),
        "sailing": sailing,
    }
