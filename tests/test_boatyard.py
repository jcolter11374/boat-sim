"""Boatyard grid (mc/boatyard.py): the builds the yard page offers, the slim
replays it plays, and the index it looks builds up in."""

import json
from datetime import datetime, timedelta

import numpy as np

from boatsim.config import load_design
from boatsim.mc import boatyard as Y
from boatsim.mc.sensitivity import patched_design
from boatsim.types import Command, EnvState
from boatsim.vessel import KayakVessel
from boatsim.vessel.hazards import HazardParams


def test_grid_is_catalog_builds_and_two_rev_b_builds():
    assert len(Y.BUILDS) == 28 + 12 + 1 + 2  # kayak grid, Randolph grid, Rev B spar, cat bracket
    assert {"k-p25", "k-p10", "k-p25-brain.one-box", "revb", "revb-spar"} <= set(Y.BUILDS)
    assert Y.BUILDS["k-p25"].options["thr"] == "two-t200"


def test_builds_patch_the_design_as_labelled():
    d = patched_design(load_design(Y.KAYAK), Y.BUILDS["k-p25-thr.one-t200"].variant.design)
    assert d.propulsion["thruster_count"] == 1 and d.propulsion["max_drive_w"] == 50
    assert d.propulsion["cruise_drive_w"] == 25
    assert Y.BUILDS["k-p25-thr.one-t200"].label == "Our kayak, Thrusters: one-t200"
    # The glossary's names (docs/glossary.md): "our kayak", never "the kayak as it stands".
    assert Y.BUILDS["k-p25"].label == "Our kayak"
    assert Y.BUILDS["k-p15"].label == "Our kayak, 15 W cruise"
    assert Y.BUILDS["revc"].label == "Rev C as built (our model)"
    assert all(
        "as it stands" not in b.label and "published" not in b.label for b in Y.BUILDS.values()
    )
    one = patched_design(load_design(Y.KAYAK), Y.BUILDS["k-p25-brain.one-box"].variant.design)
    assert HazardParams.from_config(one.hazards).electronics_boxes == 1
    # The current build is the design as it stands.
    assert Y.BUILDS[Y.CURRENT].variant.design == ()
    # Stronger spar: only the wing's knockdown damage changes.
    rb = load_design(Y.REV_B)
    spar = patched_design(rb, Y.BUILDS["revb-spar"].variant.design)
    p0 = HazardParams.from_config(rb.hazards).p_part
    p1 = HazardParams.from_config(spar.hazards).p_part
    assert p1["sail"] == round(p0["sail"] / 10, 9)
    assert {k: v for k, v in p1.items() if k != "sail"} == {
        k: v for k, v in p0.items() if k != "sail"
    }


def test_one_box_kayak_with_a_dead_box_drifts_without_power_to_the_motors():
    d = patched_design(load_design(Y.KAYAK), Y.BUILDS["k-p25-brain.one-box"].variant.design)
    v = KayakVessel(d)
    s0 = v.initial_state(datetime(2020, 5, 1), 37.0, -70.0)
    s0.damage["electronics_main"] = s0.damage["electronics_safe"] = True
    env = EnvState(wind_u=7.0, hs=1.0, tp=6.0, wave_dir=270.0, ghi=300.0)
    s1, _ = v.step(
        s0, Command(heading=90.0, thrust_fraction=0.25), env, timedelta(minutes=10),
        np.random.default_rng(0),
    )  # fmt: skip
    assert s1.drive_w == 0.0 and not s1.iridium_ok and s1.beacon_ok
    assert s1.speed_through_water < 0.06 * 7.0


def _rep(hours=50):
    h = [float(i) for i in range(hours)]
    rep = {"h": h, "start": "2020-05-01T12:00", "outcome": "timeout", "days": hours / 24}
    for col in ("lat", "lon", "heading", "stw", "soc", "wind_u", "wind_v", "hs", "tp"):
        rep[col] = [36.123456 + i for i in range(hours)]
    for col in ("wave_dir", "current_u", "current_v", "ghi", "iridium_ok", "beacon_ok"):
        rep[col] = [1] * hours
    rep["units"] = {"h": "hours"}
    rep["events"] = [
        {"h": 1.0, "kind": "message_received", "detail": "report at base"},
        {"h": 2.0, "kind": "capsize", "detail": "1 knockdown(s), Hs 3.1 m"},
        {"h": 3.0, "kind": "message_sent", "detail": ""},
    ]
    return rep


