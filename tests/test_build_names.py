"""Build names a player reads (Leo, quality audit item 9): plain words from one
map (catalog.CHANGE_NAMES), never a slot name or an option id."""

import json
import re
from pathlib import Path

from boatsim.mc.boatyard import BUILDS, relabel
from boatsim.sandbox import catalog

INDEX = Path(__file__).resolve().parents[1] / "sea3d" / "public" / "boatyard" / "index.json"
JARGON = re.compile(
    r"GUESS|ROUGH|OUR PICK|\(our model\)|as modell?ed|as published|W cruise|\w: [a-z0-9]+-"
)


def option_ids() -> set[str]:
    ids = {o for opts in catalog.SLOTS.values() for o in opts}
    ids |= {o for b in catalog.RSLOTS.values() for opts in b.values() for o in opts}
    return {i for i in ids if re.search(r"[-\d]", i)}


def leaks(text: str) -> list[str]:
    out = [i for i in option_ids() if re.search(rf"(^|[^\w-]){re.escape(i)}($|[^\w-])", text)]
    return out + JARGON.findall(text)


def test_no_build_name_shows_an_internal_word():
    for b in BUILDS.values():
        assert not leaks(b.label), (b.id, b.label, leaks(b.label))
        assert len(b.label) <= 60, (b.id, b.label)


def test_every_non_default_option_has_a_name():
    for slot, opts in catalog.SLOTS.items():
        for o in opts:
            if o != catalog.DEFAULTS[slot] and catalog.matters(slot, o):
                assert (slot, o) in catalog.CHANGE_NAMES or slot == "shape", (slot, o)
    for base, slots in catalog.RSLOTS.items():
        for slot, opts in slots.items():
            for o in opts:
                if catalog.matters(slot, o, base):
                    assert (slot, o) in catalog.CHANGE_NAMES, (base, slot, o)


def test_leos_names():
    want = {
        "k-p25": "Our kayak",
        "k-p20": "Our kayak, motors turned down (20 W)",
        "k-p25-drive.hybrid": "Our kayak + wing sail and motors",
        "k-p0-drive.wing-sail": "Our kayak, wing sail only (no motors)",
        "k-p25-sol.solar-300-bat.two-100ah": "Our kayak, bigger panels and batteries",
        "k-p30-sol.solar-300-bat.two-100ah": "Our kayak, bigger panels and batteries, motors turned up",
        "k-p25-brain.one-box-beacon.none": "Our kayak, no backup autopilot or beacon",
        "k-p25-shape.cat": "Catamaran version",
        "k-p25-shape.cat-over20": "Catamaran version, best case",
        "revc": "Randolph Rev C5, as built",
        "revc-drive.wing-thruster": "Randolph Rev C5 + small motor",
        "revb-rsol.deck-60w-rbat.lfp-384wh": "Randolph Rev B, bigger panels and battery",
        "revb-spar": "Randolph Rev B, stronger wing spar",
    }
    for bid, name in want.items():
        assert BUILDS[bid].label == name, bid
    assert BUILDS["revc"].note.startswith("Our model of")
    assert "Every cheaper part" in next(b for b in BUILDS.values() if "bare-bones" in b.label).note


def test_the_page_grid_carries_todays_names(tmp_path):
    # The committed index.json is relabelled (python -m boatsim.mc.boatyard relabel).
    p = tmp_path / "index.json"
    p.write_text(INDEX.read_text())
    assert relabel(p) == 0, "index.json labels are stale: run python -m boatsim.mc.boatyard relabel"
    for b in json.loads(INDEX.read_text())["builds"]:
        assert not leaks(b["label"]), b["label"]
