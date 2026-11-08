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


def _summer_crossing(n_hours=1400, seed=1):
    """Synthetic sea for a ~58-day summer crossing: Hs a slow lognormal AR(1)
    around 1.8 m (typical North Atlantic summer), Tp from a mid-steepness sea,
    wind growing with Hs. Same recipe as the 400-voyage reality check in #52."""
    rng = np.random.default_rng(seed)
    x, hs = 0.0, []
    for _ in range(n_hours):
        x = 0.97 * x + math.sqrt(1 - 0.97**2) * rng.normal()
        hs.append(1.8 * math.exp(0.45 * x))
    hs = np.array(hs)
    return hs, np.maximum(4.0, 5.0 * np.sqrt(hs)), 3.0 + 3.5 * hs


def _pm_wind(hs):
    """Fully developed sea (Pierson-Moskowitz): Hs = 0.21 U^2 / g."""
    return math.sqrt(hs * 9.81 / 0.21)


def test_whitecap_coverage_matches_monahan():
    assert Z.whitecap_fraction(10.0) == pytest.approx(3.84e-6 * 10.0**3.41)
    assert Z.whitecap_fraction(0.0) == 0.0
    assert Z.whitecap_fraction(60.0) == 0.3  # capped


def test_knockdowns_are_rare_below_about_three_metres():
    """Maya's spec (#52): rare below ~2.5 m. Ravi's 2020 batch saw 34-352 per
    voyage, mostly in 1-1.5 m seas, from the old Banner-based model."""
    rate = Z.knockdown_rate_per_hour
    assert rate(P, 0.0, 0.0, 0.0) == 0.0
    for hs in (1.0, 1.5, 2.0, 2.5):
        for tp in (4.0, 6.0, 9.0):  # including steep short wind seas
            assert (
                rate(P, hs, tp, 2 * _pm_wind(hs)) * 24 * 60 < 0.05
            )  # < 1 per 20 two-month voyages
    gale = rate(P, 4.0, 9.0, _pm_wind(4.0)) * 24
    storm = rate(P, 6.0, 11.0, _pm_wind(6.0)) * 24
    assert 0.1 < gale < 3.0 and storm > gale  # per day


def test_summer_crossing_reproduces_design_doc_fmea():
    """Calibration check: knockdowns per voyage and the expected losses over a
    typical crossing land near the design doc's FMEA residuals (capsized-and-
    stuck 0.7 %, collision 1.0 %). Averaged over many synthetic crossings,
    because knockdowns come almost all from the odd gale."""
    counts, stuck = [], []
    for seed in range(100):
        hs, tp, wind = _summer_crossing(seed=seed)
        r = np.array([Z.knockdown_rate_per_hour(P, *x) for x in zip(hs, tp, wind, strict=True)])
        counts.append(r.sum())
        stuck.append(sum(r * P.p_inverted_stuck * np.array([Z.damage_scale(P, h) for h in hs])))
    assert 5 < np.median(counts) < 40  # median voyage: a handful to a few dozen
    assert np.mean(stuck) == pytest.approx(0.007, rel=0.3)
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
    env = EnvState(hs=6.0, tp=11.0, wind_u=17.0)  # storm
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


# --- Wear, water and people (sample_failures) ---------------------------------

OPEN_OCEAN = (40.0, -45.0)


def _draw(p, env, damage, hours, lat, lon, days=30.0, seed=0, steps=1):
    rng = np.random.default_rng(seed)
    outs = []
    for _ in range(steps):
        outs.append(Z.sample_failures(p, env, hours, damage, T0, lat, lon, days, rng))
    return outs


def test_coast_stub_knows_near_from_far():
    from boatsim.vessel.coast import distance_to_land_km

    assert distance_to_land_km(36.85, -75.7) < 50  # drop point, ~15 nm off Virginia
    assert distance_to_land_km(*OPEN_OCEAN) > 800
    assert distance_to_land_km(38.6, -28.6) < 50  # among the Azores


def test_failures_can_be_switched_off():
    off = replace(P, failures_enabled=False)
    (out,) = _draw(off, EnvState(hs=6.0), {}, 1000.0, 36.85, -75.7)
    assert out.events == [] and not out.lost


def test_capture_only_near_land():
    p = replace(P, capture_per_day=1000.0, unknown_p_by_60_days=0.0)
    (near,) = _draw(p, EnvState(), {}, 1.0, 36.85, -75.7)
    (far,) = _draw(p, EnvState(), {}, 1.0, *OPEN_OCEAN)
    assert near.lost and not far.lost


