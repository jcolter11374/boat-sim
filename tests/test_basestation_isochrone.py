"""Weather routing: the isochrone planner at base (basestation/isochrone.py)."""

import math
from datetime import UTC, datetime, timedelta

import pytest

from boatsim.basestation import ForecastReplanPolicy
from boatsim.basestation.isochrone import IsochroneReplanPolicy
from boatsim.config import load_design
from boatsim.oceandata.grid import OutsideCoverage
from boatsim.types import EnvState, Waypoint

T0 = datetime(2020, 5, 1, tzinfo=UTC)
START = (38.0, -70.0)
GOAL = Waypoint(38.0, -60.0)


def _polar():
    from boatsim.vessel import make_vessel

    return make_vessel(load_design("configs/stock_cruiser31.yaml")).polar


def _policy(**kw):
    kw.setdefault("land", None)
    kw.setdefault("keep_out", ())
    return IsochroneReplanPolicy(
        route=[GOAL], polar=_polar(), boat_speed=3.0, min_twa_deg=46, max_twa_deg=169, **kw
    )


def _report(t, lat, lon):
    return {"t": t.isoformat(timespec="minutes"), "lat": lat, "lon": lon, "soc": 0.9}


class HeadwindBand:
    """Light east wind (dead ahead) north of 37.5N; a fresh north wind (on the
    beam) south of it. No current."""

    def sample(self, t, lat, lon):
        return EnvState(
            wind_u=-3.0 if lat > 37.5 else 0.0, wind_v=0.0 if lat > 37.5 else -8.0, hs=1.0
        )


class Beam:
    def sample(self, t, lat, lon):
        return EnvState(wind_v=-7.0, hs=1.0)  # from the north: a beam reach east


class Watched:
    """Records every time it is asked about; refuses anything after the end."""

    def __init__(self, inner, t_end):
        self.inner, self.t_end, self.asked = inner, t_end, []

    def sample(self, t, lat, lon):
        self.asked.append(t)
        assert t <= self.t_end, "the planner looked past its horizon"
        return self.inner.sample(t, lat, lon)


def test_a_steady_beam_wind_plans_straight_for_the_finish():
    p = _policy()
    track, secs = p.plan(Beam(), T0, *START, p.boat_speed)
    from boatsim.geo import distance_m

    # 880 km at about 3 m/s: there in about 3.4 days, inside the 5-day horizon.
    assert len(track) <= 5 * 4 + 1  # never more than 5 days of 6-hour steps
    assert distance_m(*track[-1], GOAL.lat, GOAL.lon) < p.finish_radius_m
    assert all(abs(lat - 38.0) < 0.6 for lat, _ in track)  # no detour in steady wind
    assert 2.5 * 86400 < secs < 4.5 * 86400


def test_it_sails_round_a_headwind_band():
    p = _policy()
    track, _ = p.plan(HeadwindBand(), T0, *START, p.boat_speed)
    assert min(lat for lat, _ in track) < 37.5  # dips south into the beam wind
    m = p.on_report(_report(T0, *START), HeadwindBand())
    assert m is not None and p.sent and m.waypoints[-1] == GOAL
    assert m.waypoints[0].lat < 37.6 and m.waypoints[0].lon > START[1]


def test_it_never_asks_the_forecast_past_its_horizon():
    p = _policy()
    env = Watched(HeadwindBand(), T0 + p.horizon)
    p.on_report(_report(T0, *START), env)
    assert env.asked and min(env.asked) >= T0 and max(env.asked) <= T0 + p.horizon


def test_it_keeps_clear_of_land():
    # An island on the straight line, 2 days out (the fallback keep-out circles).
    island = (38.0, -66.0, 60_000.0)
    p = _policy(keep_out=(island,))
    track, secs = p.plan(Beam(), T0, *START, p.boat_speed)
    from boatsim.geo import distance_m

    assert math.isfinite(secs)
    assert all(distance_m(lat, lon, 38.0, -66.0) > 60_000.0 for lat, lon in track)


def test_off_the_forecast_map_is_a_dead_end_not_a_crash():
    class Edge:
        def sample(self, t, lat, lon):
            if lat > 39.0:
                raise OutsideCoverage("north of the map")
            return EnvState(wind_v=-7.0, hs=1.0)

    p = _policy()
    track, secs = p.plan(Edge(), T0, 38.9, -70.0, p.boat_speed)
    assert math.isfinite(secs) and len(track) > 1


