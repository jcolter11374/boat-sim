import math
from dataclasses import replace
from datetime import datetime, timedelta

import numpy as np
import pytest

from boatsim.config import load_design
from boatsim.types import Command, EnvState, EventKind
from boatsim.vessel import KayakVessel
from boatsim.vessel import hazards as Z
from boatsim.vessel.kayak import with_damage

P = Z.HazardParams()
T0 = datetime(2021, 5, 1)
DESIGN = load_design("configs/v4_kayak.yaml")


def _summer_crossing(n_hours=1200, seed=1):
    """Synthetic sea states for a 50-day summer crossing: Hs lognormal around
    1.8 m (typical North Atlantic summer), Tp from a mid-steepness wind sea."""
    rng = np.random.default_rng(seed)
    hs = rng.lognormal(math.log(1.8), 0.45, n_hours)
    tp = np.maximum(4.0, 5.0 * np.sqrt(hs))
    return hs, tp


def test_breaking_probability_matches_banner_threshold():
    # eps = Hs kp / 2 below 0.055 -> no breaking
    assert Z.breaking_probability(0.5, 8.0) == 0.0
    # steep sea: Hs 3 m, Tp 6 s -> eps ~ 0.17 -> ~26 % of dominant waves break
    assert 0.2 < Z.breaking_probability(3.0, 6.0) < 0.35


def test_knockdowns_need_big_steep_waves():
    assert Z.knockdown_rate_per_hour(P, 0.0, 0.0) == 0.0
    assert Z.knockdown_rate_per_hour(P, 0.5, 4.0) < 1e-3
    calm, normal, gale = (Z.knockdown_rate_per_hour(P, h, 5 * math.sqrt(h)) for h in (1, 2, 4))
    assert calm < normal <= gale
    # Steeper sea of the same height is worse
    assert Z.knockdown_rate_per_hour(P, 3.0, 6.0) > Z.knockdown_rate_per_hour(P, 3.0, 10.0)


def test_summer_crossing_reproduces_design_doc_fmea():
    """Calibration check: expected losses over a typical crossing land near the
    design doc's FMEA residuals (capsized-and-stuck 0.7 %, collision 1.0 %)."""
    hs, tp = _summer_crossing()
    rates = np.array([Z.knockdown_rate_per_hour(P, h, t) for h, t in zip(hs, tp, strict=True)])
    knockdowns = rates.sum()
    assert 30 < knockdowns < 200  # a few a day on average
    p_stuck = sum(r * P.p_inverted_stuck * Z.damage_scale(P, h) for r, h in zip(rates, hs))
    assert p_stuck == pytest.approx(0.007, rel=0.5)
    # Ships: ~100 h near the coasts at 3e-3 ships/km^2, the rest open ocean at 2e-4
    hits = 100 * Z.ship_strike_rate_per_hour(P, 3e-3, True) + 1100 * Z.ship_strike_rate_per_hour(
        P, 2e-4, True
    )
    assert hits == pytest.approx(0.010, rel=0.3)


def test_losing_ais_doubles_ship_strike_odds():
    with_ais = Z.ship_strike_rate_per_hour(P, 1e-3, True)
    without = Z.ship_strike_rate_per_hour(P, 1e-3, False)
    assert without == pytest.approx(2.0 * with_ais)
    assert Z.ship_strike_rate_per_hour(P, 0.0, True) == 0.0


def test_disabled_hazards_do_nothing():
    off = Z.HazardParams(enabled=False)
    env = EnvState(hs=8.0, tp=9.0, ship_density=1.0)
    out = Z.sample_hazards(off, env, 1.0, {}, T0, np.random.default_rng(0))
    assert out.events == [] and not out.lost


def test_storm_sampling_knocks_down_and_breaks_things():
    # Exaggerate damage odds so the test sees every branch quickly.
    p = replace(P, p_part={k: 0.05 for k in P.p_part}, p_inverted_stuck=0.0)
    env = EnvState(hs=5.0, tp=8.0)
    rng = np.random.default_rng(3)
    damage: dict[str, bool] = {}
    total = 0
    for _ in range(200):
        out = Z.sample_hazards(p, env, 1.0, damage, T0, rng)
        total += out.knockdowns
        for part in out.failed_parts:
            assert not damage.get(part)  # a part only breaks once
            damage[part] = True
    assert total > 50
    assert damage.get("ais_whip") and damage.get("panel_50w")


def test_kayak_feels_its_damage():
    v = KayakVessel(replace(DESIGN, hazards={"enabled": False}))
    st = v.initial_state(T0, 37.0, -60.0)
    sun = EnvState(ghi=800.0)
    dt = timedelta(minutes=10)
    rng = np.random.default_rng(0)
    full, _ = v.step(st, Command(90.0, 0.3), sun, dt, rng)
    hurt = with_damage(with_damage(st, "panel_100w_a"), "panel_50w")
    less, _ = v.step(hurt, Command(90.0, 0.3), sun, dt, rng)
    assert less.solar_w == pytest.approx(full.solar_w * 100.0 / 250.0)
    # Rudder gone: still steers on two thrusters, drifts on one
    no_rudder = with_damage(st, "rudder")
    s2, _ = v.step(no_rudder, Command(90.0, 0.3), sun, dt, rng)
    assert s2.heading == 90.0
    s1, _ = v.step(with_damage(no_rudder, "thruster_port"), Command(90.0, 0.3), sun, dt, rng)
    assert s1.speed_through_water < 0.05


def test_ship_strike_can_end_the_voyage():
    p = replace(P, p_avoid_with_ais=0.0, p_lost_given_strike=1.0)
    v = KayakVessel(replace(DESIGN, hazards={"p_avoid_with_ais": 0.0, "p_lost_given_strike": 1.0}))
    assert v.hazards == p
    st = v.initial_state(T0, 37.0, -60.0)
    env = EnvState(ship_density=50.0)  # absurd traffic so it happens in one step
    st, events = v.step(
        st, Command(90.0, 0.3), env, timedelta(minutes=10), np.random.default_rng(0)
    )
    assert not st.alive
    assert any(e.kind == EventKind.SHIP_STRIKE for e in events)
