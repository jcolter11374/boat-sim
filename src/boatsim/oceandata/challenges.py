"""Weather challenges: famous stretches of real weather to sail the kayak into.

Each challenge is a real start date. The kayak is dropped at the usual point at
noon on that day and sails up to 150 days (sandbox.run.MAX_DAYS) of that
year's real weather. Dates and storm facts were checked against NOAA's best
tracks (IBTrACS v04r01, workflow "Challenge storm dates", run 42953010122) and,
for the winter storms, ERA5 itself (weather-challenges-draft.md).

The 2020 spring launches are already in the Boatyard bundle (forcing_2020.npz).
Every other challenge gets its own bundle, built by the "Challenge data"
workflow in the same format as the season bundle (sandbox/forcing.py) over
start - 1 day to start + 155 days (150 days of sailing plus the forecast
look-ahead), and published on the challenge-data release with challenges.json.

Hurricanes: ERA5 shows hurricane winds at about 40-65% of their real strength
(#117), so the storms in challenges 3-7 are weaker in the simulator than they
were. Their waves are less affected (ERA5's wind sea still reached 13.4 m in
September 2020). Each of those challenges carries ``hurricane: true``, a
``weather_note`` for the page, and ``storm_boost: true``: the hook for the
game to switch on Theo's storm boost (#117) once it lands.

    python -m boatsim.oceandata.challenges catalog --out site/challenges.json
    python -m boatsim.oceandata.challenges matrix     # JSON list for Actions
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from itertools import pairwise
from pathlib import Path

SEASON_BUNDLE = "forcing_2020.npz"
DAYS_BEFORE = 1
DAYS_AFTER = 155  # 150 days of sailing + 5 days of forecast look-ahead
STORM_NOTE = "Storm winds approximate (ERA5 smooths hurricanes)"

# Sandy's centre, 6-hourly, 22 Oct 12 UTC to 31 Oct 12 UTC 2012: (iso time, lat, lon).
# GUESS: typed from memory of NHC's report, not yet checked. The "Challenge storm
# dates" workflow compares these with IBTrACS on every PR that touches them, prints the
# real points, and fails if any is more than TRACK_TOLERANCE_KM off (storm_dates.py).
SANDY_TRACK_6H: list[tuple[str, float, float]] = [
    ("2012-10-22T12:00:00Z", 13.1, -78.0),
    ("2012-10-22T18:00:00Z", 12.7, -78.3),
    ("2012-10-23T00:00:00Z", 12.6, -78.4),
    ("2012-10-23T06:00:00Z", 13.0, -78.0),
    ("2012-10-23T12:00:00Z", 13.7, -77.8),
    ("2012-10-23T18:00:00Z", 14.6, -77.5),
    ("2012-10-24T00:00:00Z", 15.6, -77.1),
    ("2012-10-24T06:00:00Z", 16.6, -76.9),
    ("2012-10-24T12:00:00Z", 17.2, -76.8),
    ("2012-10-24T18:00:00Z", 17.7, -76.6),
    ("2012-10-25T00:00:00Z", 18.9, -76.4),
    ("2012-10-25T06:00:00Z", 20.1, -76.0),
    ("2012-10-25T12:00:00Z", 21.7, -75.5),
    ("2012-10-25T18:00:00Z", 23.3, -75.3),
    ("2012-10-26T00:00:00Z", 24.8, -75.9),
    ("2012-10-26T06:00:00Z", 25.7, -76.4),
    ("2012-10-26T12:00:00Z", 26.4, -76.9),
    ("2012-10-26T18:00:00Z", 27.0, -77.2),
    ("2012-10-27T00:00:00Z", 27.5, -77.1),
    ("2012-10-27T06:00:00Z", 28.1, -76.9),
    ("2012-10-27T12:00:00Z", 28.8, -76.5),
    ("2012-10-27T18:00:00Z", 29.7, -75.6),
    ("2012-10-28T00:00:00Z", 30.5, -74.7),
    ("2012-10-28T06:00:00Z", 31.3, -73.9),
    ("2012-10-28T12:00:00Z", 32.0, -72.9),
    ("2012-10-28T18:00:00Z", 33.1, -71.6),
    ("2012-10-29T00:00:00Z", 34.5, -70.8),
    ("2012-10-29T06:00:00Z", 35.9, -70.6),
    ("2012-10-29T12:00:00Z", 37.5, -71.5),
    ("2012-10-29T18:00:00Z", 38.8, -73.1),
    ("2012-10-30T00:00:00Z", 39.5, -74.7),
    ("2012-10-30T06:00:00Z", 39.9, -76.2),
    ("2012-10-30T12:00:00Z", 40.1, -77.8),
    ("2012-10-30T18:00:00Z", 40.4, -78.9),
    ("2012-10-31T00:00:00Z", 40.7, -79.8),
    ("2012-10-31T06:00:00Z", 41.0, -80.3),
    ("2012-10-31T12:00:00Z", 41.3, -80.5),
]


def _t(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", ""))


def hourly(track: list[tuple[str, float, float]]) -> list[list]:
    """A 6-hourly track as hourly [iso, lat, lon], straight lines between fixes, so a
    fast storm can't slip between rows (Ravi's judge and the page use the same points)."""
    out: list[list] = []
    for (ta, la, lo), (tb, lb, lob) in pairwise(track):
        a, b = _t(ta), _t(tb)
        n = round((b - a).total_seconds() / 3600)
        for k in range(n):
            f = k / n
            t = a + timedelta(hours=k)
            out.append(
                [t.isoformat() + "Z", round(la + f * (lb - la), 3), round(lo + f * (lob - lo), 3)]
            )
    ta, la, lo = track[-1]
    out.append([ta, la, lo])
    return out


def storm_at(track: list[list], t: datetime) -> tuple[float, float] | None:
    """The storm centre at `t` from an hourly track, or None outside it."""
    if not track:
        return None
    t0 = _t(track[0][0])
    i = (t - t0).total_seconds() / 3600
    if i < 0 or i > len(track) - 1:
        return None
    k = min(int(i), len(track) - 2) if len(track) > 1 else 0
    f = i - k
    if len(track) == 1:
        return track[0][1], track[0][2]
    a, b = track[k], track[k + 1]
    return a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])


@dataclass(frozen=True)
class Challenge:
    id: str
    n: int  # place in the list; "0" is the bonus
    title: str
    start: date  # the drop is at noon UTC
    story: str  # plain words, for John and the page
    hurricane: bool = False  # winds weaker than real in ERA5 (#117)
    season: bool = False  # inside the 2020 Boatyard bundle already
    # A mission (Sandy's shadow first: sandy-first-mission-plan.md): the deadline, the
    # storm to keep clear of, the stars and the debrief. The page and sandbox/helm.py
    # both read it from challenges.json / goal_record(); None for an open crossing.
    goal: dict | None = None

    def goal_record(self) -> dict | None:
        """The goal as the page reads it: the storm track hourly."""
        if self.goal is None:
            return None
        g = {k: v for k, v in self.goal.items() if k != "storm"}
        if "storm" in self.goal:
            st = self.goal["storm"]
            g["storm"] = {
                **{k: v for k, v in st.items() if k != "track_6h"},
                "track": hourly(st["track_6h"]),
            }
        return g

    @property
    def bundle(self) -> str:
        return SEASON_BUNDLE if self.season else f"challenge_{self.id}.npz"

    @property
    def seed(self) -> int:
        """Fixed per challenge, apart from the season launches' seeds (sandbox.run)."""
        return self.start.year * 1000 + 500 + self.n

    def window(self) -> tuple[date, date]:
        return self.start - timedelta(days=DAYS_BEFORE), self.start + timedelta(days=DAYS_AFTER)

    def record(self) -> dict:
        d = asdict(self)
        d["start"] = (
            datetime(self.start.year, self.start.month, self.start.day, 12).isoformat() + "Z"
        )
        d["first"], d["last"] = (str(x) for x in self.window())
        d["bundle"], d["seed"] = self.bundle, self.seed
        # The page shows the note; the game turns on Theo's storm boost (#117,
        # a Holland/Young vortex behind a flag) for these once it lands.
        d["weather_note"] = STORM_NOTE if self.hurricane else ""
        d["storm_boost"] = self.hurricane
        d["goal"] = self.goal_record()
        if d["goal"] is None:
            del d["goal"]
        return d


