"""M4 wave 3: self-steering and power for the keelboats, and the kayak's T500s.

Windvane (vessel/kayak.py windvane), hydrogenerator (vessel/keelboat.py hydro_*),
bigger solar and a lithium bank (power block), T500 thrusters (vessel/propulsion.py).
"""

from dataclasses import replace
from datetime import datetime, timedelta

import numpy as np
import pytest

from boatsim.sandbox import catalog as C
from boatsim.types import Command, EnvState
from boatsim.vessel import make_vessel
from boatsim.vessel.propulsion import ThrusterParams, thrust_one

T0 = datetime(2020, 5, 1, 12)
BEAM = EnvState(wind_u=0.0, wind_v=6.2, hs=1.0, tp=6, wave_dir=0, ghi=500)  # 12 kn from the south
DEAD = {"electronics_main": True, "electronics_safe": True}


def boat(**picks):
    return make_vessel(C.design_for({"base": "stock_pearson31_2", **picks}))


def run(v, env, cmd, steps=6, damage=None, after=None):
    """Sail a few steps with the autopilot, then (optionally) break things and sail on."""
    s = v.initial_state(T0, 36.65, -74.94)
    rng = np.random.default_rng(0)
    for _ in range(steps):
        s, _ = v.step(s, cmd, env, timedelta(minutes=10), rng)
    if damage:
        s = replace(s, damage={**s.damage, **damage})
        for _ in range(steps):
            s, _ = v.step(
                s, Command((cmd.heading + 90) % 360, 0.0), after or env, timedelta(minutes=10), rng
            )
    return s


@pytest.mark.parametrize("kind", ["hydrovane", "monitor"])
def test_a_windvane_sails_on_at_her_angle_to_the_wind_when_the_autopilot_dies(kind):
    s = run(boat(vane=kind), BEAM, Command(90, 0.0), damage=DEAD)
    assert s.speed_through_water > 2.0  # still sailing, not drifting
    assert s.heading == pytest.approx(90.0, abs=5)  # beam reach held (wind from 180)
    veer = replace(BEAM, wind_u=-4.4, wind_v=4.4)  # the wind backs 45 deg: she follows it
    s = run(boat(vane=kind), BEAM, Command(90, 0.0), damage=DEAD, after=veer)
    assert s.heading == pytest.approx(45.0, abs=5)
    plain = run(boat(), BEAM, Command(90, 0.0), damage=DEAD)
    assert plain.speed_through_water < 1.0  # no vane: she drifts


def test_only_the_hydrovane_steers_with_the_main_rudder_gone():
    gone = {"rudder": True}
    assert (
        run(boat(vane="hydrovane"), BEAM, Command(90, 0.0), damage=gone).speed_through_water > 2.0
    )
    mon = run(boat(vane="monitor"), BEAM, Command(90, 0.0), damage=gone)
    plain = run(boat(), BEAM, Command(90, 0.0), damage=gone)
    assert mon.heading == pytest.approx(plain.heading, abs=1)  # the Monitor needs her rudder


def test_a_windvane_saves_most_of_the_autopilots_power():
    d = C.design_for({"base": "stock_pearson31_2", "vane": "hydrovane"})
    base = C.design_for({"base": "stock_pearson31_2"})
    assert d.electronics["hotel_load_wh_per_day"] < 0.5 * base.electronics["hotel_load_wh_per_day"]
    assert d.hull["mass_kg"] == base.hull["mass_kg"] + 37  # Hydrovane's average fit


def test_the_hydrogenerator_charges_from_her_speed_and_slows_her_a_little():
    v = boat(hydro="pod600")
    assert v.hydro_power_w(5 * 0.514444) == pytest.approx(120)  # Watt&Sea: 120 W at 5 kn
    assert v.hydro_power_w(15 * 0.514444) == 600  # rated
    dark = replace(BEAM, ghi=0)
    a, b = run(boat(), dark, Command(90, 0.0)), run(v, dark, Command(90, 0.0))
    assert b.battery_wh > a.battery_wh  # charging at night
    assert 0.9 * a.speed_through_water < b.speed_through_water < a.speed_through_water


def test_solar_and_lithium_change_the_power_block():
    sol = C.design_for({"base": "stock_cruiser31", "ksol": "600w"})
    assert sol.power["solar_wp"] == 600 and sum(sol.power["panels_w"].values()) == 600
    lfp = C.design_for({"base": "stock_cruiser31", "kbat": "lfp"})
    assert lfp.power["battery_wh"] == 5120  # 4 x 12.8 V x 100 Ah (Battle Born)
    assert lfp.power["charge_eff"] > C.design_for({"base": "stock_cruiser31"}).power["charge_eff"]


def test_t500s_give_more_thrust_for_the_same_watts():
    t200 = ThrusterParams()
    t500 = ThrusterParams(diameter_m=C.T500_DIAMETER_M, efficiency=C.T500_EFFICIENCY)
    for w in (10, 25, 50):
        assert thrust_one(t500, w, 1.0) > 1.3 * thrust_one(t200, w, 1.0)
    d = C.design_for({"thr": "two-t500"})
    assert d.propulsion["thruster_diameter_m"] == C.T500_DIAMETER_M
    assert d.propulsion["max_drive_w"] == 100  # the same 50 W each
