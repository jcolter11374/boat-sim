"""How it ends (sandbox/endings.py): headline, the boat's own words, where, when."""

from datetime import datetime, timedelta

from boatsim.sandbox import catalog
from boatsim.sandbox.endings import ending, split_phase
from boatsim.types import Event, EventKind

T0 = datetime(2020, 5, 1, 12)


def test_joke_boat_words_and_phase():
    ev = [
        Event(T0 + timedelta(hours=6), EventKind.CAPSIZE, "1 knockdown(s), Hs 2.0 m"),
        Event(
            T0 + timedelta(hours=12),
            EventKind.LOST,
            "swamped: waves over a 0.3 m edge filled it [near land]",
        ),
    ]
    e = ending("lost", ev, T0, "open canoe, one paddler")
    assert e["headline"] == "Swamped"
    assert e["words"] == "swamped: waves over a 0.3 m edge filled it"
    assert e["where"] == "near the coast" and e["day"] == 0.5
    assert e["boat"] == "open canoe, one paddler"
    seam = "a seam let go (sun and salt); it's a flat pink sheet now [open ocean]"
    e = ending("lost", [Event(T0 + timedelta(days=31), EventKind.LOST, seam)], T0)
    assert e["headline"] == "Burst" and e["where"] == "out in the open ocean"


def test_outcomes_without_a_cause():
    assert ending("aground", [], T0)["headline"] == "Ran ashore"
    assert ending("at_sea", [], T0)["headline"] == "Still at sea"
    fin = [Event(T0 + timedelta(days=60), EventKind.ARRIVED)]
    e = ending("arrived", fin, T0)
    assert e["headline"] == "Finished" and e["day"] == 60
    assert split_phase("no tag") == ("no tag", None)


def test_stock_bases_sail_as_designed():
    for base, path in catalog.STOCK_BASES.items():
        assert catalog.grid_id({"base": base}) == base
        assert catalog.design_changes({"base": base}) == ()
        assert catalog.design_for({"base": base}).name
        assert catalog.nearest({"base": base}) == (base, False)
        assert path.endswith(f"{base}.yaml")
