"""Scripted base-station replanning (issue #17)."""

import itertools
import math
from datetime import UTC, datetime, timedelta

import pytest

from boatsim.autonomy import Mode, SafeModeAutopilot
from boatsim.autonomy.sphere import destination
from boatsim.basestation import ForecastReplanPolicy, HoldCoursePolicy
from boatsim.basestation.replan import _ground_velocity
from boatsim.comms import PerfectLink
from boatsim.config import load_design
from boatsim.geo import distance_m
from boatsim.oceandata import ConstantEnvironment, PerfectForecast
from boatsim.runner import Components, simulate
from boatsim.types import EnvState, Mission, Waypoint
from boatsim.vessel import KayakVessel

T0 = datetime(2020, 10, 1, tzinfo=UTC)
CRUISE = 0.15
START = (38.0, -70.0)
GOAL = Waypoint(38.0, -62.0)


class FoulBand:
    """A 0.6 m/s westward counter-current north of 37.5N, still water south of it.
    The straight route along 38N sits in the foul band; a detour south avoids it."""

    def sample(self, t, lat, lon):
        return EnvState(ghi=800.0, current_u=-0.6 if lat > 37.5 else 0.0)


def _voyage(env, base, days=20, start=START):
    design = load_design("configs/v4_kayak.yaml")
    c = Components(
        env,
        PerfectForecast(env),
        KayakVessel(design),
        SafeModeAutopilot(cruise_fraction=CRUISE),
        PerfectLink(),
        base,
    )
    return simulate(c, T0, *start, Mission([GOAL]), max_days=days)


def _days_to_goal(log, within_m=10_000.0):
    for r in log.rows:
        if distance_m(r["lat"], r["lon"], GOAL.lat, GOAL.lon) <= within_m:
            return (r["t"] - log.start).total_seconds() / 86400.0
    return math.inf


def _report(t, lat, lon, soc=0.9):
    return {"t": t.isoformat(timespec="minutes"), "lat": lat, "lon": lon, "soc": soc, "hdg": 90}


def test_ground_velocity_crabs_and_saturates():
    # Following current adds; head current subtracts.
    ve, _ = _ground_velocity(90.0, 0.87, 0.3, 0.0)
    assert abs(ve - 1.17) < 1e-9
    # Side current smaller than boat speed: stays on the line, a bit slower.
    ve, vn = _ground_velocity(90.0, 0.87, 0.0, 0.3)
    assert abs(vn) < 1e-9 and abs(ve - math.sqrt(0.87**2 - 0.09)) < 1e-9
    # Side current stronger than boat speed: no forward progress, pushed off.
    ve, vn = _ground_velocity(90.0, 0.5, 0.0, 1.0)
    assert abs(ve) < 1e-9 and abs(vn - 0.5) < 1e-9


def test_no_route_change_when_the_plan_is_already_best():
    """Uniform conditions: the straight route is best, so base changes nothing.
    It still sends a daily ack, so safe mode never thinks comms are lost."""
    policy = ForecastReplanPolicy(route=[GOAL])
    env = ConstantEnvironment(EnvState(ghi=800.0, current_u=0.2, current_v=0.1))
    sm = SafeModeAutopilot(cruise_fraction=CRUISE)
    design = load_design("configs/v4_kayak.yaml")
    c = Components(env, PerfectForecast(env), KayakVessel(design), sm, PerfectLink(), policy)
    simulate(c, T0, *START, Mission([GOAL]), max_days=10)
    assert policy.sent == []
    assert len(policy.acks) >= 4  # every 2 days
    assert Mode.LOST_COMMS not in {m for _, m in sm.mode_log}


def test_without_acks_safe_mode_drops_into_lost_comms():
    policy = ForecastReplanPolicy(route=[GOAL], daily_ack=False)
    env = ConstantEnvironment(EnvState(ghi=800.0))
    sm = SafeModeAutopilot(cruise_fraction=CRUISE)
    design = load_design("configs/v4_kayak.yaml")
    c = Components(env, PerfectForecast(env), KayakVessel(design), sm, PerfectLink(), policy)
    simulate(c, T0, *START, Mission([GOAL]), max_days=8)
    assert Mode.LOST_COMMS in {m for _, m in sm.mode_log}


def test_detours_around_a_foul_current_and_arrives_sooner():
    """Start 22 km inside the foul band, so a detour gets out within the 3-day
    horizon. (A band the boat can't leave within 3 days is out of base's sight
    by design: past 3 days the forecast is no better than a guess.)"""
    env = FoulBand()
    start = (37.7, START[1])
    held = _voyage(env, HoldCoursePolicy(), start=start)
    policy = ForecastReplanPolicy(route=[GOAL])
    replanned = _voyage(env, policy, start=start)
    assert policy.sent, "expected at least one correction"
    first = policy.sent[0][1].waypoints[0]
    assert first.lat < 37.5  # the new leg heads south, out of the foul band
    assert _days_to_goal(replanned) < 15 and _days_to_goal(replanned) < 0.8 * _days_to_goal(held)


