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
from pathlib import Path

SEASON_BUNDLE = "forcing_2020.npz"
DAYS_BEFORE = 1
DAYS_AFTER = 155  # 150 days of sailing + 5 days of forecast look-ahead
STORM_NOTE = "Storm winds approximate (ERA5 smooths hurricanes)"


@dataclass(frozen=True)
class Challenge:
    id: str
    n: int  # place in the list; "0" is the bonus
    title: str
    start: date  # the drop is at noon UTC
    story: str  # plain words, for John and the page
    hurricane: bool = False  # winds weaker than real in ERA5 (#117)
    season: bool = False  # inside the 2020 Boatyard bundle already

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
