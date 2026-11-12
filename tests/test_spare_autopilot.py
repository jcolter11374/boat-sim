"""The spare autopilot: a second electronics box a player can add to a stock boat."""

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest

from boatsim.config import load_design
from boatsim.sandbox import catalog as C
from boatsim.types import Command, EnvState
from boatsim.vessel import make_vessel

SPARE_BASES = ("stock_cruiser31", "stock_dinghy14", "stock_beachcat16", "stock_sail_drone7")


@pytest.mark.parametrize("base", SPARE_BASES)
def test_the_spare_is_a_choice_not_a_default(base):
    assert C.defaults_for(base)["spare"] == "none"
    assert C.design_changes({"base": base}) == ()  # as it comes: the yaml untouched
    plain = load_design(C.BASES[base])
    d = C.design_for({"base": base, "spare": "spare-autopilot"})
    assert plain.hazards["electronics_boxes"] == 1
    assert d.hazards["electronics_boxes"] == 2
    assert d.hull["mass_kg"] == pytest.approx(plain.hull["mass_kg"] + 0.4)
    hotel = plain.electronics["hotel_load_wh_per_day"] + 4.0
    assert d.electronics["hotel_load_wh_per_day"] == hotel
    assert C.grid_id({"base": base, "spare": "spare-autopilot"}) == f"{base}-spare.spare-autopilot"


def test_the_spare_figures_are_the_parts_lists_second_box():
    cat = json.loads(Path("sea3d/public/parts-catalog.json").read_text())
    brain = {o["id"]: o for o in next(s for s in cat["slots"] if s["id"] == "brain")["opts"]}
    two, one = brain["two-box"], brain["one-box"]
    assert C.SPARE_BOX.cost == two["cost"] - one["cost"]
    assert C.SPARE_BOX.kg == pytest.approx(two["kg"] - one["kg"])
    assert C.SPARE_BOX.hotel_wh == two["wh"] - one["wh"]


def test_boats_without_an_autopilot_box_have_no_spare_slot():
    for base in ("stock_ocean_rower45", "joke_bathtub", "joke_robot_kayak"):
        assert C.slots_for(base) == {}
        with pytest.raises(ValueError, match="unknown slot"):
            C.normalise({"base": base, "spare": "spare-autopilot"})


def test_the_page_table_matches_the_catalog():
    t = C.stock_table()
    assert set(t) == set(SPARE_BASES)
    spare = next(s for s in t["stock_cruiser31"]["slots"] if s["id"] == "spare")
    opts = {o["id"]: o for o in spare["opts"]}
    assert opts["spare-autopilot"]["cost"] == 83
    assert opts["spare-autopilot"]["sim"] == [
        "hazards.electronics_boxes", "electronics.hotel_load_wh_per_day", "hull.mass_kg",
    ]  # fmt: skip
    page = json.loads(Path("sea3d/public/sim-slots.json").read_text())
    assert page["stock"] == json.loads(json.dumps(t))


def _sail_one_hour(vessel, damage):
    s = vessel.initial_state(datetime(2020, 5, 1, 12, tzinfo=UTC), 40.0, -50.0)
    s = replace(s, damage=dict(damage), heading=90.0)
    env = EnvState(wind_v=-7.0, ghi=500.0)  # 14 kn from the north: a beam reach east
    rng = np.random.default_rng(0)
    for _ in range(6):
        s, _ = vessel.step(
            s, Command(heading=90.0, thrust_fraction=0.0), env, timedelta(minutes=10), rng
        )
    return s


def test_the_spare_box_keeps_a_sailboat_steering():
    v = make_vessel(C.design_for({"base": "stock_cruiser31", "spare": "spare-autopilot"}))
    steered = _sail_one_hour(v, {"electronics_main": True})
    adrift = _sail_one_hour(v, {"electronics_main": True, "electronics_safe": True})
    assert abs(steered.heading - 90.0) < 20.0  # still on course with the spare
    assert abs(adrift.heading - 90.0) > 45.0  # nothing steering: lies to the wind