def test_a_plan_that_gains_nothing_is_not_sent_but_base_still_acks():
    p = _policy()
    m = p.on_report(_report(T0, *START), Beam())
    assert m is not None and p.sent == [] and p.acks == [T0]  # the straight route already wins
    assert p.on_report(_report(T0 + timedelta(hours=6), *START), Beam()) is None


def test_waypoints_every_12_hours_to_2_days_then_the_end():
    p = _policy()
    track = [(38.0, -70.0 + 0.5 * k) for k in range(21)]
    wps = p._waypoints(track)
    assert [w.lon for w in wps] == [-69.0, -68.0, -67.0, -66.0, -60.0]


def test_routing_flag_picks_the_planner_and_defaults_to_the_fan():
    from boatsim.oceandata import ConstantEnvironment
    from boatsim.runner.simulate import standard_components

    d = load_design("configs/stock_cruiser31.yaml")
    env = ConstantEnvironment(EnvState())
    fan = standard_components(d, env, env, land=None)
    iso = standard_components(d, env, env, land=None, routing="isochrone")
    assert type(fan.base) is ForecastReplanPolicy
    assert isinstance(iso.base, IsochroneReplanPolicy) and iso.base.polar is not None
    assert iso.base.min_twa_deg == fan.base.min_twa_deg
    with pytest.raises(ValueError, match="routing"):
        standard_components(d, env, env, land=None, routing="psychic")


def test_the_drone_gets_a_speed_table_from_its_own_physics():
    from boatsim.basestation.isochrone import SteadyPolar
    from boatsim.oceandata import ConstantEnvironment
    from boatsim.runner.simulate import standard_components
    from boatsim.vessel import make_vessel

    d = load_design("configs/stock_sail_drone7.yaml")
    polar = SteadyPolar(make_vessel(d))
    reach, beat, run = (
        polar.speed_ms(7.0, 90.0),
        polar.speed_ms(7.0, 40.0),
        polar.speed_ms(7.0, 180.0),
    )
    assert 1.0 < reach < 3.0 and beat < reach and run < reach  # a reach is its best point
    assert polar.speed_ms(0.0, 90.0) == 0.0 and polar.speed_ms(25.0, 90.0) == 0.0  # calm, storm
    env = ConstantEnvironment(EnvState())
    iso = standard_components(d, env, env, land=None, routing="isochrone").base
    assert isinstance(iso.polar, SteadyPolar)
    assert (iso.min_twa_deg, iso.max_twa_deg) == (50.0, 165.0)
    # The default planner is unchanged for the drone: no polar, as before.
    assert standard_components(d, env, env, land=None).base.polar is None


def test_a_hybrid_wing_and_motor_boat_is_still_costed_as_a_motorboat():
    from boatsim.oceandata import ConstantEnvironment
    from boatsim.runner.simulate import standard_components

    d = load_design("configs/stock_sail_drone7.yaml")
    d.propulsion.update(thruster_count=2, cruise_drive_w=25, max_drive_w=50)  # add motors
    env = ConstantEnvironment(EnvState())
    assert standard_components(d, env, env, land=None, routing="isochrone").base.polar is None


def test_only_the_real_25_km_finish_circle_counts():
    """A plan used to stop anywhere within 50 km of the target, so it could end
    downwind of it and call that done (Ravi's 10-year runs: drones beating back
    ashore on Iberia and Morocco). Now the track must pass within 25 km."""
    from boatsim.autonomy.sphere import destination
    from boatsim.geo import distance_m

    p = _policy()
    assert p.finish_radius_m == 25_000.0
    # 40 km dead downwind of the target, wind from the target: it has to beat up.
    start = destination(GOAL.lat, GOAL.lon, 180.0, 40_000.0)

    class FromGoal:
        def sample(self, t, lat, lon):
            return EnvState(wind_v=-7.0, hs=1.0)  # from the north

    track, secs = p.plan(FromGoal(), T0, *start, p.boat_speed)
    assert len(track) > 1 and math.isfinite(secs)
    a, b = track[-2], track[-1]
    assert p._reaches(*a, *b) is not None  # the last leg enters the circle
    assert secs > 3600.0  # beating 15+ km upwind is not free
    # A leg that passes the circle mid-way counts, at the fraction it got there.
    west = destination(GOAL.lat, GOAL.lon, 270.0, 30_000.0)
    east = destination(GOAL.lat, GOAL.lon, 90.0, 30_000.0)
    f = p._reaches(*west, *east)
    assert f is not None and 0.0 < f < 0.5
    assert p._reaches(*west, *destination(*west, 0.0, 30_000.0)) is None
    assert distance_m(*west, GOAL.lat, GOAL.lon) > p.finish_radius_m