def test_at_most_one_route_per_day():
    policy = ForecastReplanPolicy(route=[GOAL])
    _voyage(FoulBand(), policy)
    times = [t for t, _ in policy.sent]
    assert all(b - a >= timedelta(hours=24) for a, b in itertools.pairwise(times))
    # Direct check of the rate limit too.
    p = ForecastReplanPolicy(route=[GOAL])
    first = p.on_report(_report(T0, *START), FoulBand())
    again = p.on_report(_report(T0 + timedelta(hours=6), 38.0, -69.8), FoulBand())
    assert first is not None and again is None


def test_routes_fit_one_downlink_and_cost_little():
    policy = ForecastReplanPolicy(route=[Waypoint(38.5, -50.0), Waypoint(38.5, -28.0), GOAL])
    m = policy.on_report(_report(T0, *START), FoulBand())
    assert m is not None
    assert 8 + 8 * len(m.waypoints) <= 50  # one Iridium credit
    assert m.waypoints[-1] == GOAL


def test_new_leg_keeps_the_rest_of_the_route_ahead():
    route = [Waypoint(38.0, -66.0), GOAL]
    policy = ForecastReplanPolicy(route=route)
    m = policy.on_report(_report(T0, *START), FoulBand())
    assert m is not None
    assert all(w.lon > m.waypoints[0].lon for w in m.waypoints[1:])


def test_assumes_a_slower_boat_on_low_battery():
    p = ForecastReplanPolicy(route=[GOAL])
    assert p._speed(0.3) < p._speed(0.9)
    calm = ConstantEnvironment(EnvState())
    far_fast = p.predict(calm, T0, *START, GOAL, p._speed(0.9))
    far_slow = p.predict(calm, T0, *START, GOAL, p._speed(0.3))
    assert far_slow[1] < far_fast[1]
    # Sanity: 3 days at 0.87 m/s is ~225 km.
    _, lon = destination(*START, 90.0, 0.87 * 3 * 86400)
    assert abs(far_fast[1] - lon) < 0.05


def test_reused_policy_resets_between_voyages():
    p = ForecastReplanPolicy(route=[GOAL])
    later = T0 + timedelta(days=30)
    assert p.on_report(_report(later, *START), FoulBand()) is not None
    # Next voyage in a batch starts earlier in time: it must still get service.
    assert p.on_report(_report(T0, *START), FoulBand()) is not None
    assert len(p.sent) + len(p.acks) == 1


# ------------------------------------------------------------- keep clear of land


def test_keep_out_line_check():
    p = ForecastReplanPolicy(route=[GOAL])
    assert p.crosses_keep_out(38.5, -35.0, 38.5, -20.0)  # straight through the central group
    assert not p.crosses_keep_out(36.0, -35.0, 36.0, -20.0)  # south of Santa Maria
    assert not p.crosses_keep_out(*START, GOAL.lat, GOAL.lon)  # nowhere near


def test_detours_round_the_azores_and_never_enters_them():
    """A route straight through the central Azores: base must send the boat round.

    Under the Microtransat rule (#80) the Azores are not a finish, so the voyage
    runs on towards the goal.
    """
    goal = Waypoint(38.5, -20.0)
    start = (38.5, -36.0)
    policy = ForecastReplanPolicy(route=[goal])
    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(EnvState(ghi=800.0))
    c = Components(
        env,
        PerfectForecast(env),
        KayakVessel(design),
        SafeModeAutopilot(cruise_fraction=CRUISE),
        PerfectLink(),
        policy,
    )
    log = simulate(c, T0, *start, Mission([goal]), max_days=40)
    assert policy.sent, "expected a detour"
    for _, m in policy.sent:
        for a, b in itertools.pairwise(m.waypoints):
            assert not policy.crosses_keep_out(a.lat, a.lon, b.lat, b.lon)
    assert not any(policy._inside(r["lat"], r["lon"]) for r in log.rows)
    assert min(distance_m(r["lat"], r["lon"], goal.lat, goal.lon) for r in log.rows) < 10_000


def test_land_detour_is_sent_even_without_time_gain():
    """Crossing land is never acceptable, so min_gain_h doesn't apply."""
    goal = Waypoint(38.5, -20.0)
    p = ForecastReplanPolicy(route=[goal], min_gain_h=1e6)
    m = p.on_report(_report(T0, 38.5, -31.0), ConstantEnvironment(EnvState()))
    assert m is not None and p.sent
    a = m.waypoints[0]
    assert not p.crosses_keep_out(38.5, -31.0, a.lat, a.lon)


