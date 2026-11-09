"""What counts as a finish: the Microtransat Challenge rules (John, 2026-11-09).

John asked us to follow the Microtransat Challenge rules for the start, the
finish and what counts. Source: the 2021 rules (the current set; they roll
forward until reviewed), https://sourceforge.net/p/microtransat/wiki/2021%20rules

* Start: an America-to-Europe boat starts when it crosses the western line
  (WEST_LINE below). Our drop point, 15 nm off the Bay mouth, is west of it,
  so the boat crosses it on its way out.
* Finish: before departure the team picks a circular target, 25 km in radius,
  centred on the eastern line (EAST_LINE). The boat finishes when it is within
  25 km of that centre, from any direction, and logs or transmits a position
  there.
* Lines are joined by straight lines between the listed points, in plain
  latitude/longitude ("linear interpolation").
* Silence: a boat that doesn't transmit for more than 10 days in a row, or for
  more than 15 days in total, is disqualified.
* Aground: a boat may get off again on its own. A 3 m kayak can't, so in the
  simulator running ashore anywhere, Europe included, ends the voyage.

Class and division we enter, for the record: "non-sailing" (any propulsion,
so solar-electric is fine) and "unmanned" (base may send new waypoints).
The rules also cap length at 2.4 m; the v4 kayak is 3.05 m, so it follows the
rules' course and finish but wouldn't be an eligible entry.

This replaces "any landfall in Europe, Azores included": the Azores lie west
of the eastern line, so they are no longer a finish.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass

from boatsim.geo import distance_m

# (lat, lon) points, in the order the rules list them.
WEST_LINE = [
    (48.0, -47.0),
    (45.5, -47.0),
    (40.0, -65.0),
    (30.0, -77.0),
    (20.0, -59.0),
    (10.0, -56.0),
]
EAST_LINE = [
    (55.0, -16.0),
    (51.0, -16.0),
    (46.0, -11.0),
    (44.5, -13.5),
    (37.0, -13.5),
    (35.0, -20.5),
    (25.0, -22.0),
]

TARGET_RADIUS_M = 25_000.0
SILENT_DAYS_IN_A_ROW = 10.0
SILENT_DAYS_TOTAL = 15

# Our pick for the target centre: on the eastern line due west of Lisbon
# (39.5N 13.5W, on the 44.5N-37N leg), about 330 km off the Portuguese coast.
DEFAULT_TARGET = (39.5, -13.5)


def _cross(o, a, b) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _segments_cross(p1, p2, q1, q2) -> bool:
    d1, d2 = _cross(q1, q2, p1), _cross(q1, q2, p2)
    d3, d4 = _cross(p1, p2, q1), _cross(p1, p2, q2)
    return (d1 > 0) != (d2 > 0) and (d3 > 0) != (d4 > 0)


def crosses(line, prev: tuple[float, float], cur: tuple[float, float]) -> bool:
    """Did the step from prev to cur (lat, lon) cross the polyline?"""
    return any(_segments_cross(prev, cur, a, b) for a, b in itertools.pairwise(line))


def distance_to_line_deg(line, lat: float, lon: float) -> float:
    """Shortest distance in degrees (lat/lon plane) from a point to the polyline."""
    best = float("inf")
    for (a0, a1), (b0, b1) in itertools.pairwise(line):
        dx, dy = b0 - a0, b1 - a1
        t = max(0.0, min(1.0, ((lat - a0) * dx + (lon - a1) * dy) / (dx * dx + dy * dy)))
        px, py = a0 + t * dx, a1 + t * dy
        best = min(best, ((lat - px) ** 2 + (lon - py) ** 2) ** 0.5)
    return best


@dataclass(frozen=True)
class FinishTarget:
    """The 25 km circle the boat must reach. Its centre must be on the eastern line."""

    lat: float = DEFAULT_TARGET[0]
    lon: float = DEFAULT_TARGET[1]
    radius_m: float = TARGET_RADIUS_M

    def __post_init__(self):
        if distance_to_line_deg(EAST_LINE, self.lat, self.lon) > 0.01:
            raise ValueError(
                f"finish target {self.lat}, {self.lon} is not on the Microtransat eastern line"
            )

    def reached(self, lat: float, lon: float) -> bool:
        return distance_m(lat, lon, self.lat, self.lon) <= self.radius_m

    @classmethod
    def from_voyage(cls, voyage: dict) -> FinishTarget:
        """From the design config's voyage section (finish_lat, finish_lon)."""
        return cls(
            float(voyage.get("finish_lat", DEFAULT_TARGET[0])),
            float(voyage.get("finish_lon", DEFAULT_TARGET[1])),
        )


class SilenceClock:
    """Tracks the rules' transmit limits: >10 days in a row or >15 in total."""

    def __init__(self, start):
        self.start = start
        self.last_tx = start
        self.days_heard: set[int] = set()
        self._checked_day, self._silent = -1, 0

    def heard(self, t) -> None:
        self.last_tx = max(self.last_tx, t)
        self.days_heard.add(int((t - self.start).total_seconds() // 86400))

    def silent_total(self, t) -> int:
        """Whole days, finished before t, with no transmission at all."""
        done = int((t - self.start).total_seconds() // 86400)
        return sum(1 for d in range(done) if d not in self.days_heard)

    def disqualified(self, t) -> str | None:
        if (t - self.last_tx).total_seconds() > SILENT_DAYS_IN_A_ROW * 86400:
            return f"silent more than {SILENT_DAYS_IN_A_ROW:.0f} days in a row"
        day = int((t - self.start).total_seconds() // 86400)
        if day != self._checked_day:  # the total only changes once a day
            self._checked_day, self._silent = day, self.silent_total(t)
        if self._silent > SILENT_DAYS_TOTAL:
            return f"silent more than {SILENT_DAYS_TOTAL} days in total"
        return None
