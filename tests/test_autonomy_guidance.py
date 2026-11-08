"""Waypoint following (issue #14): track lines, cross-track correction, crab angle."""

from datetime import UTC, datetime, timedelta

import numpy as np

from boatsim.autonomy import WaypointAutopilot
from boatsim.autonomy.sphere import destination, track_offsets
from boatsim.basestation import HoldCoursePolicy
from boatsim.comms import PerfectLink
from boatsim.config import load_design
from boatsim.geo import bearing_deg, distance_m
from boatsim.oceandata import ConstantEnvironment, PerfectForecast
from boatsim.runner import Components, simulate
from boatsim.runner.simulate import default_mission
from boatsim.types import Command, EnvState, Mission, Outcome, Sensors, Waypoint
from boatsim.vessel import KinematicVessel

T0 = datetime(2020, 10, 1, tzinfo=UTC)
START = (36.85, -75.7)


class PointAtWaypoint:
    """The old M0 stub: aim straight at the waypoint, no track, no crab."""

    def update(self, sensors, mission, t):
        wp = mission.waypoints[mission.active_index]
        return Command(bearing_deg(sensors.lat, sensors.lon, wp.lat, wp.lon), 1.0)


def _components(env_state, autopilot):
    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(env_state)
    return Components(
        env=env,
        forecast=PerfectForecast(env),
        vessel=KinematicVessel(design),
        autopilot=autopilot,
        link=PerfectLink(),
        base=HoldCoursePolicy(),
    )


def _max_cross_track_km(log, origin, dest, after_days=1.0):
    worst = 0.0
    for r in log.rows:
        if (r["t"] - log.start).total_seconds() < after_days * 86400:
            continue
        xt, _ = track_offsets(*origin, *dest, r["lat"], r["lon"])
        worst = max(worst, abs(xt))
    return worst / 1000.0


def _days_to_reach(log, dest, within_m=5_000.0):
    for r in log.rows:
        if distance_m(r["lat"], r["lon"], *dest) <= within_m:
            return (r["t"] - log.start).total_seconds() / 86400.0
    return float("inf")


# --------------------------------------------------------------- geometry helpers


def test_destination_round_trip():
    lat, lon = destination(*START, 75.0, 500_000.0)
    assert abs(distance_m(*START, lat, lon) - 500_000.0) < 1.0
    assert abs(bearing_deg(*START, lat, lon) - 75.0) < 1e-6


def test_track_offsets_sign_and_size():
    o, d = (37.0, -70.0), (37.0, -60.0)
    # 10 km north of an eastbound track is to the LEFT (negative).
    p = destination(*destination(*o, bearing_deg(*o, *d), 100_000.0), 0.0, 10_000.0)
    xt, at = track_offsets(*o, *d, *p)
    assert -10_100 < xt < -9_900
    assert 99_000 < at < 101_000
    _, behind = track_offsets(*o, *d, 37.0, -71.0)
    assert behind < 0


# ------------------------------------------------------------------ behaviour


def test_cross_current_crabs_and_holds_the_line():
    """0.3 m/s (0.6 kt) northward set across an eastbound leg. The boat must
    point south of east by about asin(0.3 / 0.87) ~ 20 deg and stay near the line."""
    dest = destination(*START, 90.0, 400_000.0)
    mission = Mission([Waypoint(*dest)])
    ap = WaypointAutopilot()
    log = simulate(
        _components(EnvState(ghi=1000.0, current_v=0.3), ap),
        T0,
        *START,
        mission,
        max_days=3,
    )
    assert _max_cross_track_km(log, START, dest) < 2.0
    assert 15.0 < ap.crab_deg < 26.0


def test_track_following_beats_pointing_in_a_cross_current():
    dest = destination(*START, 90.0, 400_000.0)
    env = EnvState(ghi=1000.0, current_v=0.3)
    ours = simulate(_components(env, WaypointAutopilot()), T0, *START, Mission([Waypoint(*dest)]))
    naive = simulate(_components(env, PointAtWaypoint()), T0, *START, Mission([Waypoint(*dest)]))
    # Pointing drifts well off the line and takes the long way round.
    assert _max_cross_track_km(naive, START, dest) > 4 * _max_cross_track_km(ours, START, dest)
    assert _days_to_reach(ours, dest) < _days_to_reach(naive, dest)


