"""A stock boat with a part changed is still sailed as that boat in the odds grid.

Before 14 Nov the grid sailed every changed keelboat build with the kayak model and
a motor autopilot (mc/sensitivity.py), so any keelboat option, even switching the
tactician off, read about a quarter where the boat as built read 84 % (Nina).
"""

import pytest

from boatsim.autonomy.sailing import SailingAutopilot
from boatsim.mc.boatyard import BUILDS, job_for
from boatsim.vessel import KayakVessel
from boatsim.vessel.keelboat import KeelboatVessel

KEEL_BUILDS = sorted(b for b in BUILDS if b.startswith(("stock_pearson31_2", "stock_cruiser31")))


def test_every_keelboat_build_is_listed():
    assert len(KEEL_BUILDS) == 32


@pytest.mark.parametrize("bid", KEEL_BUILDS)
def test_each_keelboat_build_sails_as_a_keelboat(bid):
    c = job_for(bid, unknown_p_by_60_days=0.0).components(0)
    boat = c.vessel.inner
    assert type(boat) is KeelboatVessel
    assert boat.hazards.unknown_p_by_60_days == 0.0
    # base plans from this build's own polar (laminate, cutter, keels... change it)
    assert c.base.polar is boat.polar
    if BUILDS[bid].options.get("tactician", "on") == "on":
        assert isinstance(c.autopilot, SailingAutopilot)
    else:
        assert not isinstance(c.autopilot, SailingAutopilot)


def test_a_part_reaches_the_boat():
    lam = job_for("stock_pearson31_2-cloth.laminate").components(0).vessel.inner
    plain = job_for("stock_pearson31_2").components(0).vessel.inner
    assert lam.polar.speed_ms(7.0, 90.0) > plain.polar.speed_ms(7.0, 90.0)  # laminate holds shape
    assert lam.hazards.p_part["sail"] == pytest.approx(1.5 * plain.hazards.p_part["sail"])


def test_kayak_builds_are_unchanged():
    c = job_for("k-p25-thr.two-t500").components(0)
    assert type(c.vessel.inner) is KayakVessel


def test_a_keelboat_with_the_tactician_off_can_be_sailed():
    # standard_components used to read the tactician's angle limits for base and
    # crash when the part switched it off (the game and the grid alike).
    from boatsim.runner.simulate import standard_components
    from boatsim.sandbox import catalog as C

    d = C.design_for({"base": "stock_pearson31_2", "tactician": "off"})
    c = standard_components(d, None, None)
    assert (c.base.min_twa_deg, c.base.max_twa_deg) == (0.0, 180.0)
