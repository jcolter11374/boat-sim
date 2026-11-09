"""Scripted base-station replanning (issue #17)."""

import itertools
import math
from datetime import UTC, datetime, timedelta

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


def _voyage(env, base, days=20):
    design = load_design("configs/v4_kayak.yaml")
    c = Components(
        env,
        PerfectForecast(env),
        KayakVessel(design),
        SafeModeAutopilot(cruise_fraction=CRUISE),
        PerfectLink(),
        base,
    )
    return simulate(c, T0, *START, Mission([GOAL]), max_days=days)


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
    env = FoulBand()
    held = _voyage(env, HoldCoursePolicy())
    policy = ForecastReplanPolicy(route=[GOAL])
    replanned = _voyage(env, policy)
    assert policy.sent, "expected at least one correction"
    first = policy.sent[0][1].waypoints[0]
    assert first.lat < 37.5  # the new leg heads south, out of the foul band
    assert _days_to_goal(replanned) < 0.8 * _days_to_goal(held)


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
