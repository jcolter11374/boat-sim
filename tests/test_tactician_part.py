"""The sailing tactician as a Boatyard part on the stock sailboats."""

import json
from pathlib import Path

import pytest

from boatsim.autonomy.sailing import tactician_for
from boatsim.config import load_design
from boatsim.sandbox import catalog as C
from boatsim.vessel import make_vessel

SAILBOATS = ("stock_cruiser31", "stock_dinghy14", "stock_beachcat16", "stock_sail_drone7")


@pytest.mark.parametrize("base", SAILBOATS)
def test_on_is_each_boat_as_it_comes(base):
    # The default is what the yaml says (no key: on), and leaves the file untouched.
    plain = load_design(C.BASES[base])
    assert plain.electronics.get("tactician", True) is True
    assert C.defaults_for(base)["tactician"] == "on"
    assert C.design_changes({"base": base}) == ()
    assert C.design_changes({"base": base, "tactician": "on"}) == ()
    assert tactician_for(make_vessel(C.design_for({"base": base}))) is not None


@pytest.mark.parametrize("base", SAILBOATS)
def test_off_steers_without_it(base):
    d = C.design_for({"base": base, "tactician": "off"})
    assert C.design_changes({"base": base, "tactician": "off"}) == (
        ("electronics", "tactician", False),
    )
    assert tactician_for(make_vessel(d)) is None
    assert C.grid_id({"base": base, "tactician": "off"}) == f"{base}-tactician.off"


def test_it_is_software_only():
    for o in C.TACTICIAN_SLOT.values():
        assert (o.kg, o.hotel_wh) == (0.0, 0.0)
    assert "GUESS" in C.TACTICIAN_SLOT["on"].basis  # the wind vane a boat may need


def test_the_ids_work_on_a_yaml_that_has_it_off():
    # Rev B/C set tactician: false; the same "on" option has to switch it on there.
    base = load_design(C.REV_C)
    assert base.electronics["tactician"] is False
    sec, key, val = C.TACTICIAN_SLOT["on"].changes[0]
    assert base.electronics.get(key, C.KEY_DEFAULTS[(sec, key)]) != val


def test_the_page_table_has_it():
    t = C.stock_table()
    for base in SAILBOATS:
        slot = next(s for s in t[base]["slots"] if s["id"] == "tactician")
        assert slot["name"] == "Sailing tactician"
        assert {o["id"]: o["sim"] for o in slot["opts"]} == {
            "on": ["electronics.tactician"],
            "off": ["electronics.tactician"],
        }
    page = json.loads(Path("sea3d/public/sim-slots.json").read_text())
    assert page["stock"] == json.loads(json.dumps(t))