def test_water_in_a_tub_makes_its_electronics_box_fail_sooner():
    p = replace(P, leak_per_day=0.0, software_hang_per_day=0.0, unknown_p_by_60_days=0.0)
    hours = 24.0 * 30

    def failures(damage):
        n = 0
        for seed in range(400):
            (out,) = _draw(p, EnvState(), dict(damage), hours, *OPEN_OCEAN, seed=seed)
            n += "electronics_main" in out.failed_parts
        return n

    dry, wet = failures({}), failures({"leak_main_tub": True})
    assert wet > 3 * dry > 0


def test_both_electronics_boxes_dead_loses_the_boat():
    p = replace(P, unknown_p_by_60_days=0.0)
    (out,) = _draw(
        p, EnvState(), {"electronics_main": True, "electronics_safe": True}, 0.1, 40, -45
    )
    assert out.lost
    (ok,) = _draw(p, EnvState(), {"electronics_main": True}, 0.1, *OPEN_OCEAN)
    assert not ok.lost  # safe mode carries on alone


def test_steering_failure_jams_or_goes_limp():
    p = replace(P, steering_per_day=1e6, steering_jam_share=1.0, unknown_p_by_60_days=0.0)
    (out,) = _draw(p, EnvState(), {}, 1.0, *OPEN_OCEAN)
    assert "rudder" in out.failed_parts and "rudder_jammed" in out.failed_parts
    p = replace(p, steering_jam_share=0.0)
    (out,) = _draw(p, EnvState(), {}, 1.0, *OPEN_OCEAN)
    assert "rudder" in out.failed_parts and "rudder_jammed" not in out.failed_parts


def test_entanglement_hotspots_and_clearing():
    rate = Z.entangle_rate_per_day
    assert rate(P, *OPEN_OCEAN, 1000.0) == P.entangle_per_day
    assert rate(P, 37.0, -70.0, 1000.0) == pytest.approx(P.entangle_per_day * 2.0)  # Gulf Stream
    assert rate(P, 30.0, -60.0, 1000.0) == pytest.approx(P.entangle_per_day * 2.0)  # Sargasso
    assert rate(P, 36.85, -75.7, 20.0) > rate(P, *OPEN_OCEAN, 1000.0)  # near land
    p = replace(P, entangle_clear_per_day=1e6, unknown_p_by_60_days=0.0)
    (out,) = _draw(p, EnvState(), {"entangled": True}, 1.0, *OPEN_OCEAN)
    assert out.cleared_parts == ["entangled"]


def test_entanglement_slows_the_boat():
    v = KayakVessel(replace(DESIGN, hazards={"enabled": False}))
    st = v.initial_state(T0, *OPEN_OCEAN)
    env, dt, rng = EnvState(ghi=500.0), timedelta(minutes=10), np.random.default_rng(0)
    clean, _ = v.step(st, Command(90.0, 0.3), env, dt, rng)
    caught, _ = v.step(with_damage(st, "entangled"), Command(90.0, 0.3), env, dt, rng)
    # 4x the drag at the same power: speed falls to about 4^(-1/3) ~ 0.63 at best,
    # and a bit lower because a heavily loaded propeller is less efficient
    assert 0.45 < caught.speed_through_water / clean.speed_through_water < 0.63


def test_early_life_risk_is_front_loaded_and_sized_to_the_fmea():
    h = Z.unknown_hazard_per_day
    assert h(P, 1.0) > h(P, 10.0) > h(P, 50.0)
    # integrate the hazard to day 60: should give the configured 3 %
    days = np.linspace(1e-4, 60.0, 200_001)
    cum = np.trapezoid([h(P, d) for d in days[::100]], days[::100])
    assert 1.0 - math.exp(-cum) == pytest.approx(P.unknown_p_by_60_days, rel=0.05)
    assert h(replace(P, unknown_p_by_60_days=0.0), 5.0) == 0.0


def test_main_box_failure_switches_off_ais():
    # AIS always works -> never hit; no AIS -> always hit. Only the dead box differs.
    p = replace(
        P,
        knockdown_scale=0.0,
        p_avoid_with_ais=1.0,
        p_avoid_without_ais=0.0,
        p_lost_given_strike=1.0,
    )
    env = EnvState(ship_density=50.0)
    rng = np.random.default_rng(0)
    assert not Z.sample_hazards(p, env, 1.0, {}, T0, rng).lost
    assert Z.sample_hazards(p, env, 1.0, {"electronics_main": True}, T0, rng).lost
