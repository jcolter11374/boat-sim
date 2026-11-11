"""Stock vessel: the 31 ft cruiser (configs/stock_cruiser31.yaml), its VPP
(vessel/vpp.py) and the polar-sailed KeelboatVessel (vessel/keelboat.py)."""

import json
import math
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
import yaml

from boatsim.config import load_design
from boatsim.types import Command, EnvState
from boatsim.vessel import KayakVessel, KeelboatVessel, make_vessel
from boatsim.vessel import vpp as V
from boatsim.vessel.keelboat import KNOT, Polar

CFG = "configs/stock_cruiser31.yaml"
T0 = datetime(2020, 5, 1)


@pytest.fixture(scope="module")
def raw():
    return yaml.safe_load(Path(CFG).read_text())["vpp"]


@pytest.fixture(scope="module")
def boat():
    return make_vessel(load_design(CFG))


def _run(v, env, cmd, steps=3):
    s = v.initial_state(T0, 36.65, -74.94)
    rng = np.random.default_rng(0)
    for _ in range(steps):
        s, _ = v.step(s, cmd, env, timedelta(minutes=10), rng)
    return s


def test_vpp_matches_the_orc_certificate_upwind_and_reaching(raw):
    """The design note's gate: within 5 % of ORC from 8 to 20 kn, with the
    certificate's crew on the rail. Downwind ORC flies a spinnaker and we
    don't, so there we are slower (but not absurdly)."""
    ref = raw["orc"]
    crewed = replace(
        V.VPPParams.from_config(raw), crew_kg=ref["crew_kg"], crew_arm_m=ref["crew_arm_m"]
    )
    rows = V.compare(crewed, ref, 8, 20)
    up = [r for r in rows if r["what"] in ("beat", 52, 75, 90)]
    assert len(up) == 24
    worst = max(abs(r["model"] / r["ref"] - 1) for r in up)
    assert worst < 0.05, worst
    down = [r["model"] / r["ref"] for r in rows if r["what"] in (135, 150)]
    assert all(0.8 < x < 1.0 for x in down)


def test_polar_file_is_the_vpp_output(raw):
    """The committed polar is what the VPP writes for this config (spot check)."""
    t = json.loads(Path("configs", raw["polar_file"]).read_text())
    p = V.VPPParams.from_config(raw)
    j = t["twa_deg"].index(90)
    i = t["tws_kn"].index(12)
    pt = V.solve(p, 12 * KNOT, 90, p.plans[0], 0.0)
    assert t["plans"]["full"]["speed_kn"][i][j] == pytest.approx(
        pt.speed * p.autopilot_factor / KNOT, abs=0.002
    )
    assert set(t["plans"]) == {"full", "reef1", "reef2", "storm"}


def test_polar_physics_makes_sense():
    pol = Polar.load("configs/polars/cruiser31.json")
    full = [pol.at("full", 12, a).speed for a in (45, 90, 150)]
    assert full[1] > full[0] and full[1] > full[2]  # fastest on a reach
    assert pol.at("full", 12, 25).speed == 0.0  # in irons
    assert pol.at("full", 2, 90).speed == pytest.approx(pol.at("full", 4, 90).speed / 2)
    assert pol.at("storm", 12, 90).speed < pol.at("full", 12, 90).speed  # less sail, slower
    assert pol.at("full", 20, 50).heel_deg > pol.at("reef2", 20, 50).heel_deg
    assert max(pol.at("full", w, 90).speed for w in range(4, 41)) / KNOT < 10  # no planing
    assert 36 <= pol.beat_deg(12 * KNOT) <= 46
    assert pol.speed_ms(6.0, 90) == max(pol.at(n, 6.0 / KNOT, 90).speed for n in pol.plans)


def test_only_designs_with_a_polar_get_the_keelboat_model(boat):
    assert isinstance(boat, KeelboatVessel)
    kayak = make_vessel(load_design("configs/v4_kayak.yaml"))
    assert isinstance(kayak, KayakVessel) and not isinstance(kayak, KeelboatVessel)
    assert Command(90, 0.5).sail_plan is None and Command(90, 0.5).engine is None


def test_sails_reaches_and_heels_away_from_the_wind(boat):
    beam = EnvState(wind_u=0.0, wind_v=6.2, hs=1.0, tp=6, wave_dir=0)  # 12 kn from the south
    s = _run(boat, beam, Command(90, 0.7))
    assert s.heading == 90 and s.sail_plan == "full" and not s.engine_on
    assert 5.5 < s.speed_through_water / KNOT < 7.2  # polar 6.5 kn, a little off for the sea
    assert s.heel_deg < 0 and s.leeway_deg < 0  # wind from starboard: leans and slides to port
    flat = _run(boat, replace(beam, hs=0.0), Command(90, 0.7))
    assert flat.speed_through_water > s.speed_through_water  # waves slow it


