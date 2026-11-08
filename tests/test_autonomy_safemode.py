"""Safe-mode rules (issue #15): low battery, lost comms, dead thruster, no crab windup."""

import itertools
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from boatsim.autonomy import Mode, SafeModeAutopilot, WaypointAutopilot
from boatsim.basestation import HoldCoursePolicy
from boatsim.comms import PerfectLink
from boatsim.config import load_design
from boatsim.oceandata import ConstantEnvironment, PerfectForecast
from boatsim.runner import Components, simulate
from boatsim.runner.simulate import default_mission
from boatsim.types import EnvState, EventKind, Mission, Sensors, Waypoint
from boatsim.vessel import KayakVessel

T0 = datetime(2020, 10, 1, tzinfo=UTC)
START = (36.85, -75.7)
CRUISE = 0.15  # 15 W of 100 W, the v4 design cruise setting


@dataclass(frozen=True)
class ThrusterSensors(Sensors):
    thrusters_ok: int = 2


def _s(t=T0, lat=37.0, lon=-60.0, soc=1.0, **kw):
    if "thrusters_ok" in kw:
        return ThrusterSensors(t, lat, lon, 90.0, soc, thrusters_ok=kw["thrusters_ok"])
    return Sensors(t, lat, lon, 90.0, soc)


class DeadLink:
    """Nothing gets through, ever: a total comms blackout."""

    def send(self, msg, env, rng):
        return None


def _voyage(autopilot, env_state, link=None, days=30, mission=None):
    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(env_state)
    c = Components(
        env,
        PerfectForecast(env),
        KayakVessel(design),
        autopilot,
        link or PerfectLink(),
        HoldCoursePolicy(),
    )
    return simulate(c, T0, *START, mission or default_mission(), max_days=days)


# ------------------------------------------------------------------ low battery


def test_throttle_steps_down_with_charge_and_has_hysteresis():
    sm = SafeModeAutopilot()
    assert [sm.throttle_scale(s) for s in (1.0, 0.5, 0.4, 0.3, 0.2)] == [1.0, 1.0, 0.6, 0.6, 0.3]
    assert sm.throttle_scale(0.14) == 0.0  # motors off below 15%
    assert sm.throttle_scale(0.20) == 0.0  # ...and stay off until 25%
    assert sm.throttle_scale(0.26) == 0.3  # back on (gently) above the restart level


def test_low_sun_safe_mode_never_runs_flat_and_goes_further():
    """Weak sun (40 W/m2 all day, like a long overcast spell): the plain autopilot
    keeps cruising and repeatedly empties the battery; safe mode throttles back."""
    weak_sun = EnvState(ghi=40.0)
    plain = _voyage(WaypointAutopilot(thrust_fraction=CRUISE), weak_sun)
    sm = SafeModeAutopilot(cruise_fraction=CRUISE)
    safe = _voyage(sm, weak_sun)
    assert any(e.kind == EventKind.BATTERY_EMPTY for e in plain.events)
    assert not any(e.kind == EventKind.BATTERY_EMPTY for e in safe.events)
    assert min(r["soc"] for r in safe.rows) >= 0.14
    assert safe.rows[-1]["lon"] > plain.rows[-1]["lon"]
    assert Mode.LOW_BATTERY in {m for _, m in sm.mode_log}


def test_full_sun_runs_at_cruise():
    sm = SafeModeAutopilot(cruise_fraction=CRUISE)
    cmd = sm.update(_s(soc=0.9), Mission([Waypoint(38.5, -28.0)]), T0)
    assert cmd.thrust_fraction == CRUISE and sm.mode == Mode.NORMAL


# --------------------------------------------------------------------- thrusters


def test_one_dead_thruster_survivor_takes_the_full_drive_power():
    sm = SafeModeAutopilot(cruise_fraction=CRUISE)
    m = Mission([Waypoint(38.5, -28.0)])
    assert sm.update(_s(thrusters_ok=2), m, T0).thrust_fraction == CRUISE
    assert sm.update(_s(thrusters_ok=1), m, T0).thrust_fraction == 2 * CRUISE
    assert sm.update(_s(thrusters_ok=0), m, T0).thrust_fraction == 0.0


def test_dead_thruster_holds_cruise_speed_in_the_vessel_model():
    """KayakVessel shares drive power over working thrusters, so doubling the
    per-thruster setting keeps total power, and speed, about the same."""
    from boatsim.vessel.kayak import with_damage

    design = load_design("configs/v4_kayak.yaml")
    v = KayakVessel(design)
    env = EnvState(ghi=1000.0)
    rng = __import__("numpy").random.default_rng(0)
    s = v.initial_state(T0, *START)
    both, _ = v.step(s, _cmd(CRUISE), env, timedelta(minutes=10), rng)
    one, _ = v.step(with_damage(s, "thruster_port"), _cmd(CRUISE), env, timedelta(minutes=10), rng)
    fixed, _ = v.step(
        with_damage(s, "thruster_port"), _cmd(2 * CRUISE), env, timedelta(minutes=10), rng
    )
    assert one.speed_through_water < 0.9 * both.speed_through_water  # without safe mode
    assert (
        abs(fixed.speed_through_water - both.speed_through_water) < 0.1 * both.speed_through_water
    )


