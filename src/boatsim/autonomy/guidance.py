"""Waypoint following: a slow-timescale Python copy of ArduPilot Rover's guidance.

What the real Pixhawk does, and what this copies:

* **Track lines, not just "point at the waypoint".** Rover steers along the line
  from the previous waypoint (the *origin*) to the active one. When a mission
  starts, or a new one arrives from base, the origin is the boat's current spot.
* **Cross-track correction.** "Cross-track error" is how far the boat is to the
  side of that line. The autopilot aims at a point a fixed *lookahead* distance
  further along the line, so the boat angles back gently instead of zig-zagging.
* **Crabbing into the current.** A side current pushes the boat off the line, so
  the boat has to point a little upstream of where it wants to go (a "crab
  angle"), the way you aim upstream when rowing across a river. Rover gets this
  from GPS ground velocity; we do the same with a slow integrator that compares
  the course the GPS says we made good against the course we wanted.
* **Waypoint reached** when inside the acceptance radius, or once the boat has
  crossed the finish line through the waypoint at right angles to the track
  (ArduPilot's `past_interval_finish_line`), so a boat swept past a waypoint
  doesn't turn round to chase it.
* **GPS loss.** With no fix, hold the last commanded heading (dead reckoning).

**Pursuit steering (the default since 11 Nov 2026: `steer="pursuit"`;
`steer="track"` is the old Rover behaviour everywhere).** Far from land,
holding the track line costs time. When a cross-current pushes the boat off
the line, the autopilot spends speed crabbing up to 60 degrees to get back,
when the line itself doesn't matter out there. In pursuit mode, more than
`track_near_land_km` from any coast, the boat aims straight at the active
waypoint every step and lets the current carry it sideways, crabbing at most
`pursuit_crab_deg`. Near land (the drop, islands, the far coast) it holds the
track line as before, starting a fresh line from where it is. Found by the
Take the helm survey (11 Nov 2026): on 14 April to June 2020 launches,
re-aiming at the finish gave a 54.9-day median crossing against 67.0 for track
holding, with the same arrivals. On the paired 2012-21 April to June grid
(sensitivity run 42956919967, 100 launches) it was about 7 days faster
(median paired difference -7.3 days, 59 of 74 faster) with the same finish
odds (80% against 78%, within noise); Ravi passed it and Maya made it the
default. Never crabbing at all far from land was as fast but stays a
variant: it alone had a grounding.

What it does not copy, and why: Rover 4.2+ runs an S-curve path planner and a
position controller at 50 Hz with metre-scale gains. The simulator steps every
10 minutes (~500 m of travel), where those gains would oscillate, so the
lookahead and integrator below are scaled for ocean distances. The fast
heading-hold loop (rudder against wave yaw) is the vessel's job: the command
here is a heading setpoint. SITL tests (issue #18) check the two agree.

Owner: Sam.
"""

from __future__ import annotations

import math
from datetime import datetime

from boatsim.autonomy.sphere import destination, track_offsets, wrap180
from boatsim.geo import bearing_deg, distance_m
from boatsim.types import Command, Mission, Sensors