def test_cant_sail_into_the_wind(boat):
    westerly = EnvState(wind_u=6.2, wind_v=0.0, hs=1.0, tp=6, wave_dir=270)
    s = _run(boat, westerly, Command(270, 0.7))
    off = abs((s.heading - 270 + 180) % 360 - 180)
    assert 44 <= off <= 46  # sails 45 deg off the wind, close-hauled


def test_reefs_itself_in_a_gale_and_runs_off_in_a_storm(boat):
    gale = EnvState(wind_u=0.0, wind_v=18.0, hs=4.5, tp=9, wave_dir=180)  # 35 kn
    s = _run(boat, gale, Command(90, 0.7))
    assert s.sail_plan in ("reef1", "reef2", "storm") and abs(s.heel_deg) <= 25
    storm = EnvState(wind_u=28.0, wind_v=0.0, hs=9.0, tp=12, wave_dir=270)  # 55 kn
    s = _run(boat, storm, Command(90, 0.7))
    assert s.sail_plan == "down" and 2 < s.speed_through_water / KNOT < 7  # bare poles


def test_player_orders_a_sail_plan(boat):
    beam = EnvState(wind_u=0.0, wind_v=6.2, hs=1.0, tp=6, wave_dir=0)
    full = _run(boat, beam, Command(90, 0.7))
    reefed = _run(boat, beam, Command(90, 0.7, sail_plan="reef2"))
    down = _run(boat, beam, Command(90, 0.7, sail_plan="down"))
    assert reefed.sail_plan == "reef2" and reefed.speed_through_water < full.speed_through_water
    assert down.sail_plan == "down" and down.speed_through_water < 0.5 * KNOT  # drifting


def test_motors_in_a_calm_and_burns_fuel(boat):
    calm = EnvState(wind_u=1.0, wind_v=0.0, hs=0.3, tp=6, wave_dir=270)
    s = _run(boat, calm, Command(90, 0.7))
    assert s.engine_on and 5.0 < s.speed_through_water / KNOT < 6.0
    assert s.fuel_l == pytest.approx(30 - 2.0 * 0.7 * 0.5)  # 0.5 h at 70 %
    off = _run(boat, calm, Command(90, 0.7, engine=False))
    assert not off.engine_on and off.fuel_l == 30 and off.speed_through_water < 1.5 * KNOT
    breezy = EnvState(wind_u=0.0, wind_v=6.2, hs=1.0, tp=6, wave_dir=0)
    assert not _run(boat, breezy, Command(90, 0.7)).engine_on  # sails when there's wind
    forced = _run(boat, breezy, Command(90, 0.7, engine=True))
    assert forced.fuel_l < 30  # motor-sailing on order
    empty = boat.initial_state(T0, 36.65, -74.94)
    empty.fuel_l = 0.0
    s2, _ = boat.step(
        empty, Command(90, 0.7), calm, timedelta(minutes=10), np.random.default_rng(0)
    )
    assert not s2.engine_on


def test_broken_rig_means_no_sailing(boat):
    beam = EnvState(wind_u=0.0, wind_v=6.2, hs=1.0, tp=6, wave_dir=0)
    s = boat.initial_state(T0, 36.65, -74.94)
    s.damage["sail"] = True
    s2, _ = boat.step(s, Command(90, 0.7), beam, timedelta(minutes=10), np.random.default_rng(0))
    assert s2.sail_plan == "down" and s2.speed_through_water < 0.5 * KNOT


def test_a_voyage_runs_end_to_end():
    from boatsim.oceandata import ConstantEnvironment
    from boatsim.runner.simulate import default_mission, simulate, standard_components

    env = ConstantEnvironment(EnvState(wind_u=7.0, hs=1.5, tp=7, wave_dir=270, ghi=300))
    c = standard_components(load_design(CFG), env, env, seed=1)
    log = simulate(c, T0, 36.65, -74.94, default_mission((36.65, -74.94)), seed=1, max_days=1)
    last = log.rows[-1]
    made_km = math.hypot((last["lon"] + 74.94) * 89.0, (last["lat"] - 36.65) * 111.0)
    assert 200 < made_km < 300  # about 5.6 kn, 250 km a day
    # The log carries the yacht's own state for the 3D page (wind from the west on
    # its port quarter: it leans a little to starboard under full sail).
    assert last["sail_plan"] == "full" and last["engine_on"] is False
    assert 0.0 <= last["heel"] < 5.0