def test_recovers_onto_track_from_an_offset_start():
    """Start 20 km north of the line: the boat should angle back, not head
    straight for the waypoint on a parallel course."""
    origin = START
    dest = destination(*origin, 90.0, 400_000.0)
    start = destination(*origin, 0.0, 20_000.0)
    mission = Mission([Waypoint(*origin), Waypoint(*dest)])
    ap = WaypointAutopilot(acceptance_radius_m=25_000.0)  # origin counts as reached at once
    log = simulate(_components(EnvState(ghi=1000.0), ap), T0, *start, mission, max_days=4)
    assert mission.active_index == 1
    xt_end, _ = track_offsets(*origin, *dest, log.rows[-1]["lat"], log.rows[-1]["lon"])
    assert abs(xt_end) < 1_000.0


def test_passing_a_waypoint_abeam_counts_as_reached():
    """A boat swept past a waypoint outside the radius moves on, not back."""
    o = (37.0, -70.0)
    wp1 = destination(*o, 90.0, 100_000.0)
    wp2 = destination(*o, 90.0, 300_000.0)
    mission = Mission([Waypoint(*wp1), Waypoint(*wp2)])
    ap = WaypointAutopilot(acceptance_radius_m=1_000.0)
    # First call fixes the origin at o; then jump to 20 km past wp1 and 15 km off the line.
    ap.update(Sensors(T0, *o, 90.0, 1.0), mission, T0)
    past = destination(*destination(*o, 90.0, 120_000.0), 0.0, 15_000.0)
    t1 = T0 + timedelta(hours=10)
    cmd = ap.update(Sensors(t1, *past, 90.0, 1.0), mission, t1)
    assert mission.active_index == 1
    # Heading on toward wp2 (east, angling back to the line), not back west to wp1.
    assert 30.0 < cmd.heading < 160.0


def test_new_mission_from_base_starts_its_leg_from_the_boat():
    ap = WaypointAutopilot()
    m1 = Mission([Waypoint(40.0, -40.0)])
    ap.update(Sensors(T0, *START, 90.0, 1.0), m1, T0)
    here = (37.5, -65.0)
    m2 = Mission([Waypoint(37.5, -40.0)], version=1)
    cmd = ap.update(Sensors(T0 + timedelta(days=5), *here, 90.0, 1.0), m2, T0)
    assert ap._origin == here
    assert abs(ap.cross_track_m) < 1.0
    assert abs(cmd.heading - bearing_deg(*here, 37.5, -40.0)) < 2.0


def test_gps_loss_holds_last_heading():
    ap = WaypointAutopilot()
    m = Mission([Waypoint(38.5, -28.0)])
    first = ap.update(Sensors(T0, *START, 90.0, 1.0), m, T0)
    lost = ap.update(Sensors(T0 + timedelta(minutes=10), 0.0, 0.0, 200.0, 1.0, gps_ok=False), m, T0)
    assert lost.heading == first.heading


def test_noisy_gps_still_tracks():
    """10 m GPS noise (a cheap receiver at sea is ~3-5 m) must not upset the crab estimate."""

    class NoisyVessel(KinematicVessel):
        def sense(self, state, rng):
            s = super().sense(state, rng)
            lat, lon = destination(s.lat, s.lon, rng.uniform(0, 360), abs(rng.normal(0, 10.0)))
            return Sensors(s.t, lat, lon, s.heading, s.soc)

    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(EnvState(ghi=1000.0, current_v=0.3))
    c = Components(
        env,
        PerfectForecast(env),
        NoisyVessel(design),
        WaypointAutopilot(),
        PerfectLink(),
        HoldCoursePolicy(),
    )
    dest = destination(*START, 90.0, 400_000.0)
    log = simulate(c, T0, *START, Mission([Waypoint(*dest)]), max_days=3, seed=3)
    assert _max_cross_track_km(log, START, dest) < 2.0
    headings = np.array([r["heading"] for r in log.rows[24:]])
    assert headings.std() < 3.0  # steady crab, no hunting


def test_default_route_still_arrives():
    log = simulate(
        _components(EnvState(ghi=1000.0), WaypointAutopilot()), T0, *START, default_mission()
    )
    assert log.outcome == Outcome.ARRIVED
