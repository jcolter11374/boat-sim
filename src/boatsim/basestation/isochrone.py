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

import itertools
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np

from boatsim.basestation.replan import ForecastReplanPolicy, _ground_velocity, vmc_table
from boatsim.geo import EARTH_RADIUS_M, bearing_deg, distance_m, move
from boatsim.oceandata.base import Environment
from boatsim.oceandata.grid import OutsideCoverage
from boatsim.runner.arrival import TARGET_RADIUS_M
from boatsim.types import Mission, Waypoint
from boatsim.vessel.kayak import SteadyPolar  # noqa: F401  (moved; kept importable here)


def _haversine(lat1, lon1, lat2, lon2):
    """geo.distance_m on numpy arrays."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(a))


def _bearing(lat1, lon1, lat2, lon2):
    """geo.bearing_deg on numpy arrays."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(lon2 - lon1)
    x = np.sin(dl) * np.cos(p2)
    y = np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dl)
    return np.degrees(np.arctan2(x, y)) % 360.0


def _move(lat, lon, east_m, north_m):
    """geo.move on numpy arrays."""
    dlat = np.degrees(north_m / EARTH_RADIUS_M)
    dlon = np.degrees(east_m / (EARTH_RADIUS_M * np.cos(np.radians(lat))))
    return lat + dlat, ((lon + dlon + 180.0) % 360.0) - 180.0


def _ground_velocity_np(heading_deg, speed, ce, cn):
    """replan._ground_velocity on numpy arrays."""
    hr = np.radians(heading_deg)
    ue, un = np.sin(hr), np.cos(hr)
    along = ce * ue + cn * un
    cross = ce * un - cn * ue
    crab = speed > np.abs(cross)
    g = along + np.sqrt(np.where(crab, speed * speed - cross * cross, 0.0))
    side = cross - np.copysign(speed, cross)
    e = np.where(crab, g * ue, along * ue + side * un)
    n = np.where(crab, g * un, along * un - side * ue)
    return e, n


