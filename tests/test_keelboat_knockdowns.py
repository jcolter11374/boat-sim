"""The keelboats' knockdown model (vessel/hazards.py), fitted to the 1979 Fastnet.

Tank tests (Wolfson Unit; SNAME): a beam-on breaker about 30 % of a yacht's length is
dangerous, 60 % rolls her almost surely. The Fastnet inquiry: about a third of the fleet
rolled beyond horizontal in one night of Force 10-11, and five of those boats sank.
"""

import math

import pytest

from boatsim.config import load_design
from boatsim.sandbox import catalog as C
from boatsim.vessel.hazards import HazardParams, knockdown_rate_per_hour

STORM = {"hs": 8.0, "tp": 11.0, "wind": 25.0, "hours": 12.0}  # GUESS: the Fastnet night


def hazards(boat: str, **picks) -> HazardParams:
    return HazardParams.from_config(C.design_for({"base": boat, **picks}).hazards)


@pytest.mark.parametrize("boat", C.KEELBOATS)
def test_a_fastnet_night_rolls_about_a_third_of_ten_metre_yachts(boat):
    from dataclasses import replace

    p = replace(hazards(boat), hull_length_m=10.0)  # the Fastnet fleet's typical size
    lam = knockdown_rate_per_hour(p, STORM["hs"], STORM["tp"], STORM["wind"]) * STORM["hours"]
    assert 1 - math.exp(-lam) == pytest.approx(0.33, abs=0.04)


@pytest.mark.parametrize("boat", C.KEELBOATS)
def test_the_critical_breaker_is_within_the_tank_tests_range(boat):
    p = hazards(boat)
    assert 0.30 <= p.critical_wave_frac_of_length <= 0.60
    assert p.critical_wave_frac_of_beam == 0.0  # the beam floor is for short hulls


@pytest.mark.parametrize("boat", C.KEELBOATS)
def test_ordinary_weather_rolls_nobody_and_a_roll_at_hs_8_sinks_one_in_twenty(boat):
    p = hazards(boat)
    assert knockdown_rate_per_hour(p, 4.0, 9.0, 15.0) * 24 < 1e-6  # a Force 6-7 day
    assert min(
        p.p_inverted_stuck * (8.0 / p.damage_ref_hs_m) ** 2, p.max_damage_p
    ) == pytest.approx(0.05, rel=0.01)
    assert "rolled" in p.lost_why


def test_now_a_drogue_saves_her_from_rolls():
    bare = hazards("stock_pearson31_2")
    for kind in ("jordan", "para"):
        p = hazards("stock_pearson31_2", drogue=kind)
        a = knockdown_rate_per_hour(bare, 8.0, 11.0, 25.0)
        b = knockdown_rate_per_hour(p, 8.0, 11.0, 25.0)
        assert a > 0.01 and b < 0.25 * a


def test_the_kayak_and_randolph_boats_keep_their_model():
    for path in ("configs/v4_kayak.yaml", C.REV_C):
        p = HazardParams.from_config(load_design(path).hazards)
        assert p.critical_wave_frac_of_length == 0.55 and p.lost_why == ""
