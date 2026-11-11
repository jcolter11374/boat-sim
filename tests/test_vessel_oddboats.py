"""The joke fleet (configs/joke_*.yaml): honest physics for absurd boats
(vessel/oddboats.py): muscle power, swamping, a kite, and their own words for
how it ends."""

import math
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pytest

from boatsim.config import load_design
from boatsim.types import Command, EnvState, Event, EventKind
from boatsim.vessel import OddBoatVessel, make_vessel
from boatsim.vessel import hull as H

T0 = datetime(2020, 5, 1)  # midnight UTC: about 19:00 local sun time off the Bay
FLEET = sorted(Path("configs").glob("joke_*.yaml"))
CMD = Command(heading=90.0, thrust_fraction=1.0)


def boat(name):
    return make_vessel(load_design(f"configs/joke_{name}.yaml"))


def run(v, env, hours, t0=T0, seed=0):
    s = v.initial_state(t0, 36.65, -74.94)
    rng = np.random.default_rng(seed)
    events = []
    for _ in range(int(hours * 6)):
        s, ev = v.step(s, CMD, env, timedelta(minutes=10), rng)
        events += ev
        if not s.alive:
            break
    return s, events


def lost(events):
    return [e.detail for e in events if e.kind == EventKind.LOST]


CALM = EnvState(ghi=300.0)


def sea(hs, wind=7.0):
    return EnvState(wind_u=wind, hs=hs, tp=max(3.0, 4 * math.sqrt(hs) + 2), wave_dir=270.0)


def test_the_whole_fleet_loads_as_odd_boats_and_moves():
    assert len(FLEET) == 6
    for cfg in FLEET:
        v = make_vessel(load_design(str(cfg)))
        assert isinstance(v, OddBoatVessel), cfg
        s, _ = run(v, sea(0.5, wind=5.0), 2)
        assert s.alive, cfg


def test_closed_boats_never_take_water_and_open_boats_fill_faster_in_bigger_seas():
    assert boat("flamingo").topping_share(4.0, 9.0) == 0.0
    canoe = boat("canoe")
    shares = [canoe.topping_share(hs, 4 * math.sqrt(hs) + 2) for hs in (0.5, 1.0, 1.5, 2.5)]
    assert shares == sorted(shares) and shares[0] < 1e-3 < shares[-1] < 1.0
    assert canoe.topping_share(0.0, 5.0) == 0.0


def test_the_crew_paddles_by_day_and_rests_by_night():
    canoe = boat("canoe")
    s = canoe.initial_state(T0, 36.65, -74.94)  # 00 UTC = about 19:00 local
    assert not canoe.crew_on(s)
    assert canoe.crew_on(replace(s, t=T0 + timedelta(hours=14)))  # about 09:00 local
    night, _ = run(canoe, CALM, 1)
    day, _ = run(canoe, CALM, 1, t0=T0 + timedelta(hours=14))
    assert night.speed_through_water < 0.05
    assert 1.2 < day.speed_through_water < 2.0  # about 3 kn on 75 W
    assert day.crew_working and not night.crew_working


def test_fatigue_weakens_the_crew_to_its_floor():
    canoe = boat("canoe")
    s = canoe.initial_state(T0, 36.65, -74.94)
    assert canoe.crew_power_w(s) == pytest.approx(75.0)
    later = replace(s, t=T0 + timedelta(days=100))
    assert canoe.crew_power_w(later) == pytest.approx(75.0 * 0.6)


def test_open_boats_swamp_in_a_breeze_but_not_in_a_calm():
    for name in ("canoe", "pedalo", "bathtub"):
        s, ev = run(boat(name), sea(2.5, wind=10.0), 24)
        assert not s.alive, name
        assert any(d.startswith("swamped") and d.endswith("]") for d in lost(ev)), name
        s, ev = run(boat(name), CALM, 24)
        assert s.alive and s.water_l == 0.0, name


def test_bailing_keeps_up_with_a_light_slop():
    s, _ = run(boat("canoe"), sea(0.8, wind=4.0), 48)
    assert s.alive and s.water_l < 100.0


def test_a_kite_pulls_downwind_and_falls_in_a_lull():
    bin_ = boat("wheelie_bin")
    windy = sea(0.3, wind=7.0)
    flying, ev = run(bin_, windy, 1)
    assert flying.kite_up and not ev
    no_kite = OddBoatVessel(load_design("configs/joke_wheelie_bin.yaml"))
    no_kite.kite_cda_m2 = 0.0
    s = no_kite.initial_state(T0, 36.65, -74.94)
    s = replace(s, kite_up=False)
    s, _ = no_kite.step(s, CMD, windy, timedelta(minutes=10), np.random.default_rng(0))
    assert flying.speed_over_ground > 1.5 * s.speed_over_ground
    s, ev = run(bin_, sea(0.3, wind=1.0), 24)
    assert not s.kite_up and s.damage.get("kite")
    assert any(e.kind == EventKind.PART_FAILED and e.detail.startswith("kite") for e in ev)


def test_loss_words_keep_the_phase_tag():
    robot = boat("robot_kayak")
    e = Event(
        T0, EventKind.LOST, "capsized and stayed upside down (not self-righting) [open ocean]"
    )
    out = robot.reword(e)
    assert out.detail.startswith("rolled by a breaking wave") and out.detail.endswith(
        "[open ocean]"
    )
    other = Event(T0, EventKind.LOST, "taken or snagged by fishermen [near land]")
    assert robot.reword(other) == other


def test_the_flamingo_drifts_with_the_wind_and_never_capsizes():
    s, ev = run(boat("flamingo"), sea(3.0, wind=12.0), 24)
    assert s.alive and s.speed_over_ground > 0.3
    assert not any(e.kind == EventKind.CAPSIZE for e in ev)


def test_the_hull_speed_wall_is_off_unless_asked_for():
    plain = H.HullParams()
    assert plain.wave_wall_fn == 0.0
    walled = replace(plain, wave_wall_fn=0.35, wave_wall_exp=6.0)
    slow, fast = 0.5, 3.0
    assert H.calm_drag(walled, slow) == pytest.approx(H.calm_drag(plain, slow), rel=0.01)
    assert H.calm_drag(walled, fast) > 3 * H.calm_drag(plain, fast)