@dataclass
class _Node:
    lat: float
    lon: float
    parent: int  # index into the previous isochrone, -1 for the start
    left_m: float  # route distance still to go from here
    done_s: float | None = None  # seconds from the plan's start to the finish circle, once reached


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
    # The race's finish circle (runner/arrival.py): a track counts as finished
    # only once it passes this close to the target. (It used to be 50 km and
    # costed the rest at typical speed, so a plan could stop downwind of the
    # target and call it done: drones then beat back and some ran ashore on
    # Iberia and Morocco, Ravi's 10-year runs.)
    finish_radius_m: float = TARGET_RADIUS_M
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

    def _water_speed(self, rows, h: np.ndarray, speed: float):
        """For each node's forecast sample (rows) and headings h (nodes x
        headings): speed through the water along each line, as _velocity()
        works it out, and the current (east, north) that carries the boat."""
        ws = [w for _, _, w in rows]
        wu = np.array([w.wind_u for w in ws])
        wv = np.array([w.wind_v for w in ws])
        cu = np.array([w.current_u for w in ws])
        cv = np.array([w.current_v for w in ws])
        if self.polar is None:
            v = np.full(h.shape, float(speed))
            return v, cu + self.windage * wu, cv + self.windage * wv
        keys = [round(math.hypot(w.wind_u, w.wind_v) * 4) for w in ws]
        tables = np.zeros((len(ws), 181))
        for r, key in enumerate(keys):
            if key <= 0:
                continue  # calm: no speed
            table = self._vmc.get(key)
            if table is None:
                table = self._vmc[key] = vmc_table(
                    self.polar, key / 4, self.min_twa_deg, self.max_twa_deg
                )
            tables[r] = table
        wind_from = np.degrees(np.arctan2(-wu, -wv)) % 360.0
        off = np.abs((h - wind_from[:, None] + 180.0) % 360.0 - 180.0)
        idx = np.rint(off).astype(int)
        return self.polar_factor * np.take_along_axis(tables, idx, axis=1), cu, cv

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
        offs = np.array(offsets, dtype=float)
        # Distance to the goal along the route from a point, as _route_after():
        # to the first route waypoint east of it, then the route's own legs.
        route = self.route
        rlat = np.array([w.lat for w in route])
        rlon = np.array([w.lon for w in route])
        rest = [
            [distance_m(a.lat, a.lon, b.lat, b.lon) for a, b in itertools.pairwise(route[k:])]
            for k in range(len(route))
        ]
        width = max(len(r) for r in rest)
        rest_m = np.array([r + [0.0] * (width - len(r)) for r in rest]).reshape(len(route), width)

        def route_left(nlat: np.ndarray, nlon: np.ndarray) -> np.ndarray:
            east = rlon[None, :] > (nlon[:, None] + self.east_margin_deg)
            k = np.where(east.any(axis=1), east.argmax(axis=1), len(route) - 1)
            dist = _haversine(nlat, nlon, rlat[k], rlon[k])
            for c in range(width):
                dist = dist + rest_m[k, c]
            return dist

        t = t0
        samples: dict[tuple[float, float], object] = {}
        for i in range(n_steps):
            samples.clear()
            rows = []  # (index in layer, node, sample)
            for j, node in enumerate(layers[-1]):
                if node.done_s is not None:  # finished on the way here: stop
                    if best is None or node.done_s < best[0]:
                        best = (node.done_s, i, j)
                    continue
                key = (round(node.lat, 1), round(node.lon, 1))  # forecast is ~0.25 deg
                if key not in samples:
                    try:
                        samples[key] = forecast.sample(t, node.lat, node.lon)
                    except OutsideCoverage:  # off the forecast's map: a dead end
                        samples[key] = None
                if samples[key] is not None:
                    rows.append((j, node, samples[key]))
            if not rows:
                break
            # Every heading from every node at once (numpy): nodes down, headings across.
            plat = np.array([n.lat for _, n, _ in rows])
            plon = np.array([n.lon for _, n, _ in rows])
            to_goal = _bearing(plat, plon, goal.lat, goal.lon)
            h = (to_goal[:, None] + offs[None, :]) % 360.0
            v, ce, cn = self._water_speed(rows, h, speed)
            ve, vn = _ground_velocity_np(h, v, ce[:, None], cn[:, None])
            nlat, nlon = _move(plat[:, None], plon[:, None], ve * secs, vn * secs)
            moving = ~((ve == 0.0) & (vn == 0.0))
            left = route_left(nlat.ravel(), nlon.ravel()).reshape(nlat.shape)
            sector = np.floor_divide(_bearing(lat, lon, nlat, nlon), self.sector_deg).astype(int)
            # The finish circle: only legs that start near it need the full check.
            leg_m = np.hypot(ve, vn) * secs
            from_goal = _haversine(plat, plon, goal.lat, goal.lon)
            near = from_goal[:, None] <= self.finish_radius_m + 2.0 * leg_m + 10_000.0
            done = np.full(nlat.shape, math.inf)
            for r, c in zip(*np.nonzero(near & moving), strict=True):
                hit = self._reaches(plat[r], plon[r], nlat[r, c], nlon[r, c])
                if hit is not None:
                    done[r, c] = (i + hit) * secs
            # Each sector keeps its best candidate that is clear of land: soonest
            # finish, then least route left, then the first in the fan. Land is
            # the costly check, so it is made best-first and stops at the first
            # clear one.
            rr, cc = np.nonzero(moving)  # in fan order: node by node, heading by heading
            sec_of = sector[rr, cc]
            clear: dict[int, bool] = {}  # land checks made, by candidate

            def is_clear(o: int, rr=rr, cc=cc, rows=rows, nlat=nlat, nlon=nlon, clear=clear):
                if o not in clear:
                    r, c = rr[o], cc[o]
                    clear[o] = self._clear_leg(
                        rows[r][1], float(nlat[r, c]), float(nlon[r, c]), margin
                    )
                return clear[o]

            # A finished candidate ranks by its finish time alone (as the sweep's
            # kept node stores no distance left), so ties go to the first found.
            rank_left = np.where(np.isinf(done[rr, cc]), left[rr, cc], 0.0)
            order = np.lexsort((np.arange(len(rr)), rank_left, done[rr, cc], sec_of))
            kept: dict[int, _Node] = {}
            for o in order:
                sec = int(sec_of[o])
                if sec in kept or not is_clear(int(o)):
                    continue
                r, c = rr[o], cc[o]
                d = float(done[r, c])
                fin = None if d == math.inf else d
                kept[sec] = _Node(
                    float(nlat[r, c]),
                    float(nlon[r, c]),
                    rows[r][0],
                    0.0 if fin is not None else float(left[r, c]),
                    fin,
                )
            # The layer lists its sectors in the order the fan first finds a clear
            # point in each (as a one-by-one sweep would), so the next layer's
            # forecast lookups, shared within 0.1 deg, come out the same.
            first: dict[int, int] = {}
            for o in range(len(rr)):
                sec = int(sec_of[o])
                if sec in kept and sec not in first and is_clear(o):
                    first[sec] = o
                    if len(first) == len(kept):
                        break
            if not kept:
                break
            layers.append([kept[sec] for sec in sorted(first, key=first.get)])
            t += self.step
        last = len(layers) - 1
        if last > 0:
            for j, node in enumerate(layers[last]):
                score = (
                    node.done_s if node.done_s is not None else last * secs + node.left_m / speed
                )
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

    def _clear_leg(self, node: _Node, lat: float, lon: float, margin: float | None) -> bool:
        """Is the leg from `node` to (lat, lon) clear of land (and its margin)?"""
        return not (
            self._inside(lat, lon, margin)
            or self.crosses_keep_out(node.lat, node.lon, lat, lon, margin)
        )

    def _reaches(
        self, lat1: float, lon1: float, lat2: float, lon2: float, leg_m: float | None = None
    ) -> float | None:
        """Does the leg from point 1 to point 2 pass within the finish circle?
        The fraction of the leg sailed when it first does (0 to 1), or None.
        Checked at 8 points along the leg: a 6 h leg is at most about 60 km,
        so the gaps are well inside the 25 km circle. `leg_m`, the leg's
        length if known, skips the checks for a leg nowhere near the circle."""
        goal = self.route[-1]
        if leg_m is not None:
            # Every checked point is within about a leg of point 1 (doubled,
            # and 10 km more, to cover the straight lat/lon line's bend).
            near = self.finish_radius_m + 2.0 * leg_m + 10_000.0
            if distance_m(lat1, lon1, goal.lat, goal.lon) > near:
                return None
        for k in range(9):
            f = k / 8
            if (
                distance_m(lat1 + f * (lat2 - lat1), lon1 + f * (lon2 - lon1), goal.lat, goal.lon)
                < self.finish_radius_m
            ):
                return f
        return None

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
            if distance_m(lat, lon, goal.lat, goal.lon) < self.finish_radius_m:
                return lat, lon, i * secs
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
            hit = self._reaches(lat, lon, nlat, nlon)
            if hit is not None:
                return nlat, nlon, (i + hit) * secs
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