# --- the joke fleet's small boats: a crewless dinghy and beach cat --------------------

SMALL = ("configs/stock_dinghy14.yaml", "configs/stock_beachcat16.yaml")


@pytest.mark.parametrize("cfg", SMALL)
def test_small_boats_load_with_generic_labels_and_sources(cfg):
    d = load_design(cfg)
    assert d.stock["label"] and d.stock["based_on"].startswith("published class specs of")
    assert d.stock["sources"] and isinstance(make_vessel(d), KeelboatVessel)


@pytest.mark.parametrize("cfg", SMALL)
def test_squalls_flip_small_boats_but_never_the_cruiser(cfg, boat):
    v = make_vessel(load_design(cfg))
    m0 = v.polar.at(v.choose_plan(12, 90, None), 12, 90).m0_nm
    dry, squall = v.gust_capsize_p(m0, 1.0, 0.0), v.gust_capsize_p(m0, 1.0, 4.0)
    assert dry < 0.001 and squall > 0.2
    cm0 = boat.polar.at("full", 16, 60).m0_nm
    assert boat.gust_capsize_p(cm0, 24.0, 10.0) == 0.0  # ballast: wind alone can't flip it


@pytest.mark.parametrize("cfg", SMALL)
def test_once_over_it_stays_over(cfg, monkeypatch):
    v = make_vessel(load_design(cfg))
    monkeypatch.setattr(v, "gust_capsize_p", lambda *a: 1.0)
    env = EnvState(wind_u=0.0, wind_v=5.0, hs=0.8, tp=5, wave_dir=0, rain=4.0)
    s = v.initial_state(T0, 36.65, -74.94)
    s2, ev = v.step(s, Command(90, 0.0), env, timedelta(minutes=10), np.random.default_rng(0))
    kinds = [e.kind.name for e in ev]
    assert "CAPSIZE" in kinds and "LOST" in kinds and not s2.alive


def test_breaking_seas_roll_a_dinghy_long_before_a_yacht(boat):
    from boatsim.vessel.hazards import knockdown_rate_per_hour

    dinghy = make_vessel(load_design(SMALL[0]))
    r_dinghy = knockdown_rate_per_hour(dinghy.hazards, 3.0, 7.0, 12.0)
    r_yacht = knockdown_rate_per_hour(boat.hazards, 3.0, 7.0, 12.0)
    assert r_dinghy > 1000 * r_yacht and r_dinghy > 0.005


def test_a_cat_is_fast_and_a_dinghy_has_no_engine():
    cat = Polar.load("configs/polars/beachcat16.json")
    cruiser = Polar.load("configs/polars/cruiser31.json")
    assert cat.speed_ms(14 * KNOT, 135) > cruiser.speed_ms(14 * KNOT, 135)  # downwind flyer
    dinghy = make_vessel(load_design(SMALL[0]))
    calm = EnvState(wind_u=1.0, wind_v=0.0, hs=0.2, tp=5, wave_dir=270)
    s = _run(dinghy, calm, Command(90, 1.0))
    assert not s.engine_on and s.speed_through_water < 1.0 * KNOT


def test_cruiser_power_and_breakdowns_are_its_own(boat):
    """Ravi's fairness check (docs/qa/stock-cruiser31-fairness.md): solar covers the
    960 Wh/day load, one autopilot (no spare box), and a leak can sink it."""
    hz = boat.hazards
    assert hz.electronics_boxes == 1 and boat.p_sink_given_leak > 0
    assert load_design(CFG).power["solar_wp"] >= 400
    for cfg in SMALL:
        v = make_vessel(load_design(cfg))
        assert v.hazards.electronics_boxes == 1 and v.p_sink_given_leak == 0  # foam / sealed


def test_a_leak_can_sink_the_cruiser_and_a_flat_battery_stops_the_pump(boat, monkeypatch):
    beam = EnvState(wind_u=0.0, wind_v=6.2, hs=1.0, tp=6, wave_dir=0, ghi=300)
    rng = np.random.default_rng(0)
    s = boat.initial_state(T0, 36.65, -74.94)
    s.damage["leak_main_tub"] = True  # an open leak the pump is coping with
    s2, ev = boat.step(s, Command(90, 0.7), beam, timedelta(minutes=10), rng)
    assert s2.alive  # not a new leak: the pump keeps up
    s.battery_wh = 0.0
    s3, ev = boat.step(s, Command(90, 0.7), replace(beam, ghi=0.0), timedelta(minutes=10), rng)
    assert not s3.alive and any("bilge pump" in e.detail for e in ev)
