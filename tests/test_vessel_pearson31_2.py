"""Randolph and Becky's Pearson 31-2 (deep keel), our model from published class
specs (configs/stock_pearson31_2.yaml). No published polar to fit, so these check
the inputs against the sources and the speeds against the cruiser and PHRF."""

import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
import yaml

from boatsim.config import load_design
from boatsim.runner.replay import design_for
from boatsim.sandbox import catalog as C
from boatsim.types import Command, EnvState
from boatsim.vessel import KeelboatVessel, make_vessel
from boatsim.vessel import vpp as V
from boatsim.vessel.keelboat import KNOT

CFG = "configs/stock_pearson31_2.yaml"
FT, LB = 0.3048, 0.45359237


@pytest.fixture(scope="module")
def raw():
    return yaml.safe_load(Path(CFG).read_text())


def test_inputs_are_pearsons_published_numbers(raw):
    """Pearson Yachts' spec sheet: LWL 25.4 ft, beam 10.8, draft 5.6 (deep keel),
    10,000 lb with 3,800 lb ballast, P 36.8 x E 12.0, mast 46.3 ft above the water."""
    v, card = raw["vpp"], raw["stock"]["spec_card"]
    assert v["lwl_m"] == pytest.approx(25.4 * FT, abs=0.005)
    assert v["disp_kg"] == pytest.approx(10000 * LB, abs=1)
    assert card["ballast_kg"] == pytest.approx(3800 * LB, abs=1)
    assert card["beam_m"] == pytest.approx(10.8 * FT, abs=0.005)
    assert card["draft_m"] == pytest.approx(5.6 * FT, abs=0.005)
    assert v["main_m2"] == pytest.approx(0.5 * 36.8 * 12.0 * FT * FT, abs=0.01)
    assert v["rig_height_m"] == pytest.approx(46.3 * FT, abs=0.01)
    assert raw["hull"]["mass_kg"] == v["disp_kg"]
    assert "Randolph" in raw["name"] and "our model" in raw["name"]


def test_polar_file_is_the_vpp_output(raw):
    t = json.loads(Path("configs", raw["vpp"]["polar_file"]).read_text())
    p = V.VPPParams.from_config(raw["vpp"])
    i, j = t["tws_kn"].index(12), t["twa_deg"].index(90)
    pt = V.solve(p, 12 * KNOT, 90, p.plans[0], 0.0)
    assert t["plans"]["full"]["speed_kn"][i][j] == pytest.approx(
        pt.speed * p.autopilot_factor / KNOT, abs=0.002
    )
    assert set(t["plans"]) == {"full", "reef1", "reef2", "storm"}


def test_slower_than_the_cruiser_by_about_what_phrf_says(raw):
    """PHRF (Good Old Boat): this boat 156-165 s/mile, the First 31.7 132-144, about
    3.5 % slower with a race crew. Shorter and heavier, ours is 5-10 % slower."""
    p = V.VPPParams.from_config(raw["vpp"])
    c = V.VPPParams.from_config(
        yaml.safe_load(Path("configs/stock_cruiser31.yaml").read_text())["vpp"]
    )
    ratios = [
        V.solve(p, w * KNOT, a, p.plans[0], 0.0).speed
        / V.solve(c, w * KNOT, a, c.plans[0], 0.0).speed
        for w in (8, 12, 16)
        for a in (52, 90, 135)
    ]
    assert 0.90 < float(np.mean(ratios)) < 0.95
    hull_speed = 1.34 * (25.4**0.5)  # kn, the class figure 6.75
    assert V.solve(p, 16 * KNOT, 90, p.plans[0], 0.0).speed / KNOT < hull_speed * 1.05


def test_sails_as_a_stock_base_and_replays_find_its_file():
    d = load_design(CFG)
    v = make_vessel(d)
    assert isinstance(v, KeelboatVessel) and v.autopilot_factor == 0.93
    assert C.BASES["stock_pearson31_2"] == CFG
    assert design_for({"boat": d.name}) == CFG
    beam = EnvState(wind_u=0.0, wind_v=6.2, hs=1.0, tp=6, wave_dir=0)  # 12 kn from the south
    s = v.initial_state(datetime(2020, 5, 1), 36.65, -74.94)
    rng = np.random.default_rng(0)
    for _ in range(6):
        s, _ = v.step(s, Command(90, 0.0, engine=False), beam, timedelta(minutes=10), rng)
    assert 4.0 < s.speed_through_water / KNOT < 6.75


def test_committed_trim_table_is_the_vpp_output(raw):
    """Hand trim for "Take the wheel" (vpp.py --trim), as the cruiser's."""
    p = V.VPPParams.from_config(raw["vpp"])
    t = json.loads(Path("configs/polars/pearson31_2_trim.json").read_text())
    assert set(t["plans"]) == {"full", "reef1", "reef2", "storm"}
    assert t["autopilot_factor"] == p.autopilot_factor
    i, j, k = t["tws_kn"].index(12), t["twa_deg"].index(90), 4
    x = V.solve_trim(V.hand_sailed(p), 12 * KNOT, 90, p.plans[0], t["sheet_deg"][k], 0.0)
    assert t["plans"]["full"]["speed_kn"][i][j][k] == pytest.approx(x.speed / KNOT, abs=0.002)
