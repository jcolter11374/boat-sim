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
6. Otherwise, every `ack_every` (2 days by default), send a tiny "all well,
   carry on" message: the same route again. It tells safe mode that base is
   alive, so the boat doesn't drop into lost-comms mode (after 5 silent days)
   on a quiet voyage. Every 2 days rather than daily because each ack costs a
   credit now that the boat collects messages only with its report (#72);
   2 days still leaves room for one lost ack inside the 5-day limit.

7. **Keep clear of land.** Under the Microtransat rules (#80) running ashore
   ends the voyage, and the Azores sit right on the route. Base checks every
   leg against the shared 2 km land mask (runner/land.py, #75) with a
   `land_margin_m` buffer (20 km): any leg whose predicted track, or whose
   line on to the rest of the route, comes that close to land is thrown out.
   That covers every coast and island in the route box (Outer Banks, Bermuda,
   the Azores, Madeira), not just the Azores. If the boat's current leg would
   cross land, base sends a detour even when it gains no time. If the boat is
   already inside the buffer (just after the drop, say), only actual land
   counts until it is clear. Without the mask file it falls back to circles
   round the Azores island groups.

The forecast it reads already contains realistic error (oceandata's Forecast),
so it can't cheat by seeing the future.

Owner: Sam.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from boatsim.autonomy.sphere import destination
from boatsim.geo import bearing_deg, distance_m, move
from boatsim.oceandata.base import Environment
from boatsim.types import Mission, Waypoint

# Fallback when the land mask is missing: keep-out circles around the Azores
# island groups, (lat, lon, radius_m). Centres and extents from standard
# chart/gazetteer positions (rounded); each radius is the group's half-extent
# plus the 20 km margin.
AZORES_KEEP_OUT: tuple[tuple[float, float, float], ...] = (
    (39.55, -31.15, 35_000.0),  # Flores and Corvo
    (38.50, -28.40, 50_000.0),  # Faial and Pico
    (38.65, -28.05, 50_000.0),  # Sao Jorge
    (39.05, -28.00, 30_000.0),  # Graciosa
    (38.72, -27.20, 40_000.0),  # Terceira
    (37.78, -25.50, 55_000.0),  # Sao Miguel
    (36.97, -25.10, 30_000.0),  # Santa Maria
)


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
    ack_every: timedelta = timedelta(days=2)  # GUESS: one lost ack still < 5-day limit
    min_interval: timedelta = timedelta(hours=24)
    east_margin_deg: float = 0.05  # waypoints this far west of the boat are behind it
    low_soc: float = 0.5  # below this, safe mode throttles back; assume slower
    keep_out: tuple[tuple[float, float, float], ...] = AZORES_KEEP_OUT  # fallback only
    # GUESS: margin for GPS, drift between daily reports and the autopilot's
    # 5 km waypoint radius.
    land_margin_m: float = 20_000.0
    land: object = "default"  # a runner.land.LandMask, "default" (the committed one) or None
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

    def _mask(self):
        if self.land == "default":
            from boatsim.runner.land import default_land  # lazy: avoids an import cycle

            self.land = default_land()
        return self.land

    def _inside(self, lat: float, lon: float, margin: float | None = None) -> bool:
        """Is this point on land, or within `margin` metres of it?"""
        margin = self.land_margin_m if margin is None else margin
        mask = self._mask()
        if mask is None:
            extra = margin - self.land_margin_m  # circles already include the default margin
            return any(distance_m(lat, lon, a, b) < r + extra for a, b, r in self.keep_out)
        if mask.on_land(lat, lon):
            return True
        if margin <= 0:
            return False
        # Probe two rings (full and half margin) at 8 bearings: with a 2 km
        # grid this finds any island wider than ~2 km inside the margin.
        for dist in (margin, margin / 2):
            for brg in range(0, 360, 45):
                if mask.on_land(*destination(lat, lon, float(brg), dist)):
                    return True
        return False

    def crosses_keep_out(
        self, lat1: float, lon1: float, lat2: float, lon2: float, margin: float | None = None
    ) -> bool:
        """Does the great-circle line between two points come within the margin of land?"""
        d = distance_m(lat1, lon1, lat2, lon2)
        brg = bearing_deg(lat1, lon1, lat2, lon2)
        n = max(1, math.ceil(d / 5_000.0))
        return any(
            self._inside(*destination(lat1, lon1, brg, d * k / n), margin) for k in range(n + 1)
        )

    def _route_after(self, lat: float, lon: float) -> tuple[float, Waypoint]:
        """Distance from a point to the goal along the planned route, and the first
        route waypoint it would head for."""
        ahead = self._ahead(lon)
        dist = distance_m(lat, lon, ahead[0].lat, ahead[0].lon)
        for a, b in itertools.pairwise(ahead):
            dist += distance_m(a.lat, a.lon, b.lat, b.lon)
        return dist, ahead[0]

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
        return self.predict_path(forecast, t0, lat, lon, wp, speed)[-1]

    def predict_path(
        self,
        forecast: Environment,
        t0: datetime,
        lat: float,
        lon: float,
        wp: Waypoint,
        speed: float,
    ) -> list[tuple[float, float]]:
        """Predicted positions every `step` over the horizon, holding the line toward wp."""
        path = [(lat, lon)]
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
            path.append((lat, lon))
            t += self.step
        return path

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
        """Seconds to the goal: follow wp for the horizon, then the planned route.

        Infinite if the leg comes within the land margin, or if the line from
        wp on to the rest of the route would. A boat already inside the margin
        is only kept off actual land until it is clear.
        """
        margin = 0.0 if self._inside(lat, lon) else None
        path = self.predict_path(forecast, t0, lat, lon, wp, speed)
        if any(self._inside(a, b, margin) for a, b in path) or self.crosses_keep_out(
            lat, lon, wp.lat, wp.lon, margin
        ):
            return math.inf
        _, rejoin = self._route_after(wp.lat, wp.lon)
        if rejoin != wp and self.crosses_keep_out(wp.lat, wp.lon, rejoin.lat, rejoin.lon, margin):
            return math.inf
        plat, plon = path[-1]
        left, nxt = self._route_after(plat, plon)
        env = forecast.sample(t0 + self.horizon, plat, plon)
        ce = env.current_u + self.windage * env.wind_u
        cn = env.current_v + self.windage * env.wind_v
        ve, vn = _ground_velocity(bearing_deg(plat, plon, nxt.lat, nxt.lon), speed, ce, cn)
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

        # A current leg that would hit land is always replaced, whatever the gain.
        if best_wp is not None and (base == math.inf or base - best >= self.min_gain_h * 3600.0):
            rest = [w for w in ahead if w.lon > best_wp.lon + self.east_margin_deg]
            self._current = [best_wp, *(rest or [self.route[-1]])]
            mission = Mission(list(self._current))
            self.sent.append((t, mission))
            return mission
        last_contact = max([s[0] for s in self.sent] + self.acks, default=None)
        due = last_contact is None or t - last_contact >= self.ack_every - timedelta(hours=1)
        if self.daily_ack and due:
            # Same waypoints as the boat already has: the autopilot keeps its
            # place on the route and safe mode logs contact with base.
            self._current = current
            self.acks.append(t)
            return Mission(list(current))
        return None