def test_thin_keeps_every_stride_and_the_last_row_and_the_notable_events():
    t = Y.thin(_rep(50), 6)
    assert t["h"] == [0.0, 6.0, 12.0, 18.0, 24.0, 30.0, 36.0, 42.0, 48.0, 49.0]
    assert len(t["lat"]) == len(t["h"]) and t["lat"][1] == round(36.123456 + 6, 3)
    assert "ghi" not in t and "current_u" not in t and "units" not in t
    assert [e["kind"] for e in t["events"]] == ["capsize"]
    assert t["stride_h"] == 6


def test_index_lists_every_build_with_its_odds_and_replays(tmp_path):
    rep = Y.thin(_rep(30))
    rep["build"] = "k-p10"
    Y.write_replays([rep], tmp_path)
    odds = {"k-p10": {"voyages": 10, "finished": 3, "odds": 0.3}}
    idx = Y.build_index(odds, tmp_path, {"commit": "abc"})
    json.dumps(idx)  # JSON-ready
    by_id = {b["id"]: b for b in idx["builds"]}
    assert len(by_id) == len(Y.BUILDS)
    b = by_id["k-p10"]
    assert b["odds"]["finished"] == 3
    assert b["replays"] == [
        {"file": "k-p10/2020-05-01.json", "start": "2020-05-01T12:00",
         "outcome": "timeout", "days": 1.25}
    ]  # fmt: skip
    assert (tmp_path / b["replays"][0]["file"]).exists()
    assert [x["id"] for x in idx["builds"] if x["current"]] == ["k-p25"]
    assert idx["schema"] == 2 and idx["defaults"]["cruise_w"] == 25
    assert "ghi" not in idx["units"] and idx["commit"] == "abc"


def test_the_cat_stays_over_guess_is_bracketed():
    from boatsim.sandbox import catalog

    cat = catalog.grid_id({"shape": "cat"})
    for q in Y.CAT_STAYS_OVER:
        b = Y.BUILDS[f"{cat}-over{round(q * 100)}"]
        d = patched_design(load_design(Y.KAYAK), b.variant.design)
        assert d.hazards["p_capsize_stays_over"] == q
        assert d.hull["beam_m"] == 1.6 and d.propulsion["rudder"] is False
        assert f"{cat}-over{round(q * 100)}" not in {catalog.grid_id(g) for g in catalog.GRID}
    ids = list(Y.BUILDS)
    assert ids.index(cat) < ids.index(f"{cat}-over20")  # the browser keeps the first tie


def test_a_partial_regrid_merges_into_the_grid_and_keeps_the_rest(tmp_path):
    grid, new = tmp_path / "grid", tmp_path / "new"
    for bid, days in (("k-p10", 30), ("k-p15", 40)):
        rep = Y.thin(_rep(days))
        rep["build"] = bid
        Y.write_replays([rep], grid)
    old = {"k-p10": {"finished": 3}, "k-p15": {"finished": 4}}
    meta = {"commit": "full", "odds_source": {"years": [2012, 2021]}}
    (grid / "index.json").write_text(json.dumps(Y.build_index(old, grid, meta)))
    rep = Y.thin(_rep(50))
    rep["build"] = "k-p10"
    Y.write_replays([rep], new)
    idx = Y.merge_into(grid, {"k-p10": {"finished": 9}}, new, {"commit": "part"})
    by_id = {b["id"]: b for b in idx["builds"]}
    assert len(by_id) == len(Y.BUILDS)
    assert by_id["k-p10"]["odds"] == {"finished": 9}  # redone
    assert by_id["k-p15"]["odds"] == {"finished": 4}  # kept
    assert [r["days"] for r in by_id["k-p10"]["replays"]] == [Y.thin(_rep(50))["days"]]
    assert len(by_id["k-p15"]["replays"]) == 1
    assert idx["commit"] == "full" and idx["odds_source"] == {"years": [2012, 2021]}
    assert idx["regrids"] == [{"builds": ["k-p10"], "commit": "part"}]