def test_uses_the_shared_land_map_not_just_the_azores():
    """The #75 land map keeps legs off Bermuda too; the Azores circles are only a fallback."""
    p = ForecastReplanPolicy(route=[GOAL])
    assert p.crosses_keep_out(32.3, -66.0, 32.3, -63.5)  # straight over Bermuda
    assert not p.crosses_keep_out(31.5, -66.0, 31.5, -63.5)  # ~90 km south of it
    fallback = ForecastReplanPolicy(route=[GOAL], land=None)
    assert not fallback.crosses_keep_out(32.3, -66.0, 32.3, -63.5)
    assert fallback.crosses_keep_out(38.5, -35.0, 38.5, -20.0)


def test_keep_out_precheck_gives_the_same_answers_as_probing_every_point():
    """crosses_keep_out with the coarse precheck agrees with the plain 5 km walk."""
    import random

    p = ForecastReplanPolicy(route=[Waypoint(39.5, -13.5)])
    mask = p._mask()
    if mask is None:
        return

    class Plain:  # the mask without its precheck
        def on_land(self, lat, lon):
            return mask.on_land(lat, lon)

    q = ForecastReplanPolicy(route=[Waypoint(39.5, -13.5)], land=Plain())
    rng = random.Random(11)
    hits = 0
    for _ in range(150):
        lat1, lon1 = rng.uniform(30, 50), rng.uniform(-78, -10)
        lat2, lon2 = destination(lat1, lon1, rng.uniform(0, 360), rng.uniform(5e3, 8e5))
        for margin in (None, 0.0, 5_000.0):
            got = p.crosses_keep_out(lat1, lon1, lat2, lon2, margin)
            assert got == q.crosses_keep_out(lat1, lon1, lat2, lon2, margin)
            assert p._inside(lat1, lon1, margin) == q._inside(lat1, lon1, margin)
            hits += got
    assert 0 < hits < 450  # both answers occur


# ------------------------------------------- sailing boats (a VPP polar)


def _cruiser_polar():
    from boatsim.vessel import make_vessel

    return make_vessel(load_design("configs/stock_cruiser31.yaml")).polar


def test_vmc_tacks_upwind_and_reaches_across():
    from boatsim.basestation.replan import vmc_ms

    polar = _cruiser_polar()
    east_wind = (-8.0, 0.0)  # blowing toward the west: from the east
    reach = vmc_ms(polar, 0.0, *east_wind)  # line due north: wind on the beam
    assert reach == pytest.approx(polar.speed_ms(8.0, 90.0))
    # Due east is dead upwind: no straight line, but tacking still gains.
    up = vmc_ms(polar, 90.0, *east_wind)
    best = max(polar.speed_ms(8.0, a) * math.cos(math.radians(a)) for a in range(1, 91))
    assert up == pytest.approx(best) and 0.3 * reach < up < 0.8 * reach
    # Kept to the tactician's limits it can only be slower, never faster.
    tac = vmc_ms(polar, 90.0, *east_wind, min_twa_deg=46.0, max_twa_deg=169.0)
    assert tac == pytest.approx(polar.speed_ms(8.0, 46.0) * math.cos(math.radians(46.0)))
    assert tac <= up
    down = vmc_ms(polar, 270.0, *east_wind, min_twa_deg=46.0, max_twa_deg=169.0)
    deep = max(polar.speed_ms(8.0, a) * math.cos(math.radians(180 - a)) for a in range(46, 170))
    assert down == pytest.approx(deep)  # dead downwind: gybing at the best angle up to 169
    assert vmc_ms(polar, 90.0, *east_wind, factor=0.5) == pytest.approx(0.5 * up)
    assert vmc_ms(polar, 90.0, 0.0, 0.0) == 0.0


class HeadwindBand:
    """A light east wind (dead ahead on the route along 38N) north of 37.5N; a
    fresh north wind (on the beam) south of it. No current anywhere."""

    def sample(self, t, lat, lon):
        return EnvState(
            ghi=800.0, wind_u=-3.0 if lat > 37.5 else 0.0, wind_v=0.0 if lat > 37.5 else -8.0
        )


def test_a_sailing_boat_is_sent_round_a_headwind_a_motorboat_is_not():
    env = HeadwindBand()
    report = _report(T0, *START)
    polar = _cruiser_polar()
    sail = ForecastReplanPolicy(route=[GOAL], polar=polar, boat_speed=3.0, land=None)
    mission = sail.on_report(report, env)
    assert mission is not None and sail.sent
    first = mission.waypoints[0]
    assert first.lat < START[0] and first.lon > START[1]  # south-east: into the beam wind
    motor = ForecastReplanPolicy(route=[GOAL], land=None)
    motor.on_report(report, env)
    assert motor.sent == []  # wind barely moves a motorboat's estimate