CHALLENGES: list[Challenge] = [
    Challenge(
        "gentle-june",
        1,
        "Gentle June",
        date(2020, 6, 15),
        "A kind summer. The seas never top 3 m, and the stock kayak finishes in about 64 days.",
        season=True,
    ),
    Challenge(
        "spring-gale",
        2,
        "Spring gale",
        date(2020, 4, 1),
        "An early start into a late-season gale: 43 knot winds and 6.7 m seas. The stock "
        "kayak is lost on day 72.",
        season=True,
    ),
    Challenge(
        "sandys-shadow",
        3,
        "Sandy's shadow",
        date(2012, 10, 22),
        "Hurricane Sandy comes up the coast a week after the drop. It is 400 km off Cape "
        "Hatteras on 29 October and comes ashore in New Jersey that night.",
        hurricane=True,
        # Ravi's stars from real runs, retuned (250/300 km, Elena approved); Rosa's page shape.
        goal={
            "until": "2012-10-31T12:00:00Z",
            "storm": {"name": "Sandy", "track_6h": SANDY_TRACK_6H, "clear_km": 250, "well_km": 300},
            "stars3": {"east_of": -68.0, "battery_min": 0.2},
            "call_day": 3,
            "debrief": {
                "text": "Sandy came ashore in New Jersey on the evening of 29 October 2012.",
                "url": "https://www.nhc.noaa.gov/data/tcr/AL182012_Sandy.pdf",
            },
        },
    ),
    Challenge(
        "dorian",
        4,
        "Dorian runs the coast",
        date(2019, 9, 1),
        "Hurricane Dorian, a Category 2 by then, brushes Cape Hatteras on 6 September and "
        "races on to Nova Scotia the next day.",
        hurricane=True,
    ),
    Challenge(
        "bermuda-double",
        5,
        "Bermuda double",
        date(2020, 9, 1),
        "Two hurricanes in a week: Paulette passes right over Bermuda on 14 September, and "
        "Teddy passes 265 km off it on the 21st.",
        hurricane=True,
    ),
    Challenge(
        "lorenzo",
        6,
        "Lorenzo at the Azores",
        date(2019, 7, 25),
        "A late-July start reaches the eastern Atlantic as Lorenzo, the farthest-east "
        "Category 5 on record, crosses the western Azores on 2 October.",
        hurricane=True,
    ),
    Challenge(
        "ophelia",
        7,
        "Ophelia at the finish",
        date(2017, 8, 5),
        "Hurricane Ophelia turns up near the finish: a Category 3 about 470 km south-east "
        "of the Azores on 14 October, then a storm off Ireland on the 16th.",
        hurricane=True,
    ),
    Challenge(
        "winter-train",
        8,
        "Winter storm train",
        date(2013, 12, 1),
        "The winter of 2013-14: a dozen big lows in a row. 'Hercules' raised 17.9 m seas on "
        "5 January, two and a half times what sank the stock kayak in the spring gale.",
    ),
    Challenge(
        "bay-mouth",
        0,
        "Dead at the Bay mouth",
        date(2023, 5, 15),
        "A late-spring drop where wind and current push hard toward the coast. In our "
        "drift test (#90) a kayak with dead motors washed into Hampton Roads in 9.6 days. "
        "Can you keep yours clear?",
    ),
]