class WaypointAutopilot:
    """Rover-style track following with cross-track correction and crab angle.

    All tuning numbers are GUESSES until SITL comparison and sea trials.
    """

    def __init__(
        self,
        acceptance_radius_m: float = 5_000.0,  # GUESS: Rover WP_RADIUS scaled for ocean legs
        thrust_fraction: float = 1.0,
        lookahead_m: float = 10_000.0,  # GUESS: ~3 h of travel at 1.7 kt
        max_intercept_deg: float = 60.0,  # GUESS: steepest angle back onto the track
        crab_gain: float = 0.3,  # GUESS: fraction of course error absorbed per update
        max_crab_deg: float = 60.0,  # GUESS: beyond this the current simply wins
        min_ground_speed: float = 0.1,  # m/s; GUESS: below this GPS course is noise
        max_fix_gap_s: float = 3_600.0,  # GUESS: older fixes say little about the current now
        steer: str = "pursuit",  # "pursuit" far from land (see above) or "track" (Rover)
        pursuit_crab_deg: float = 20.0,  # GUESS: largest crab angle in pursuit mode
        track_near_land_km: float = 150.0,  # GUESS: hold the track line this close to a coast
    ):
        if steer not in ("track", "pursuit"):
            raise ValueError(f"steer must be 'track' or 'pursuit', not {steer!r}")
        self.acceptance_radius_m = acceptance_radius_m
        self.thrust_fraction = thrust_fraction
        self.lookahead_m = lookahead_m
        self.max_intercept_deg = max_intercept_deg
        self.crab_gain = crab_gain
        self.max_crab_deg = max_crab_deg
        self.min_ground_speed = min_ground_speed
        self.max_fix_gap_s = max_fix_gap_s
        self.steer = steer
        self.pursuit_crab_deg = pursuit_crab_deg
        self.track_near_land_km = track_near_land_km
        self.pursuing = False  # pursuit mode is steering right now

        # Set by safe mode when the motors were off last step. While the boat
        # is drifting, the course it made good says nothing about the current
        # we'd need to crab into, so the estimate is frozen (no windup).
        self.hold_crab = False
        # Set by the sailing tactician while it beats or runs (autonomy/sailing.py):
        # the boat is zig-zagging on purpose, so its course made good isn't the
        # current's doing either.
        self.tacking = False

        # Internal state, also handy for logging.
        self.crab_deg = 0.0
        self.cross_track_m = 0.0
        self.desired_course = 0.0
        self._mission: Mission | None = None
        self._mission_version: int | None = None
        self._origin: tuple[float, float] | None = None
        self._last_fix: tuple[datetime, float, float] | None = None
        self._last_heading: float | None = None
        self._last_desired: float | None = None

    def reset(self) -> None:
        """Forget the crab estimate and track state (start of a new voyage)."""
        self.crab_deg = 0.0
        self.cross_track_m = 0.0
        self.hold_crab = False
        self.tacking = False
        self._mission = None
        self._mission_version = None
        self._origin = None
        self._last_fix = None
        self._last_heading = None
        self._last_desired = None
        self.pursuing = False

    # ------------------------------------------------------------------ helpers

    def _open_ocean(self, sensors: Sensors) -> bool:
        from boatsim.vessel.coast import distance_to_land_km

        return distance_to_land_km(sensors.lat, sensors.lon) > self.track_near_land_km

    def _sync_mission(self, sensors: Sensors, mission: Mission) -> None:
        """A new mission (or a new version from base) starts its first leg from here.

        A resent copy of the same route (base's daily "all well" ack) is not a
        new route: keep the place on it and the current track line.
        """
        if mission is not self._mission or mission.version != self._mission_version:
            old = self._mission
            if old is not None and old.waypoints == mission.waypoints and self._origin:
                mission.active_index = max(mission.active_index, old.active_index)
                self._mission = mission
                self._mission_version = mission.version
                return
            self._mission = mission
            self._mission_version = mission.version
            if mission.active_index > 0:
                prev = mission.waypoints[mission.active_index - 1]
                self._origin = (prev.lat, prev.lon)
            else:
                self._origin = (sensors.lat, sensors.lon)

    def _advance(self, sensors: Sensors, mission: Mission) -> None:
        wps = mission.waypoints
        while mission.active_index < len(wps) - 1:
            wp = wps[mission.active_index]
            close = distance_m(sensors.lat, sensors.lon, wp.lat, wp.lon) <= self.acceptance_radius_m
            o_lat, o_lon = self._origin
            seg = distance_m(o_lat, o_lon, wp.lat, wp.lon)
            _, along = track_offsets(o_lat, o_lon, wp.lat, wp.lon, sensors.lat, sensors.lon)
            if not (close or (seg > 0 and along >= seg)):
                break
            self._origin = (wp.lat, wp.lon)
            mission.active_index += 1

    def _update_crab(self, sensors: Sensors) -> None:
        """Compare the course made good since the last fix with the course we wanted."""
        if self.hold_crab or self.tacking or self.thrust_fraction <= 0 or sensors.soc <= 0.0:
            # Not under power: freeze the crab and drop the baseline fix, so the
            # first fix after power returns isn't compared with a drifting one.
            self._last_fix = None
            return
        if self._last_fix is not None and self._last_desired is not None:
            t0, lat0, lon0 = self._last_fix
            dt = (sensors.t - t0).total_seconds()
            if 0 < dt <= self.max_fix_gap_s:
                moved = distance_m(lat0, lon0, sensors.lat, sensors.lon)
                if moved / dt >= self.min_ground_speed:
                    made_good = bearing_deg(lat0, lon0, sensors.lat, sensors.lon)
                    err = wrap180(self._last_desired - made_good)
                    crab = self.crab_deg + self.crab_gain * err
                    self.crab_deg = max(-self.max_crab_deg, min(self.max_crab_deg, crab))
        self._last_fix = (sensors.t, sensors.lat, sensors.lon)

    # --------------------------------------------------------------- interface

    def update(self, sensors: Sensors, mission: Mission, t: datetime) -> Command:
        if not sensors.gps_ok:
            # No position: keep doing what we were doing. Forget the last fix so
            # the next good one doesn't produce a bogus course made good.
            self._last_fix = None
            heading = self._last_heading if self._last_heading is not None else sensors.heading
            return Command(heading=heading, thrust_fraction=self.thrust_fraction)

        self._sync_mission(sensors, mission)
        self._advance(sensors, mission)
        self._update_crab(sensors)

        wp = mission.waypoints[mission.active_index]
        if self.steer == "pursuit":
            if self._open_ocean(sensors):
                self.pursuing = True
                desired = bearing_deg(sensors.lat, sensors.lon, wp.lat, wp.lon)
                self.cross_track_m = 0.0
                self.desired_course = self._last_desired = desired
                cap = self.pursuit_crab_deg
                heading = (desired + max(-cap, min(cap, self.crab_deg))) % 360.0
                self._last_heading = heading
                return Command(heading=heading, thrust_fraction=self.thrust_fraction)
            if self.pursuing:
                # Back near land: hold a fresh track line from here to the waypoint.
                self.pursuing = False
                self._origin = (sensors.lat, sensors.lon)
        o_lat, o_lon = self._origin
        seg = distance_m(o_lat, o_lon, wp.lat, wp.lon)
        xt, along = track_offsets(o_lat, o_lon, wp.lat, wp.lon, sensors.lat, sensors.lon)
        self.cross_track_m = xt

        to_wp = distance_m(sensors.lat, sensors.lon, wp.lat, wp.lon)
        if seg < 1.0 or to_wp <= self.lookahead_m or along + self.lookahead_m >= seg:
            desired = bearing_deg(sensors.lat, sensors.lon, wp.lat, wp.lon)
        else:
            track = bearing_deg(o_lat, o_lon, wp.lat, wp.lon)
            s = max(along, 0.0)
            c_lat, c_lon = destination(o_lat, o_lon, track, s + self.lookahead_m)
            desired = bearing_deg(sensors.lat, sensors.lon, c_lat, c_lon)
            # Never cut back onto the line steeper than max_intercept_deg,
            # measured against the track's direction abreast of the boat.
            f_lat, f_lon = destination(o_lat, o_lon, track, s)
            local_track = bearing_deg(f_lat, f_lon, wp.lat, wp.lon)
            off = wrap180(desired - local_track)
            if abs(off) > self.max_intercept_deg:
                desired = (local_track + math.copysign(self.max_intercept_deg, off)) % 360.0

        self.desired_course = desired
        self._last_desired = desired
        heading = (desired + self.crab_deg) % 360.0
        self._last_heading = heading
        return Command(heading=heading, thrust_fraction=self.thrust_fraction)
