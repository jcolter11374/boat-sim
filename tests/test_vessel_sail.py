"""Our model of the Randolph team's Rev B (configs/randolph_rev_b.yaml) and the
wing-sail physics it needs (vessel/sail.py)."""

import math
from datetime import datetime, timedelta

import numpy as np

from boatsim.config import load_design
from boatsim.runner.simulate import DROP_POINT, default_mission
from boatsim.types import Command, EnvState
from boatsim.vessel import KayakVessel
from boatsim.vessel import sail as S
from boatsim.vessel.kayak import solve_speed

REV_B = "configs/randolph_rev_b.yaml"
KN = 0.5144


def _vessel():
    return KayakVessel(load_design(REV_B))


def _speed(v, heading, tws=6.0, hs=1.0, alpha_max=20.0):
    """Wind from the north at tws; boat on `heading`."""
    env = EnvState(wind_v=-tws, hs=hs, tp=6.0, wave_dir=0.0)
    return solve_speed(
        v.hull, v.thrusters, heading, 0.0, 0, env, 0.0, 0.0, 0.0,
        sail=v.sail, sail_alpha_max_deg=alpha_max,
    )  # fmt: skip


def test_config_loads_as_a_sailboat_with_no_thrusters_and_no_beacon():
    d = load_design(REV_B)
    assert d.name == "Randolph Rev B"
    v = KayakVessel(d)
    assert v.sail is not None and v.sail.area_m2 == 0.30
    assert v.thrusters.count == 0
    assert v.battery.capacity_wh == 192
    s = v.initial_state(datetime(2020, 5, 1), d.voyage["drop_lat"], d.voyage["drop_lon"])
    assert not s.beacon_ok and s.iridium_ok
    # our kayak has no sail and keeps its beacon
    k = KayakVessel(load_design("configs/v4_kayak.yaml"))
    assert k.sail is None
    assert k.initial_state(datetime(2020, 5, 1), *DROP_POINT).beacon_ok


def test_wing_drives_the_boat_on_every_point_of_sail_it_can_hold():
    v = _vessel()
    for heading in (60, 90, 120, 150, 180):  # degrees off a north wind
        s = _speed(v, heading)
        assert 0.3 * KN < s.surge < 3.0 * KN, (heading, s.surge / KN)
        assert s.sail_drive_n > 0
    # a beam reach in a moderate breeze: around a knot, as their polar
    assert 0.8 * KN < _speed(v, 90).surge < 2.0 * KN


def test_feathered_wing_drifts_at_a_few_percent_of_the_wind():
    v = _vessel()
    s = _speed(v, 90, tws=10.0, hs=0.0, alpha_max=0.0)
    drift = math.hypot(s.surge, s.sway)
    assert 0.02 * 10 < drift < 0.045 * 10  # their leeway model: 3.3 % of the wind


def test_wing_never_heels_the_boat_past_its_limit():
    p = _vessel().sail
    cap = p.max_heel_moment_nm / p.heel_arm_m
    for ax, ay in ((-8.0, -6.0), (-3.0, -9.0), (2.0, -12.0), (-15.0, 0.5)):
        a = S.best_alpha(p, ax, ay, p.max_alpha_deg)
        assert abs(S.wing_force(p, ax, ay, a)[1]) <= cap + 1e-9


def test_it_cannot_point_into_the_wind_and_tacks_with_hysteresis():
    p = _vessel().sail
    # wind from 090, wants to go 090: sails 50 deg off, on the tack it was on
    h, feather = S.sail_heading(p, 90.0, 90.0, prev_heading=150.0, tws=7.0)
    assert not feather and abs(h - 140.0) < 1e-9
    h, _ = S.sail_heading(p, 90.0, 90.0, prev_heading=30.0, tws=7.0)
    assert abs(h - 40.0) < 1e-9
    # slightly favouring the other tack is not enough to tack...
    h, _ = S.sail_heading(p, 80.0, 90.0, prev_heading=150.0, tws=7.0)
    assert abs(h - 140.0) < 1e-9
    # ...clearly favouring it is
    h, _ = S.sail_heading(p, 45.0, 90.0, prev_heading=150.0, tws=7.0)
    assert abs(h - 40.0) < 1e-9
    # free to sail a beam reach
    assert S.sail_heading(p, 0.0, 90.0, 0.0, 7.0) == (0.0, False)
    # storm: feather and run off at 140 deg
    h, feather = S.sail_heading(p, 90.0, 270.0, prev_heading=90.0, tws=25.0)
    assert feather and abs(abs(S.wrap180(h - 270.0)) - 140.0) < 1e-9


def test_step_sails_without_drive_power_and_reaches_on_once_the_rudder_is_gone():
    v = _vessel()
    t = datetime(2020, 5, 1)
    s0 = v.initial_state(t, 38.02, -74.01)
    env = EnvState(wind_u=7.0, hs=1.0, tp=6.0, wave_dir=270.0, ghi=300.0)  # westerly
    rng = np.random.default_rng(0)
    step = timedelta(minutes=10)
    s1, _ = v.step(s0, Command(heading=90.0, thrust_fraction=0.0), env, step, rng)
    assert s1.drive_w == 0.0
    assert s1.speed_through_water > 0.5 * KN and s1.lon > s0.lon
    # Rudder gone, wing still trimmed: it weathervanes onto a reach ~110 deg off
    # the wind on the side it was on, and keeps sailing (their simulator does too).
    broken = v.initial_state(t, 38.02, -74.01)
    broken.heading = 100.0
    broken.damage["rudder"] = True
    s2, _ = v.step(broken, Command(heading=90.0, thrust_fraction=0.0), env, step, rng)
    assert abs(S.wrap180(s2.heading - (270.0 - 110.0))) < 1e-9  # 100 deg is on the minus side
    assert s2.speed_through_water > 0.5 * KN
    # Rudder and wing both gone: it drifts at a few percent of the wind.
    broken.damage["sail"] = True
    s3, _ = v.step(broken, Command(heading=90.0, thrust_fraction=0.0), env, step, rng)
    assert s3.speed_through_water < 0.045 * 7.0


def test_rev_b_has_one_electronics_box():
    from boatsim.vessel.hazards import K_DICE, SLOT, sample_failures

    hz = _vessel().hazards
    assert hz.electronics_boxes == 1
    dice = np.ones(K_DICE)
    dice[SLOT["electronics_common"]] = 0.0  # this step's electronics die comes up
    out = sample_failures(
        hz, EnvState(), 1.0, {}, datetime(2020, 5, 1), 38.0, -60.0, 30.0, dice, thrusters=()
    )
    assert out.lost
    names = [e.detail for e in out.events]
    assert any("one electronics box" in n for n in names)
    assert not any("electronics_safe" in n or "both" in n for n in names)


def test_route_starts_at_the_designs_own_drop_point():
    assert (default_mission().waypoints[0].lat, default_mission().waypoints[0].lon) == DROP_POINT
    wp = default_mission((38.02, -74.01)).waypoints
    assert (wp[0].lat, wp[0].lon) == (38.02, -74.01)
    assert (wp[-1].lat, wp[-1].lon) == (39.5, -13.5)
