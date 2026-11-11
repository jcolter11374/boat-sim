"""Sailing tactics for boats with a polar (the 31 ft cruiser first).

A sailboat can't steer straight at a mark that lies upwind: it sails "close
hauled" at an angle to the wind and zig-zags ("tacks") from one side to the
other. Dead downwind is slow too, so it sails a little off the wind and
zig-zags the other way ("gybes"). The question every step is which angle,
and when to switch sides. This module answers it the way a racing autopilot
or a navigator with a polar does.

* **Polar.** A table of boat speed for each true wind speed and true wind
  angle (TWA, the angle between the bow and where the wind comes from). The
  boat's own model provides it (Theo's VPP for the cruiser, vessel/keelboat.py);
  `TablePolar` is a plain table lookup for tests and simple designs.
* **Best VMG angles.** VMG ("velocity made good") is the speed straight
  toward or away from the wind. From the polar, the tactician finds the angle
  that makes the most of it upwind (about 40-45 deg for a cruiser) and
  downwind (about 140-160 deg), at the wind speed now.
* **Three cases** for the bearing to the active waypoint ("the mark"):
  - inside the best upwind angle: **beat**, close hauled on one tack;
  - beyond the best downwind angle: **run**, broad reaching on one gybe;
  - anything between: **reach**, steer the normal autopilot's heading, crab
    angle included, since the boat can sail straight there.
* **When to tack or gybe.** Stay on the current side until the mark is more
  than `switch_deg` past the wind on the other side, and not sooner than
  `min_switch_h` after the last switch, so a wind shift doesn't set off a
  string of tacks. The zig-zag stays inside a cone around the mark that
  narrows as the boat closes on it, so the tacks get shorter near the mark.
* **Land ahead.** Before holding a tack or gybe, it looks `LAND_LOOKAHEAD_KM`
  along that heading. If land is that close and the other side is clearer,
  it switches now, whatever the minimum interval says (15 May 2020 replay: a
  healthy cruiser beat straight onto Pico in the Azores on one long tack).
* While beating or running, the waypoint follower's current (crab) estimate
  is frozen: the boat zig-zags on purpose, so its course over the ground says
  nothing about the current.

The vessel keeps its own physical limit (sail.sail_heading clamps any heading
inside the no-go zone). The tactician never asks for one: `min_twa_deg` sits
just outside that limit.

A design without a polar never touches this, so the kayak, Rev B/C and every
replay are unchanged. All tuning numbers are GUESSES until the cruiser has
sailed some seasons in the simulator.

Owner: Sam.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Protocol

from boatsim.autonomy.base import Autopilot
from boatsim.autonomy.sphere import wrap180
from boatsim.geo import bearing_deg, heading_to_vector, move
from boatsim.types import Command, Mission, Sensors

KN = 0.514444  # m/s per knot
LAND_LOOKAHEAD_KM = 30.0  # GUESS: about 3-4 h of sailing; more than one min_switch_h leg
LAND_STEP_KM = 2.0
LAND_CLEAR_KM = 2.0  # a point this close to the coast counts as land ahead


def open_water_km(
    lat: float,
    lon: float,
    heading: float,
    land_km: Callable[[float, float], float] | None = None,
    lookahead_km: float = LAND_LOOKAHEAD_KM,
) -> float:
    """How far the boat can sail along `heading` before it is within
    LAND_CLEAR_KM of a coast, in km; math.inf if clear for `lookahead_km`.
    `land_km(lat, lon)`: distance to land (default vessel.coast's, the same
    chart the waypoint follower uses)."""
    if land_km is None:
        from boatsim.vessel.coast import distance_to_land_km as land_km
    d = LAND_STEP_KM
    while d <= lookahead_km + 1e-9:
        east, north = heading_to_vector(heading, d * 1000.0)
        if land_km(*move(lat, lon, east, north)) < LAND_CLEAR_KM:
            return d
        d += LAND_STEP_KM
    return math.inf


class Polar(Protocol):
    def speed_ms(self, tws_ms: float, twa_deg: float) -> float:
        """Boat speed through the water (m/s) at true wind speed `tws_ms` and
        true wind angle `twa_deg` (0 = head to wind, 180 = dead downwind)."""
        ...


def _interp(xs: tuple[float, ...], x: float) -> tuple[int, float]:
    """Index i and weight w with x ~ xs[i] * (1 - w) + xs[i + 1] * w, clamped."""
    if x <= xs[0]:
        return 0, 0.0
    if x >= xs[-1]:
        return len(xs) - 2, 1.0
    i = bisect_right(xs, x) - 1
    return i, (x - xs[i]) / (xs[i + 1] - xs[i])


@dataclass(frozen=True)
class TablePolar:
    """Boat speed from a table, bilinear between rows and columns.

    `speeds_kn[i][j]` is the speed in knots at `twa_deg[i]` and `tws_kn[j]`.
    Above the top wind speed the top column holds. Below the lowest it falls
    linearly to zero in no wind. Closer to the wind than the first row it
    falls linearly to zero `pinch_deg` further up (GUESS: sails luffing).
    `factor` scales the whole table (for example, an autopilot instead of a
    racing crew)."""

    tws_kn: tuple[float, ...]
    twa_deg: tuple[float, ...]
    speeds_kn: tuple[tuple[float, ...], ...]
    factor: float = 1.0
    pinch_deg: float = 10.0

    def __post_init__(self) -> None:
        if len(self.speeds_kn) != len(self.twa_deg) or any(
            len(r) != len(self.tws_kn) for r in self.speeds_kn
        ):
            raise ValueError("speeds_kn must have one row per twa and one column per tws")

    def speed_ms(self, tws_ms: float, twa_deg: float) -> float:
        tws = tws_ms / KN
        twa = abs(wrap180(twa_deg))
        scale = self.factor
        if tws < self.tws_kn[0]:
            scale *= max(tws, 0.0) / self.tws_kn[0]
            tws = self.tws_kn[0]
        if twa < self.twa_deg[0]:
            scale *= max(0.0, 1.0 - (self.twa_deg[0] - twa) / self.pinch_deg)
            twa = self.twa_deg[0]
        i, a = _interp(self.twa_deg, twa)
        j, b = _interp(self.tws_kn, tws)
        s = self.speeds_kn
        v = (
            s[i][j] * (1 - a) * (1 - b)
            + s[i + 1][j] * a * (1 - b)
            + s[i][j + 1] * (1 - a) * b
            + s[i + 1][j + 1] * a * b
        )
        return v * scale * KN


@dataclass
class VmgAngles:
    """Best VMG angles from a polar, cached by wind speed (0.25 m/s bins)."""

    polar: Polar
    min_twa_deg: float = 0.0  # never closer than this (the vessel's no-go limit plus a margin)
    max_twa_deg: float = 180.0  # never deeper than this
    step_deg: float = 0.5
    _cache: dict[int, tuple[float, float]] = field(default_factory=dict, repr=False)

    def __call__(self, tws_ms: float) -> tuple[float, float]:
        """(best upwind TWA, best downwind TWA) in degrees."""
        key = round(tws_ms * 4)
        hit = self._cache.get(key)
        if hit is None:
            tws = key / 4
            hit = self._cache[key] = (self._best(tws, 1.0), self._best(tws, -1.0))
        return hit

    def _best(self, tws: float, sign: float) -> float:
        lo, hi = (max(self.min_twa_deg, 1.0), 90.0) if sign > 0 else (90.0, self.max_twa_deg)
        n = max(1, round((hi - lo) / self.step_deg))
        best, best_vmg = (lo if sign > 0 else hi), -math.inf
        for k in range(n + 1):
            a = lo + (hi - lo) * k / n
            vmg = sign * self.polar.speed_ms(tws, a) * math.cos(math.radians(a))
            if vmg > best_vmg + 1e-12:
                best, best_vmg = a, vmg
        return best


@dataclass
class Tactician:
    """Picks the heading toward a mark from the wind and the polar."""

    polar: Polar
    min_twa_deg: float = 0.0  # vessel's no-go limit plus a margin; the beat never goes closer
    beat_margin_deg: float = 3.0  # GUESS: waves make the best angle a little wider than flat water
    switch_deg: float = 10.0  # GUESS: tack once the mark is this far past the wind
    min_switch_h: float = 2.0  # GUESS: at least this long on one tack or gybe
    max_twa_deg: float = 180.0

    def __post_init__(self) -> None:
        self.angles = VmgAngles(self.polar, self.min_twa_deg, self.max_twa_deg)
        self.reset()

    def reset(self) -> None:
        self.mode = "reach"  # "beat", "run" or "reach"
        self.side = (
            0  # +1: wind on the port bow side (heading = wind + angle), -1 the other, 0 unknown
        )
        self.last_switch: datetime | None = None
        self.switches = 0  # tacks plus gybes, for logging and tests

    def heading(
        self,
        to_mark: float,
        reach_heading: float,
        wind_from: float,
        tws: float,
        prev_heading: float,
        t: datetime,
        open_water: Callable[[float], float] | None = None,
    ) -> float:
        """Heading through the water. `to_mark`: bearing to the mark (deg);
        `reach_heading`: what the normal autopilot would steer (with its crab);
        `prev_heading`: the boat's heading now (for which tack it is on);
        `open_water(heading)`: km of open water along a heading (open_water_km
        at the boat), or None to sail without a chart."""
        up, down = self.angles(tws)
        up = min(up + self.beat_margin_deg, 89.0)
        rel = wrap180(to_mark - wind_from)  # where the mark is, off the wind
        if abs(rel) < up:
            mode, angle, past = "beat", up, abs(rel)
        elif abs(rel) > down:
            mode, angle, past = "run", down, 180.0 - abs(rel)
        else:
            self.mode = "reach"
            self.side = 1 if wrap180(reach_heading - wind_from) >= 0.0 else -1
            return reach_heading % 360.0
        mark_side = 1 if rel >= 0.0 else -1
        side = self.side or (1 if wrap180(prev_heading - wind_from) >= 0.0 else -1)
        if self.mode != mode:
            # Just started beating or running: take the side the mark is on,
            # which is also the side nearer the course being sailed.
            side = mark_side
        elif side != mark_side and past > self.switch_deg:
            settled = self.last_switch is None or t - self.last_switch >= timedelta(
                hours=self.min_switch_h
            )
            if settled:
                side = mark_side
        if open_water is not None:
            # Never hold a tack or gybe onto land when the other side is clearer.
            here = open_water((wind_from + side * angle) % 360.0)
            if here < LAND_LOOKAHEAD_KM and open_water((wind_from - side * angle) % 360.0) > here:
                side = -side
        if self.side and side != self.side and self.mode == mode:
            self.last_switch = t
            self.switches += 1
        self.mode, self.side = mode, side
        return (wind_from + side * angle) % 360.0


class SailingAutopilot:
    """Wraps an autopilot (waypoint follower, safe mode) for a boat with a polar:
    it beats and runs with the Tactician, and reaches on the inner heading.

    `guidance` is the inner autopilot's WaypointAutopilot, so its current
    estimate can be frozen while tacking. Without a wind vane reading
    (Sensors.wind_from_deg is None) it passes the inner command through."""

    def __init__(
        self,
        inner: Autopilot,
        tactician: Tactician,
        guidance=None,
        land_km: Callable[[float, float], float] | None = None,
    ):
        """land_km(lat, lon): distance to land for the look-ahead (default the
        coast chart, vessel.coast.distance_to_land_km)."""
        self.inner = inner
        self.land_km = land_km
        self.tactician = tactician
        self.guidance = guidance

    def reset(self) -> None:
        for part in (self.inner, self.tactician):
            r = getattr(part, "reset", None)
            if r is not None:
                r()

    def on_message_received(self, t: datetime) -> None:
        notify = getattr(self.inner, "on_message_received", None)
        if notify is not None:
            notify(t)

    def update(self, sensors: Sensors, mission: Mission, t: datetime) -> Command:
        cmd = self.inner.update(sensors, mission, t)
        if sensors.wind_from_deg is None or sensors.wind_speed_ms is None or not sensors.gps_ok:
            return cmd
        if not mission.waypoints:
            return cmd
        wp = mission.waypoints[min(mission.active_index, len(mission.waypoints) - 1)]
        to_mark = bearing_deg(sensors.lat, sensors.lon, wp.lat, wp.lon)
        heading = self.tactician.heading(
            to_mark,
            cmd.heading,
            sensors.wind_from_deg,
            sensors.wind_speed_ms,
            sensors.heading,
            t,
            open_water=lambda h: open_water_km(sensors.lat, sensors.lon, h, self.land_km),
        )
        if self.guidance is not None:
            self.guidance.tacking = self.tactician.mode != "reach"
        return Command(heading=heading, thrust_fraction=cmd.thrust_fraction)


NO_GO_MARGIN_DEG = 1.0  # GUESS: beat this far outside the vessel's own no-go clamp


def tactician_for(vessel) -> Tactician | None:
    """A Tactician for `vessel` if it has a polar (`vessel.polar`), else None.
    The beat stays NO_GO_MARGIN_DEG outside the vessel's no-go limit
    (`vessel.sail.min_upwind_twa_deg`), so the vessel never has to clamp it."""
    polar = getattr(vessel, "polar", None)
    if polar is None:
        return None
    sail = getattr(vessel, "sail", None)
    no_go = getattr(sail, "min_upwind_twa_deg", 0.0) if sail is not None else 0.0
    deep = getattr(sail, "min_downwind_twa_deg", 180.0) if sail is not None else 180.0
    return Tactician(
        polar,
        min_twa_deg=no_go + NO_GO_MARGIN_DEG,
        max_twa_deg=max(90.0, deep - NO_GO_MARGIN_DEG),
    )


def wrap_for_sailing(autopilot, vessel):
    """`autopilot` wrapped in a SailingAutopilot when `vessel` has a polar;
    otherwise `autopilot` itself (the kayak, Rev B/C: unchanged)."""
    tac = tactician_for(vessel)
    if tac is None:
        return autopilot
    from boatsim.autonomy.guidance import WaypointAutopilot

    guidance = autopilot if isinstance(autopilot, WaypointAutopilot) else None
    return SailingAutopilot(autopilot, tac, guidance=getattr(autopilot, "guidance", guidance))