def by_id(cid: str) -> Challenge:
    for c in CHALLENGES:
        if c.id == cid:
            return c
    raise KeyError(cid)


def catalog() -> dict:
    return {
        "challenges": [c.record() for c in CHALLENGES],
        "notes": (
            "Drop at noon UTC at the usual point; up to 150 days of that year's real "
            "weather (ERA5) and currents (GLORYS12). Hurricane winds in ERA5 are weaker "
            "than real (#117)."
        ),
    }


def matrix() -> list[dict]:
    """The challenges that need their own bundle, with the months and days to fetch."""
    out = []
    for c in CHALLENGES:
        if c.season:
            continue
        a, b = c.window()
        out.append(
            {
                "id": c.id,
                "first": str(a),
                "last": str(b),
                "months": [f"{a.year:04d}-{a.month:02d}", f"{b.year:04d}-{b.month:02d}"],
                "storm_boost": c.hurricane,  # the bake job then packs the storm tracks
            }
        )
    return out


def main(argv: list[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Weather challenge list")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("catalog")
    c.add_argument("--out", required=True)
    sub.add_parser("matrix")
    a = ap.parse_args(argv)
    if a.cmd == "catalog":
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(json.dumps(catalog(), indent=1))
    else:
        print(json.dumps(matrix()))


if __name__ == "__main__":
    main()
