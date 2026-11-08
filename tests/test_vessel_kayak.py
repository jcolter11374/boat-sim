"""KayakVessel end to end: the issue #2, #3, #4 and #6 acceptance checks."""

import math
from dataclasses import replace
from datetime import datetime, timedelta

import numpy as np
import pytest
from helpers_env import DiurnalEnvironment

from boatsim.autonomy import WaypointAutopilot
from boatsim.basestation import HoldCoursePolicy
from boatsim.comms import PerfectLink
from boatsim.config import load_design
from boatsim.geo import KNOT, distance_m
from boatsim.oceandata import ConstantEnvironment, PerfectForecast
from boatsim.runner import Components, simulate
from boatsim.runner.simulate import default_mission
from boatsim.types import Command, EnvState, EventKind, Outcome
from boatsim.vessel import KayakVessel
from boatsim.vessel import hull as H
from boatsim.vessel.kayak import solve_speed, with_damage

# Physics checks run with hazards off so a random knockdown can't change them.
DESIGN = replace(load_design("configs/v4_kayak.yaml"), hazards={"enabled": False})
DT = timedelta(minutes=10)
T0 = datetime(2021, 5, 1)


def _wind(to_deg: float, speed: float) -> tuple[float, float]:
    """(u, v) for wind blowing TOWARD to_deg, as ERA5 stores it."""
    return speed * math.sin(math.radians(to_deg)), speed * math.cos(math.radians(to_deg))


def _soc_throttle(soc: float, full: float = 0.30) -> float:
    """Design doc rule: full planned power above 70 % charge, tapering to
    steering-only at 40 %. (Sam's autopilot owns the real rule.)"""
    if soc > 0.7:
        return full
    if soc > 0.4:
        return full * (soc - 0.4) / 0.3
    return 0.0


def _run(env, days, heading=70.0, throttle=_soc_throttle, lat=37.0, lon=-60.0):
    v = KayakVessel(DESIGN)
    st = v.initial_state(T0, lat, lon)
    rng = np.random.default_rng(0)
    rows, events = [], []
    for _ in range(int(days * 144)):
        cmd = Command(heading, throttle(st.soc))
        st, ev = v.step(st, cmd, env.sample(st.t, st.lat, st.lon), DT, rng)
        events += ev
        rows.append((st.speed_through_water, st.drive_w, st.solar_w, st.soc, st.heading))
    return st, np.array(rows), events


def test_design_point_speed_matches_design_doc():
    # Design doc speed table: 30 W -> 1.8 kt, with +60 % rough water and +30 % fouling.
    v = KayakVessel(DESIGN)
    env = EnvState(hs=2.5, tp=7.0, wave_dir=0.0)  # beam seas for a boat heading 90
    foul = H.fouling_frac(v.hull, 50.0)
    sol = solve_speed(v.hull, v.thrusters, 90.0, 30.0, 2, env, foul, 0.0, 0.0)
    assert sol.wave_frac == pytest.approx(0.65, abs=0.01)
    assert 1.5 < sol.surge / KNOT < 1.9


def test_fifty_day_fixed_weather_run_hits_design_doc_numbers():
    """Plan doc acceptance: ~1.7 kt, 85 Wh/day electronics against 690-900 Wh/day solar."""
    u, w = _wind(160.0, 7.0)  # 14 kt breeze on the beam of a boat heading 070
    base = EnvState(wind_u=u, wind_v=w, hs=2.0, tp=7.0, wave_dir=340.0, air_temp=18.0)
    st, a, events = _run(DiurnalEnvironment(base, daily_kwh_m2=5.2), days=50)
    stw_kt = a[:, 0].mean() / KNOT
    solar_wh_day = a[:, 2].mean() * 24.0
    assert 1.5 < stw_kt < 2.0
    assert 690.0 < solar_wh_day < 900.0
    assert 25.0 < a[:, 1].mean() < 32.0  # design doc: 25-34 W average thrust power
    assert a[:, 3].min() > 0.4  # never forced down to steering-only
    assert not any(e.kind == EventKind.BATTERY_EMPTY for e in events)
    # Fouling slows it down over the passage at the same power
    assert a[-1440:, 0].mean() < a[:1440, 0].mean()
    assert st.fouling_frac == pytest.approx(0.30, abs=0.01)


def test_head_wind_and_sea_slow_the_boat():
    def speed(wind_to, wave_from):
        u, w = _wind(wind_to, 7.0)
        env = EnvState(wind_u=u, wind_v=w, hs=2.0, tp=7.0, wave_dir=wave_from)
        v = KayakVessel(DESIGN)
        return solve_speed(v.hull, v.thrusters, 70.0, 28.0, 2, env, 0.0, 0.0, 0.0).surge

    head, beam, follow = speed(250.0, 70.0), speed(160.0, 340.0), speed(70.0, 250.0)
    assert head < beam < follow
    assert head > 0.0  # 14 kt of headwind slows it a lot but doesn't stop it


