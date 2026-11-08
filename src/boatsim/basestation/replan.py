"""Scripted base-station replanning: look at the forecast, and only when it
clearly pays, send the boat a new next waypoint.

What a person at base would do each morning, written down as a rule:

1. Read the boat's daily report (where it is, how full its battery is).
2. Look at a fan of possible next legs: straight on toward the planned route,
   and angled up to 60° either side of it.
3. For each, use the forecast (currents and wind) to estimate where the boat
   would be in 3 days if it followed that leg. The autopilot holds its line by
   angling into the current, so the estimate does the same: a following current
   speeds the boat along the line, a head current slows it, and a side current
   too strong to angle against pushes it off.
4. Score each leg by the estimated time to the end of the route: the 3 days,
   plus the distance still to go divided by the speed the boat would make good
   toward the goal in the water it ends up in. That way a leg that steps out of
   a foul current scores well even if it doesn't gain much distance at first.
   If the best leg beats "carry on as planned" by at least `min_gain_h`, send
   it as a new route.
5. Never send more than one new route per `min_interval` (a day by default).
6. Otherwise, once a day, send a tiny "all well, carry on" message: the same
   route again. The boat checks its mailbox daily anyway, and an empty check
   costs one credit, so this ack costs nothing extra. It tells safe mode that
   base is alive, so it doesn't drop into lost-comms mode on a quiet voyage.

The forecast it reads already contains realistic error (oceandata's Forecast),
so it can't cheat by seeing the future.

Owner: Sam.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from boatsim.autonomy.sphere import destination
from boatsim.geo import bearing_deg, distance_m, move
from boatsim.oceandata.base import Environment
from boatsim.types import Mission, Waypoint


def _ground_velocity(heading_deg: float, speed: float, ce: float, cn: float) -> tuple[float, float]:
    """Ground velocity (east, north) of a boat holding a line on `heading_deg`
    with water speed `speed` in a current (ce, cn), crabbing as needed."""
    h = math.radians(heading_deg)
    ue, un = math.sin(h), math.cos(h)  # along the line
    along = ce * ue + cn * un
    cross = ce * un - cn * ue  # current component to the right of the line
    if speed > abs(cross):
        # Crab enough to cancel the side current; the rest of the speed goes forward.
        g = along + math.sqrt(speed * speed - cross * cross)
        return g * ue, g * un
    # Side current wins: all effort goes against it, the remainder pushes the boat off.
    side = cross - math.copysign(speed, cross)
    return along * ue + side * un, along * un - side * ue


@dataclass
class ForecastReplanPolicy:
    """Implements `BasePolicy`. All tuning numbers are GUESSES."""

    route: list[Waypoint]  # the planned route; its last point is the goal
    boat_speed: float = 0.87  # m/s; GUESS: design cruise 1.7 kt in calm water
    windage: float = 0.02  # GUESS: wind drift as a fraction of wind speed (leeway)
    horizon: timedelta = timedelta(days=3)  # GUESS: forecast skill fades after ~3 days
    step: timedelta = timedelta(hours=3)
    offsets_deg: tuple[float, ...] = (-60, -45, -30, -15, 0, 15, 30, 45, 60)
    min_gain_h: float = 6.0  # GUESS: below this a correction isn't worth a route change
    daily_ack: bool = True  # resend the current route as an "all well" ack
    min_interval: timedelta = timedelta(hours=24)
    east_margin_deg: float = 0.05  # waypoints this far west of the boat are behind it
    low_soc: float = 0.5  # below this, safe mode throttles back; assume slower
    sent: list[tuple[datetime, Mission]] = field(default_factory=list)  # route changes
    acks: list[datetime] = field(default_factory=list)
    _current: list[Waypoint] | None = None

    # ---------------------------------------------------------------- helpers

    def _ahead(self, lon: float) -> list[Waypoint]:
        ahead = [w for w in self.route if w.lon > lon + self.east_margin_deg]
        return ahead or [self.route[-1]]

    def _speed(self, soc: float) -> float:
        # Safe mode (autonomy/safemode.py) runs at 60% power below 50% charge;
        # speed goes roughly with the cube root of power. GUESS.
        return self.boat_speed * (0.6 ** (1 / 3) if soc < self.low_soc else 1.0)

    def predict(
        self,
        forecast: Environment,
        t0: datetime,
        lat: float,
        lon: float,
        wp: Waypoint,
        speed: float,
    ) -> tuple[float, float]:
        """Where the boat is after `horizon`, holding the line toward wp."""
        t, n = t0, int(self.horizon / self.step)
        secs = self.step.total_seconds()
        for _ in range(n):
            if distance_m(lat, lon, wp.lat, wp.lon) < speed * secs:
                break
            env = forecast.sample(t, lat, lon)
            ce = env.current_u + self.windage * env.wind_u
            cn = env.current_v + self.windage * env.wind_v
            ve, vn = _ground_velocity(bearing_deg(lat, lon, wp.lat, wp.lon), speed, ce, cn)
            lat, lon = move(lat, lon, ve * secs, vn * secs)
            t += self.step
        return lat, lon

    # -------------------------------------------------------------- interface

    def _time_to_goal(
        self,
        forecast: Environment,
        t0: datetime,
        lat: float,
        lon: float,
        wp: Waypoint,
        speed: float,
    ) -> float:
        """Seconds to the goal: follow wp for the horizon, then head straight for the goal."""
        goal = self.route[-1]
        plat, plon = self.predict(forecast, t0, lat, lon, wp, speed)
        left = distance_m(plat, plon, goal.lat, goal.lon)
        env = forecast.sample(t0 + self.horizon, plat, plon)
        ce = env.current_u + self.windage * env.wind_u
        cn = env.current_v + self.windage * env.wind_v
        ve, vn = _ground_velocity(bearing_deg(plat, plon, goal.lat, goal.lon), speed, ce, cn)
        made_good = max(math.hypot(ve, vn), 0.05 * speed)  # never divide by ~0
        return self.horizon.total_seconds() + left / made_good

    def on_report(self, report: dict, forecast: Environment) -> Mission | None:
        t = datetime.fromisoformat(report["t"])
        last = max([s[0] for s in self.sent] + self.acks, default=None)
        if last is not None and t < last:
            # Time went backwards: a new voyage reusing this policy (batch runs).
            self.sent, self.acks, self._current = [], [], None
        last = max([s[0] for s in self.sent] + self.acks, default=None)
        if last is not None and t - last < self.min_interval:
            return None
        lat, lon, soc = report["lat"], report["lon"], report.get("soc", 1.0)
        speed = self._speed(soc)
        ahead = self._ahead(lon)
        current = self._current or ahead
        nxt = next((w for w in current if w.lon > lon + self.east_margin_deg), current[-1])
        # Candidate legs are no longer than the next waypoint is far, so a
        # detour never sends the boat past where it's going.
        reach = min(speed * self.horizon.total_seconds(), distance_m(lat, lon, nxt.lat, nxt.lon))

        base = self._time_to_goal(forecast, t, lat, lon, nxt, speed)
        to_next = bearing_deg(lat, lon, nxt.lat, nxt.lon)
        best, best_wp = base, None
        for off in self.offsets_deg:
            if off == 0:
                continue
            c_lat, c_lon = destination(lat, lon, (to_next + off) % 360.0, reach)
            wp = Waypoint(round(c_lat, 4), round(c_lon, 4))
            score = self._time_to_goal(forecast, t, lat, lon, wp, speed)
            if score < best:
                best, best_wp = score, wp

        if best_wp is not None and base - best >= self.min_gain_h * 3600.0:
            rest = [w for w in ahead if w.lon > best_wp.lon + self.east_margin_deg]
            self._current = [best_wp, *(rest or [self.route[-1]])]
            mission = Mission(list(self._current))
            self.sent.append((t, mission))
            return mission
        if self.daily_ack:
            # Same waypoints as the boat already has: the autopilot keeps its
            # place on the route and safe mode logs contact with base.
            self._current = current
            self.acks.append(t)
            return Mission(list(current))
        return None