def _cmd(frac):
    from boatsim.types import Command

    return Command(heading=90.0, thrust_fraction=frac)


def test_thruster_count_can_be_set_when_sensors_lack_the_field():
    sm = SafeModeAutopilot(cruise_fraction=CRUISE)
    sm.set_thrusters_ok(1)
    assert sm.update(_s(), Mission([Waypoint(38.5, -28.0)]), T0).thrust_fraction == 2 * CRUISE


# -------------------------------------------------------------------- lost comms


def test_ten_day_blackout_still_heads_east_on_the_stored_route():
    sm = SafeModeAutopilot(cruise_fraction=CRUISE)
    log = _voyage(sm, EnvState(ghi=1000.0), link=DeadLink(), days=12)
    assert Mode.LOST_COMMS in {m for _, m in sm.mode_log}
    daily = log.rows[::24]
    assert all(b["lon"] > a["lon"] for a, b in itertools.pairwise(daily))
    assert log.rows[-1]["lon"] > START[1] + 5.0  # ~12 days at ~1.7 kt


def test_lost_comms_skips_waypoints_behind_the_boat():
    """A stale route from base that points back west is ignored once comms are lost."""
    sm = SafeModeAutopilot(cruise_fraction=CRUISE)
    m = Mission([Waypoint(37.0, -65.0), Waypoint(38.5, -28.0)], version=3)
    sm.update(_s(lon=-60.0), m, T0)  # contact at T0 (new mission version)
    t = T0 + timedelta(days=6)
    cmd = sm.update(_s(t=t, lon=-60.0), m, t)
    assert sm.mode == Mode.LOST_COMMS
    assert m.active_index == 1
    assert 60.0 < cmd.heading < 120.0


def test_lost_comms_with_no_route_left_heads_due_east():
    sm = SafeModeAutopilot(cruise_fraction=CRUISE)
    m = Mission([Waypoint(37.0, -70.0)])
    sm.update(_s(lon=-60.0), m, T0)
    t = T0 + timedelta(days=6)
    cmd = sm.update(_s(t=t, lon=-60.0), m, t)
    assert abs(cmd.heading - 90.0) < 10.0  # great circle east from 37N starts a bit north


def test_new_route_from_base_counts_as_contact():
    sm = SafeModeAutopilot(cruise_fraction=CRUISE)
    m0 = Mission([Waypoint(38.5, -28.0)])
    sm.update(_s(), m0, T0)
    t = T0 + timedelta(days=4)
    sm.update(_s(t=t), Mission([Waypoint(38.5, -28.0)], version=1), t)
    t2 = T0 + timedelta(days=8)
    sm.update(_s(t=t2), Mission([Waypoint(38.5, -28.0)], version=1), t2)
    assert sm.mode == Mode.NORMAL  # 4 days since the last route, under the 5-day limit


# ------------------------------------------------------------------ crab windup


def test_no_crab_windup_while_drifting():
    """With motors off the boat drifts wherever the wind sends it. The crab
    estimate must not learn from that, or it steers wildly when power returns."""
    ap = WaypointAutopilot(thrust_fraction=CRUISE)
    m = Mission([Waypoint(37.0, -30.0)])
    ap.hold_crab = True
    for k in range(12):  # two hours drifting due north
        t = T0 + timedelta(minutes=10 * k)
        ap.update(Sensors(t, 37.0 + 0.003 * k, -60.0, 0.0, 0.1), m, t)
    assert ap.crab_deg == 0.0
    ap.hold_crab = False
    t = T0 + timedelta(hours=2, minutes=10)
    ap.update(Sensors(t, 37.04, -60.0, 0.0, 0.3), m, t)  # first fix back under power
    assert ap.crab_deg == 0.0  # no stale drift baseline used


def test_safe_mode_freezes_crab_after_a_battery_hold():
    sm = SafeModeAutopilot(cruise_fraction=CRUISE)
    m = Mission([Waypoint(37.0, -30.0)])
    for k in range(12):
        t = T0 + timedelta(minutes=10 * k)
        sm.update(Sensors(t, 37.0 + 0.003 * k, -60.0, 0.0, 0.10), m, t)  # flat: holding
    assert sm.mode == Mode.BATTERY_HOLD
    assert sm.guidance.crab_deg == 0.0


def test_reused_instance_resets_between_voyages():
    """Batch runs reuse one autopilot; a new voyage must not inherit old state."""
    sm = SafeModeAutopilot(cruise_fraction=CRUISE)
    _voyage(sm, EnvState(ghi=1000.0), link=DeadLink(), days=8)
    assert sm.mode == Mode.LOST_COMMS
    sm.guidance.crab_deg = 30.0
    sm.update(_s(t=T0), default_mission(), T0)  # next voyage starts
    assert sm.mode == Mode.NORMAL
    assert sm.guidance.crab_deg == 0.0