def test_one_failed_thruster_still_makes_way():
    v = KayakVessel(DESIGN)
    st = v.initial_state(T0, 37.0, -60.0)
    one = with_damage(st, "thruster_port")
    assert v.working_thrusters(one) == 1
    env = EnvState(ghi=500.0)
    two_st, _ = v.step(st, Command(90.0, 0.56), env, DT, np.random.default_rng(0))
    one_st, _ = v.step(one, Command(90.0, 0.56), env, DT, np.random.default_rng(0))
    # Same thrust_fraction means the same watts per working thruster.
    assert one_st.drive_w == pytest.approx(two_st.drive_w / 2)
    assert 1.4 < one_st.speed_through_water / KNOT < two_st.speed_through_water / KNOT


def test_unpowered_kayak_drifts_with_current_wind_and_waves():
    """Issue #2: no thrust -> lies beam-on and drifts with current + leeway + Stokes."""
    u, w = _wind(90.0, 8.0)  # 16 kt westerly
    base = EnvState(
        wind_u=u, wind_v=w, current_u=0.10, current_v=0.05, hs=1.5, tp=7.0, wave_dir=270.0
    )
    st, _, _ = _run(ConstantEnvironment(base), days=10, throttle=lambda soc: 0.0)
    # Lies beam-on: heading is ~north or ~south when the wind blows east
    # (not exact, because it's the wind relative to the moving water that counts)
    assert min(abs(st.heading - 0.0), abs(st.heading - 180.0), abs(st.heading - 360.0)) < 1.0
    east_m = distance_m(37.0, -60.0, 37.0, st.lon)
    north_m = distance_m(37.0, -60.0, st.lat, -60.0)
    secs = 10 * 86400.0
    leeway = H.lateral_speed(H.HullParams(), 8.0 - 0.10, 0.0)
    se, _ = H.stokes_drift(1.5, 7.0, 270.0)
    assert east_m / secs == pytest.approx(0.10 + leeway + se, rel=0.02)
    assert north_m / secs == pytest.approx(0.05, rel=0.05)  # lags the current slightly
    # 10 days of drift at ~0.45 m/s is roughly 200 nm
    assert 300e3 < east_m < 450e3


def test_no_wind_no_waves_drift_is_almost_exactly_the_current():
    # Still air over a moving current is a slight headwind relative to the
    # water, so the boat lags the current by a few percent. Real effect.
    base = EnvState(current_u=0.3, current_v=-0.1)
    st, a, _ = _run(ConstantEnvironment(base), days=1, throttle=lambda soc: 0.0)
    assert a[:, 0].max() < 0.02
    east_m = distance_m(37.0, -60.0, 37.0, st.lon)
    assert east_m == pytest.approx(0.3 * 86400.0, rel=0.05)
    assert east_m < 0.3 * 86400.0


def test_flat_battery_goes_dark_then_recovers_with_sun():
    v = KayakVessel(DESIGN)
    st = v.initial_state(T0, 37.0, -60.0)
    st.battery_wh = 5.0
    rng = np.random.default_rng(0)
    night = EnvState()
    st, ev = v.step(st, Command(90.0, 1.0), night, DT, rng)
    assert any(e.kind == EventKind.BATTERY_EMPTY for e in ev)
    assert st.battery_wh == 0.0 and not st.electronics_on
    # Still dark: nothing draws, the boat drifts
    st, _ = v.step(st, Command(90.0, 1.0), night, DT, rng)
    assert st.drive_w == 0.0 and st.hotel_w == 0.0
    # Sun comes up: charges with electronics off until the restart threshold
    sun = EnvState(ghi=800.0)
    for _ in range(12):
        st, _ = v.step(st, Command(90.0, 0.0), sun, DT, rng)
    assert st.electronics_on and st.soc > v.battery.restart_soc


def test_runs_inside_the_voyage_runner():
    env = ConstantEnvironment(EnvState(ghi=1000.0))  # endless sun, flat calm
    c = Components(
        env=env,
        forecast=PerfectForecast(env),
        vessel=KayakVessel(DESIGN),
        autopilot=WaypointAutopilot(),
        link=PerfectLink(),
        base=HoldCoursePolicy(),
    )
    log = simulate(c, T0, 36.85, -75.7, default_mission())
    assert log.outcome == Outcome.ARRIVED
    # ~2,300 nm at full 100 W burst in a flat calm, ~3.3 kt falling with fouling
    assert 25 < log.days < 45
