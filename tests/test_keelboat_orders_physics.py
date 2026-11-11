"""Ravi (QA), 11 Nov 2026: the stock cruiser can't cheat the physics with sail
and engine orders (#242, docs/qa/helm-sail-engine-orders.md). Findings 1, 2, 3
and 5. These FAIL on main today: they ship with Theo's keelboat fix, not alone.

Each test drives KeelboatVessel directly: a fixed EnvState, 10-minute steps.
"""

import math
from dataclasses import replace
from datetime import datetime, timedelta

import numpy as np
import pytest

from boatsim.config import load_design
from boatsim.types import Command, EnvState
from boatsim.vessel.keelboat import KeelboatVessel

CFG = "configs/stock_cruiser31.yaml"
T0 = datetime(2020, 5, 1, 12)
DT = timedelta(minutes=10)
NM = 1852.0
CALM = EnvState()


@pytest.fixture(scope="module")
def boat():
    return KeelboatVessel(load_design(CFG))


@pytest.fixture(scope="module")
def sound_boat():
    """No random breakdowns (Theo: over 3,000 h one would stop the engine first)."""
    v = KeelboatVessel(load_design(CFG))
    v.hazards = replace(v.hazards, enabled=False, failures_enabled=False)
    return v


def sail(boat, env, cmd, hours, seed=1, state=None, until_fuel_out=False):
    """Step the boat; returns (final state, km east, km north, hours sailed)."""
    s = state if state is not None else boat.initial_state(T0, 37.0, -60.0)
    lat0, lon0 = s.lat, s.lon
    rng = np.random.default_rng(seed)
    n = 0
    for n in range(1, int(hours * 6) + 1):
        s, _ = boat.step(s, cmd, env, DT, rng)
        if not s.alive or (until_fuel_out and s.fuel_l <= 0.0):
            break
    east = (s.lon - lon0) * 111.32 * math.cos(math.radians(lat0))
    north = (s.lat - lat0) * 111.32
    return s, east, north, n / 6.0


def made_good_kn(east_km, north_km, hours, toward_deg):
    """Speed made good along a compass bearing, knots."""
    b = math.radians(toward_deg)
    along = east_km * math.sin(b) + north_km * math.cos(b)
    return along * 1000.0 / NM / hours


# ---- the healthy baseline the fixes must keep -------------------------------


def test_healthy_boat_motors_on_course_in_a_calm(boat):
    s0 = replace(boat.initial_state(T0, 37.0, -60.0), heading=0.0)
    _s, e, n, h = sail(boat, CALM, Command(90.0, 0.7, None, True), 1.0, state=s0)
    assert made_good_kn(e, n, h, 90.0) > 4.5


# ---- 1. no steering under engine without rudder and autopilot ---------------


@pytest.mark.parametrize(
    "broken",
    [{"rudder": True}, {"electronics_main": True}, "flat"],
    ids=["rudder gone", "autopilot dead", "battery flat"],
)
def test_engine_does_not_steer_without_rudder_or_autopilot(boat, broken):
    # Pointing north, ordered east: with nothing to steer, the engine can't turn it.
    s0 = replace(boat.initial_state(T0, 37.0, -60.0), heading=0.0)
    if broken == "flat":
        s0 = replace(s0, battery_wh=0.0, electronics_on=False)
    else:
        s0 = replace(s0, damage={**s0.damage, **broken})
    s, e, n, h = sail(boat, CALM, Command(90.0, 0.7, None, True), 1.0, state=s0)
    assert made_good_kn(e, n, h, 90.0) < 0.5, f"held the ordered course {s.heading:.0f} deg"


# ---- 2. no low-throttle creep: a full tank has a real range -----------------


@pytest.mark.parametrize("throttle", [1.0, 0.3, 0.1, 0.03, 0.01])
def test_full_tank_range_is_bounded_at_any_throttle(sound_boat, throttle):
    # 30 L on a 31 ft boat with a 21 hp diesel: a couple of hundred miles, not an ocean.
    # Today 1 % throttle motors 1,500 h and about 1,900 nm.
    # Theo: a sunny calm and no breakdowns, so the tank ends it, not the battery (the
    # engine doesn't charge it; flat, the autopilot and so the engine stop) or a broken
    # rudder.
    sunny = EnvState(ghi=600.0)
    cmd = Command(90.0, throttle, None, True)
    s, e, n, h = sail(sound_boat, sunny, cmd, 3000.0, until_fuel_out=True)
    nm = math.hypot(e, n) * 1000.0 / NM
    assert s.fuel_l <= 0.0, f"{throttle:.0%}: still {s.fuel_l:.1f} L after {h:.0f} h"
    assert nm <= 300.0, f"{throttle:.0%}: {nm:.0f} nm on 30 L"


# ---- 3. overcanvassed in a gale has a price ---------------------------------


def test_full_sail_in_a_gale_risks_the_sails_and_auto_reefing_does_not(boat):
    # 40 kn from the north, reaching east for a day, 20 sets of dice.
    gale = EnvState(wind_v=-20.6, hs=5.0, tp=9.0, wave_dir=0.0)
    seeds = range(20)

    def torn(plan):
        return sum(
            bool(
                sail(boat, gale, Command(90.0, 0.0, plan, False), 24.0, seed=k)[0].damage.get(
                    "sail"
                )
            )
            for k in seeds
        )

    full, auto = torn("full"), torn(None)
    assert full >= 10, f"full sail at 40 kn for a day tore the sails {full}/20 times"
    assert auto <= 2, f"the boat's own reefing tore them {auto}/20 times"


# ---- 5. the wind pushes back on a motoring boat ------------------------------


def test_motoring_into_a_storm_makes_no_headway(boat):
    # Wind 25 m/s (49 kn) and 6 m seas from the east, sails down, engine flat out east.
    # Today: 1.9 kn straight into it, because the motor speed ignores windage.
    storm = EnvState(wind_u=-25.0, hs=6.0, tp=10.0, wave_dir=90.0)
    s0 = replace(boat.initial_state(T0, 37.0, -60.0), heading=90.0)
    _s, e, n, h = sail(boat, storm, Command(90.0, 1.0, "down", True), 1.0, state=s0)
    assert made_good_kn(e, n, h, 90.0) < 0.5
