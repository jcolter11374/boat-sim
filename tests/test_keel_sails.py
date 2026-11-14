"""M4 wave 1: the keelboats' sail parts (sandbox/catalog.py _keel_sails, _sail_changes).

Each part changes the VPP's inputs, so it sails from its own polar, named by a
fingerprint of those inputs (vessel/vpp.py fingerprint, vessel/keelboat.py VARIANTS).
"""

import json
from pathlib import Path

import pytest

from boatsim.config import load_design
from boatsim.sandbox import catalog as C
from boatsim.vessel.keelboat import VARIANTS, KeelboatVessel, polar_path
from boatsim.vessel.vpp import fingerprint

FT = 0.3048


@pytest.mark.parametrize("boat", C.KEELBOATS)
def test_the_boat_as_built_is_its_yaml_untouched(boat):
    assert C.design_changes({"base": boat}) == ()
    assert C.grid_id({"base": boat}) == boat


@pytest.mark.parametrize("boat", C.KEELBOATS)
def test_every_sail_part_sails_from_its_own_saved_polar(boat):
    """Every grid build's polar is committed (the grid and the page never build one),
    and its file carries the fingerprint of the vpp block it was built from."""
    for g in C.GRID:
        if g.get("base") != boat:
            continue
        d = C.design_for(g)
        name = d.vpp["polar_file"]
        if name.startswith(VARIANTS):
            p = Path("configs") / name
            assert p.exists(), f"{C.grid_id(g)}: run the polar build for {name}"
            assert json.loads(p.read_text())["fingerprint"] == fingerprint(d.vpp)
            assert name.endswith(f"-{fingerprint(d.vpp)}.json")
            assert KeelboatVessel(d).polar.plans == [q["name"] for q in d.vpp["plans"]]


def test_no_stale_variant_polars_are_left_behind():
    used = {C.design_for(g).vpp["polar_file"] for g in C.GRID if g.get("base") in C.KEELBOATS}
    saved = {f"{VARIANTS}/{p.name}" for p in (Path("configs") / VARIANTS).glob("*.json")}
    assert saved == {u for u in used if u.startswith(VARIANTS)}


def test_storm_sails_are_the_offshore_rules_sizes():
    """World Sailing OSR 4.26: storm jib at most 5 % of I^2, trysail 17.5 % of P x E."""
    d = C.design_for({"base": "stock_pearson31_2", "storm": "storm"})
    base = load_design(C.BASES["stock_pearson31_2"])
    storm = d.vpp["plans"][-1]
    i, p, e = 42.5 * FT, 36.8 * FT, 12.0 * FT
    assert storm["name"] == "storm"
    assert storm["jib"] * base.vpp["jib_m2"] == pytest.approx(0.05 * i * i, rel=2e-3)
    assert storm["main"] * base.vpp["main_m2"] == pytest.approx(0.175 * p * e, rel=2e-3)
    assert d.sail["storm_wind_ms"] > base.sail["storm_wind_ms"]


def test_parts_move_what_they_say():
    pear = load_design(C.BASES["stock_pearson31_2"])
    cut = C.design_for({"base": "stock_pearson31_2", "rig": "cutter"})
    assert cut.vpp["plans"][2]["jib"] < pear.vpp["plans"][2]["jib"]  # staysail alone in a blow
    assert cut.hazards["p_part"]["sail"] < pear.hazards["p_part"]["sail"]  # two forestays
    lam = C.design_for({"base": "stock_pearson31_2", "cloth": "laminate"})
    assert lam.vpp["cl_max"] > pear.vpp["cl_max"]
    assert lam.hazards["p_part"]["sail"] > pear.hazards["p_part"]["sail"]
    assert lam.hazards["p_part"]["rudder"] == pear.hazards["p_part"]["rudder"]
    furl = C.design_for({"base": "stock_pearson31_2", "reef": "inmast"})
    assert furl.vpp["main_m2"] < pear.vpp["main_m2"] and len(furl.vpp["plans"]) == 6
    three = C.design_for({"base": "stock_pearson31_2", "reef": "slab3"})
    assert [q["name"] for q in three.vpp["plans"]] == ["full", "reef1", "reef2", "reef3", "storm"]
    solent = C.design_for({"base": "stock_cruiser31", "rig": "solent"})
    assert solent.vpp["jib_m2"] == 21.0  # Beneteau's Solent jib


def test_an_unsaved_combination_builds_its_polar_on_first_use(tmp_path, monkeypatch):
    import boatsim.vessel.keelboat as K

    monkeypatch.setattr(K, "CONFIGS", tmp_path)
    d = C.design_for(
        {"base": "stock_cruiser31", "rig": "solent", "storm": "storm", "cloth": "laminate"}
    )
    p = polar_path(d)
    assert (
        p.parent.name == "variants"
        and str(p).startswith(str(tmp_path))
        and json.loads(p.read_text())["fingerprint"] == fingerprint(d.vpp)
    )


def test_the_page_table_names_each_part_and_lists_what_it_sets():
    t = C.stock_table()["stock_pearson31_2"]
    slots = {s["id"]: s for s in t["slots"]}
    assert set(slots) == {"rig", "cloth", "reef", "storm", "spare", "tactician"}
    lam = next(o for o in slots["cloth"]["opts"] if o["id"] == "laminate")
    assert lam["n"] == "Laminate" and lam["est"] and "vpp.cl_max" in lam["sim"]
    for s in slots.values():
        for o in s["opts"]:
            assert "$" not in o.get("d", "") and "$" not in o["basis"]  # no prices (B7)
