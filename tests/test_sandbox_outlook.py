"""A "Your call" card's stake against the ghost comes from the forecast, never the true future."""

import pytest
from test_sandbox_helm import MAY1, env  # noqa: F401 - the shared bundle fixture

from boatsim.sandbox.helm import Game


def test_outlook_on_auto_matches_the_ghost_and_leaves_the_game_alone(env):  # noqa: F811
    g = Game(env, launch_index=MAY1, max_days=0.9)
    g.run(hours=3, ghost_passes=False, land_within_km=None, breakdown=False)
    before = (g.mine.state.t, g.mine.state.lat, g.ghost.state.lat, len(g.orders))
    o = g.outlook([{"heading": "auto"}, {"heading": 270, "power": 0.0}], hours=6)
    auto, drift = o["orders"]
    # On auto the boat is the ghost: the same forecast, the same steering, level.
    assert auto["lead_km"] == pytest.approx(o["lead_now_km"], abs=0.05)
    assert drift["lead_km"] < auto["lead_km"]  # drifting west, motors off, loses ground
    # Each line starts at the boat and has a point every 3 h, for the call's map.
    for t in (auto["track"], drift["track"], o["ghost"]["track"]):
        assert t[0] == [round(g.mine.state.lat, 3), round(g.mine.state.lon, 3)] and len(t) == 3
    assert (g.mine.state.t, g.mine.state.lat, g.ghost.state.lat, len(g.orders)) == before


def test_best_heading_comes_from_a_fan_around_the_heading_now(env):  # noqa: F811
    g = Game(env, launch_index=MAY1, max_days=0.9)
    g.run(hours=3, ghost_passes=False, land_within_km=None, breakdown=False)
    b = g.best_heading(hours=6)
    assert b["best"] in b["km"] and len(b["km"]) == 7
    assert b["gain_km"] >= 0
