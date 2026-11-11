"""Weather routing for sailing boats: an isochrone planner at base, re-planned
once a day on that morning's forecast. Off by default (`routing="isochrone"`
in runner.simulate.standard_components, or `voyage.routing` in a design).

What it does, in plain words. Each morning base reads the boat's report and
the forecast issued that morning. A new route only reaches the boat with its
next daily report (the boat collects its Iridium mailbox then), so base first
works out where the boat should be a day from now, carrying on as it is, and
plans from there. (Planning from the reported position instead sent the boat
back for waypoints it had already sailed past: 30 days instead of 19 on the
1 Apr 2020 cruiser launch.) From that position it fans out every
heading within `fan_deg` of the way to the finish and works out where the
boat would be `step` (6 h) later on each, from the boat's polar (its speed at
each angle to the wind) and the forecast wind and current. From every one of
those points it fans out again, and so on, out to `horizon` (5 days). The
line joining the furthest points reached after each step is an "isochrone"
(a line of equal time). Pruning keeps it small: the points are sorted into
`sector_deg` slices by their bearing from the start, and only the one nearest
the finish (by the planned route) survives in each slice. A point, or a 6 h
leg, within the land margin (20 km, as the fan policy) is dropped.

The best end point is the one with the least time to the finish: the horizon
plus the route distance still to go at the boat's typical ocean speed, the
same cost as the fan policy (ForecastReplanPolicy._time_to_goal), so both
planners are judged alike. Base then sends the winning track as waypoints
every `send_every` (12 h) out to `send_until` (2 days), plus its end point,
and the rest of the planned route after it. The autopilot steers to each in
turn (a waypoint counts as reached when the boat crosses the line through it
at right angles, so a boat blown past one doesn't turn back for it).

It only resends when the plan beats carrying on with the current waypoints
by `min_gain_h`, or when the current leg would hit land, so a forecast that
wobbles a little doesn't cost a message a day. Otherwise it acks every two
days, exactly as the fan policy does.

Never peeking at the future. The forecast it gets is what was issued on the
morning of the report (runner.simulate calls `forecast.issue(t)` at the
report time). That forecast is the truth plus smooth error that grows with
lead time, sized from published verification of global ocean forecasts:
ECMWF's yearly "Evaluation of ECMWF forecasts" for wind, Lellouche et al.
2018 (doi:10.5194/os-14-1093-2018) for currents; see oceandata/forecast.py.
Real archived GFS forecasts would be better still, but NOAA's free AWS GFS
archive (noaa-gfs-bdp-pds) starts in 2021, and the NCEI archive for earlier
years is whole-globe GRIB files, far more data than a cloud runner should
pull for a comparison. So for now the honest forecast is the error model.
The planner also never looks past `horizon`; beyond it the remaining
distance is costed at a fixed typical speed, not from any weather.

Sizes (all GUESSES): a 5-day horizon (forecast skill fades through days 3-7,
and the cruiser covers about 1,200 km in 5 days, a quarter of the route),
6-hour steps, 10-degree heading spacing within 90 degrees either side of the
finish, 2-degree sectors.

First results (11 Nov 2026; 2020 browser bundle, launches 1 and 15 Apr, May,
Jun; breakdowns off; honest forecast; against the default fan planner):
the cruiser averaged 19.70 days against 19.77 (4 launches faster, 2 slower),
so for it this is noise. The drone averaged 36.3 days against 46.4 (faster on
all 6). More than half of that is the routing itself: given the same
speed table (SteadyPolar), the fan planner averages 42.1. The price is airtime: the drone gets a new route about every
other day (17 to 28 a voyage, against 2 to 10), the cruiser 3 to 9 (against
0 or 1), which adds about $1 to $5 of Iridium airtime a voyage.

Owner: Sam.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from boatsim.basestation.replan import ForecastReplanPolicy, _ground_velocity
from boatsim.geo import bearing_deg, distance_m, move
from boatsim.oceandata.base import Environment
from boatsim.oceandata.grid import OutsideCoverage
from boatsim.types import Mission, Waypoint


class SteadyPolar:
    """A speed table for a wing-sail boat with no VPP polar (the wind-powered
    drone, a KayakVessel with a sail): its steady speed through the water at
    each wind speed and angle, from the boat's own force balance
    (vessel.kayak.solve_speed), so base plans with the physics the boat sails
    with. Waves come from the wind with the height of a fully developed sea,
    Hs = 0.0214 U^2 (Pierson & Moskowitz 1964, doi:10.1029/JZ069i024p05181),
    capped at 6 m: a GUESS, since the planner asks by wind alone. No current,
    no fouling (polar_factor covers both). Above the storm wind the wing is
    feathered and the boat only runs off, so it counts as making no way."""

    def __init__(self, vessel):
        self.vessel = vessel
        self._cache: dict[tuple[int, int], float] = {}

    def speed_ms(self, tws_ms: float, twa_deg: float) -> float:
        from boatsim.types import EnvState
        from boatsim.vessel.kayak import solve_speed

        key = (round(tws_ms * 4), round(twa_deg))
        got = self._cache.get(key)
        if got is not None:
            return got
        v, sail = self.vessel, self.vessel.sail
        tws, twa = key[0] / 4, math.radians(key[1])
        if tws <= 0.0 or tws > sail.storm_wind_ms:
            speed = 0.0
        else:
            env = EnvState(
                wind_u=-tws * math.sin(twa),
                wind_v=-tws * math.cos(twa),
                hs=min(0.0214 * tws * tws, 6.0),
                wave_dir=float(key[1]),
            )
            sol = solve_speed(
                v.hull, v.thrusters, 0.0, 0.0, 0, env, 0.0, 0.0, 0.0,
                sail=sail, sail_alpha_max_deg=sail.max_alpha_deg,
            )  # fmt: skip
            speed = max(sol.surge, 0.0)
        self._cache[key] = speed
        return speed


@dataclass
class _Node:
    lat: float
    lon: float
    parent: int  # index into the previous isochrone, -1 for the start
    left_m: float  # route distance still to go from here


@dataclass
class IsochroneReplanPolicy(ForecastReplanPolicy):
    """Implements `BasePolicy`. All tuning numbers are GUESSES."""

    horizon: timedelta = timedelta(days=5)  # GUESS: see module doc
    step: timedelta = timedelta(hours=6)  # GUESS
    fan_deg: float = 90.0  # GUESS: headings this far either side of the finish
    heading_step_deg: float = 10.0  # GUESS
    sector_deg: float = 2.0  # GUESS: pruning slice, by bearing from the start
    send_every: timedelta = timedelta(hours=12)  # waypoint spacing along the plan
    send_until: timedelta = timedelta(days=2)  # beyond this only the end point is sent
    # A route sent today reaches the boat with tomorrow's report (Iridium
    # mailbox="with_report", comms/iridium.py), so plans start a day ahead.
    delivery: timedelta = timedelta(hours=24)
    finish_radius_m: float = 50_000.0  # a node this close to the goal stops expanding
    plans: list[tuple[datetime, list[tuple[float, float]], float]] = field(
        default_factory=list, repr=False
    )  # (time, planned track, seconds to the goal): for tests and plots

    # ------------------------------------------------------------- planning

    def _velocity(self, w, heading: float, speed: float) -> tuple[float, float]:
        """Ground velocity (east, north) holding a line on `heading` in forecast
        sample `w`: a sailing boat makes its best speed along the line from the
        polar (tacking or gybing if it must); a motorboat its still-water speed.
        Either way the current carries it, as in the fan policy."""
        if self.polar is None:
            ce = w.current_u + self.windage * w.wind_u
            cn = w.current_v + self.windage * w.wind_v
            return _ground_velocity(heading, speed, ce, cn)
        v = self._vmc_ms(heading, w.wind_u, w.wind_v)
        return _ground_velocity(heading, v, w.current_u, w.current_v)

    def plan(
        self,
        forecast: Environment,
        t0: datetime,
        lat: float,
        lon: float,
        speed: float,
        horizon: timedelta | None = None,
    ) -> tuple[list[tuple[float, float]], float]:
        """The best track over `horizon` (default: the policy's), as positions
        every `step` with the start first, and its time to the goal in seconds
        (infinite if every track meets land)."""
        goal = self.route[-1]
        secs = self.step.total_seconds()
        n_steps = int((horizon or self.horizon) / self.step)
        margin = 0.0 if self._inside(lat, lon) else None
        start_left, _ = self._route_after(lat, lon)
        layers: list[list[_Node]] = [[_Node(lat, lon, -1, start_left)]]
        best: tuple[float, int, int] | None = None  # (seconds, layer, index)
        offsets = [
            k * self.heading_step_deg
            for k in range(
                -int(self.fan_deg // self.heading_step_deg),
                int(self.fan_deg // self.heading_step_deg) + 1,
            )
        ]
        t = t0
        samples: dict[tuple[float, float], object] = {}
        for i in range(n_steps):
            samples.clear()
            sectors: dict[int, _Node] = {}
            for j, node in enumerate(layers[-1]):
                d_goal = distance_m(node.lat, node.lon, goal.lat, goal.lon)
                if d_goal < self.finish_radius_m:
                    # Close enough: cost the last bit at typical speed and stop here.
                    score = i * secs + d_goal / speed
                    if best is None or score < best[0]:
                        best = (score, i, j)
                    continue
                key = (round(node.lat, 1), round(node.lon, 1))  # forecast is ~0.25 deg
                if key not in samples:
                    try:
                        samples[key] = forecast.sample(t, node.lat, node.lon)
                    except OutsideCoverage:  # off the forecast's map: a dead end
                        samples[key] = None
                w = samples[key]
                if w is None:
                    continue
                to_goal = bearing_deg(node.lat, node.lon, goal.lat, goal.lon)
                for off in offsets:
                    h = (to_goal + off) % 360.0
                    ve, vn = self._velocity(w, h, speed)
                    if ve == 0.0 and vn == 0.0:
                        continue
                    nlat, nlon = move(node.lat, node.lon, ve * secs, vn * secs)
                    if self._inside(nlat, nlon, margin) or self.crosses_keep_out(
                        node.lat, node.lon, nlat, nlon, margin
                    ):
                        continue
                    left, _ = self._route_after(nlat, nlon)
                    s = int(bearing_deg(lat, lon, nlat, nlon) // self.sector_deg)
                    kept = sectors.get(s)
                    if kept is None or left < kept.left_m:
                        sectors[s] = _Node(nlat, nlon, j, left)
            if not sectors:
                break
            layers.append(list(sectors.values()))
            t += self.step
        last = len(layers) - 1
        if last > 0:
            for j, node in enumerate(layers[last]):
                score = last * secs + node.left_m / speed
                if best is None or score < best[0]:
                    best = (score, last, j)
        if best is None:
            return [(lat, lon)], math.inf
        score, i, j = best
        track = []
        while i >= 0:
            node = layers[i][j]
            track.append((node.lat, node.lon))
            i, j = i - 1, node.parent
        track.reverse()
        return track, (score if len(track) > 1 else math.inf)

    def _follow(
        self, forecast: Environment, t0: datetime, lat: float, lon: float, wps, speed: float, n: int
    ) -> tuple[float, float, float | None] | None:
        """Carry on through the waypoints the boat has (`wps`, in order) for `n`
        steps on the forecast: (lat, lon, None) where it ends up, or (lat, lon,
        seconds) if it reaches the goal on the way, or None if it meets land
        or leaves the forecast's map."""
        secs = self.step.total_seconds()
        margin = 0.0 if self._inside(lat, lon) else None
        goal = self.route[-1]
        k, t = 0, t0
        for i in range(n):
            d_goal = distance_m(lat, lon, goal.lat, goal.lon)
            if d_goal < self.finish_radius_m:
                return lat, lon, i * secs + d_goal / speed
            # A waypoint within the autopilot's 5 km radius counts as reached.
            while k < len(wps) - 1 and distance_m(lat, lon, wps[k].lat, wps[k].lon) < 5_000.0:
                k += 1
            try:
                w = forecast.sample(t, lat, lon)
            except OutsideCoverage:
                return None
            ve, vn = self._velocity(w, bearing_deg(lat, lon, wps[k].lat, wps[k].lon), speed)
            nlat, nlon = move(lat, lon, ve * secs, vn * secs)
            if self._inside(nlat, nlon, margin) or self.crosses_keep_out(
                lat, lon, nlat, nlon, margin
            ):
                return None
            # Passing a waypoint mid-step: carry on from it toward the next.
            step_m = distance_m(lat, lon, nlat, nlon)
            if k < len(wps) - 1 and distance_m(lat, lon, wps[k].lat, wps[k].lon) <= step_m:
                k += 1
            lat, lon, t = nlat, nlon, t + self.step
        return lat, lon, None

    def follow_cost(
        self, forecast: Environment, t0: datetime, lat: float, lon: float, wps, speed: float
    ) -> float:
        """Seconds to the goal carrying on through the waypoints the boat has
        for the horizon, costed exactly like plan(): infinite if that meets land."""
        n = int(self.horizon / self.step)
        end = self._follow(forecast, t0, lat, lon, wps, speed, n)
        if end is None:
            return math.inf
        if end[2] is not None:
            return end[2]
        left, _ = self._route_after(end[0], end[1])
        return self.horizon.total_seconds() + left / speed

    def _waypoints(self, track: list[tuple[float, float]]) -> list[Waypoint]:
        """The plan as waypoints: every `send_every` out to `send_until`, then its end."""
        every = max(1, round(self.send_every / self.step))
        until = round(self.send_until / self.step)
        idx = list(range(every, min(until, len(track) - 1) + 1, every))
        if not idx or idx[-1] != len(track) - 1:
            idx.append(len(track) - 1)
        return [Waypoint(round(track[k][0], 4), round(track[k][1], 4)) for k in idx]

    # -------------------------------------------------------------- interface

    def on_report(self, report: dict, forecast: Environment) -> Mission | None:
        t = datetime.fromisoformat(report["t"])
        last = max([s[0] for s in self.sent] + self.acks, default=None)
        if last is not None and t < last:
            # Time went backwards: a new voyage reusing this policy (batch runs).
            self.sent, self.acks, self._current, self.plans = [], [], None, []
        last = max([s[0] for s in self.sent] + self.acks, default=None)
        if last is not None and t - last < self.min_interval:
            return None
        lat, lon, soc = report["lat"], report["lon"], report.get("soc", 1.0)
        speed = self._speed(soc)
        current = self._current or self._ahead(lon)
        # The waypoints still ahead of the boat (one already passed is behind it).
        ahead = [w for w in current if w.lon > lon + self.east_margin_deg] or [current[-1]]

        stay = self.follow_cost(forecast, t, lat, lon, ahead, speed)
        # A new route only reaches the boat with its next report (the mailbox
        # is checked then), so plan from where the boat should be by then.
        n = round(self.delivery / self.step)
        then = self._follow(forecast, t, lat, lon, ahead, speed, n)
        if then is None or then[2] is not None:
            # Land ahead within the day (plan from here: better late than never),
            # or it finishes before a new route could arrive.
            track, score = (
                self.plan(forecast, t, lat, lon, speed) if then is None else ([], math.inf)
            )
        else:
            track, score = self.plan(
                forecast, t + n * self.step, then[0], then[1], speed, self.horizon - n * self.step
            )
            score += n * self.step.total_seconds()
        self.plans.append((t, track, score))
        if score < math.inf and (stay == math.inf or stay - score >= self.min_gain_h * 3600.0):
            wps = self._waypoints(track)
            end = wps[-1]
            rest = [w for w in self._ahead(lon) if w.lon > end.lon + self.east_margin_deg]
            self._current = [*wps, *(rest or [self.route[-1]])]
            mission = Mission(list(self._current))
            self.sent.append((t, mission))
            return mission
        last_contact = max([s[0] for s in self.sent] + self.acks, default=None)
        due = last_contact is None or t - last_contact >= self.ack_every - timedelta(hours=1)
        if self.daily_ack and due:
            self._current = current
            self.acks.append(t)
            return Mission(list(current))
        return None
