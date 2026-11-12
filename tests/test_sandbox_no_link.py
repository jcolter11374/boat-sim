"""Once the main box (and the Iridium modem in it) has died, orders can't reach the
boat, in any mode: "hands on" is a perfect link, not a person aboard (Maya, 12 Nov)."""

import pytest
from test_sandbox_helm import MAY1, env  # noqa: F401 - the shared bundle fixture

from boatsim.sandbox.helm import Game


@pytest.mark.parametrize("mode", ["hands_on", "base"])
def test_orders_work_until_the_main_box_dies_then_are_refused(env, mode):  # noqa: F811
    g = Game(env, launch_index=MAY1, max_days=0.9, mode=mode)
    g.run(hours=3, ghost_passes=False, land_within_km=None, breakdown=False)
    assert g.status()["no_link"] is None
    if mode == "hands_on":
        assert g.order(120, 0.3)["accepted"] is True
    else:
        assert "no_link" not in g.order(120, 0.3)
    n = len(g.orders)
    g.mine.state.damage["electronics_main"] = True  # the main box dies
    r = g.order(200, 0.5)
    assert r["accepted"] is False and r["no_link"] == "main_box"
    assert g.order("auto", 0.5)["no_link"] == "main_box"
    assert len(g.orders) == n  # nothing was sent
    assert g.status()["no_link"] == "main_box"
    if mode == "hands_on":
        assert g.helm.heading == 120  # the boat keeps what it last heard


def test_iridium_gone_silent_also_cuts_the_link(env):  # noqa: F811
    g = Game(env, launch_index=MAY1, max_days=0.9)
    g.mine.state.damage["comms_silent"] = True
    assert g.order(90, 0.3)["no_link"] == "comms_silent"
