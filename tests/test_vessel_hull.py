import math

import pytest

from boatsim.geo import KNOT
from boatsim.vessel import hull as H

P = H.HullParams()


def test_ittc57_matches_hand_value():
    # Re = 1e7 -> log10 Re - 2 = 5 -> Cf = 0.075 / 25
    speed = 1e7 * H.NU_WATER / P.waterline_length_m
    assert H.ittc57_cf(speed, P.waterline_length_m) == pytest.approx(0.003)


def test_calm_drag_at_cruise_is_a_few_newtons_and_opposes_motion():
    r = H.calm_drag(P, 1.7 * KNOT)
    # Hand check: 0.5 x 1025 x 1.9 x 0.875^2 x Cf(2.1e6 -> 0.0040) x 1.3 x 1.15 ~ 4.5 N
    assert 4.0 < r < 5.0
    assert H.calm_drag(P, -1.7 * KNOT) == pytest.approx(-r)
    assert H.calm_drag(P, 0.0) == 0.0


def test_fouling_grows_linearly_then_caps():
    assert H.fouling_frac(P, 0.0) == 0.0
    assert H.fouling_frac(P, 50.0) == pytest.approx(0.30)
    assert H.fouling_frac(P, 1000.0) == P.fouling_max_frac


def test_wave_drag_worst_head_on_and_grows_with_height():
    head = H.wave_drag_frac(P, 2.5, 0.0)
    beam = H.wave_drag_frac(P, 2.5, 90.0)
    foll = H.wave_drag_frac(P, 2.5, 180.0)
    assert head > beam > foll > 0
    assert beam == pytest.approx(0.65, abs=0.01)  # design doc "+60 % in rough water"
    assert H.wave_drag_frac(P, 1.0, 0.0) < head
    assert H.wave_drag_frac(P, 0.0, 0.0) == 0.0
    assert H.wave_drag_frac(P, 20.0, 0.0) == P.wave_drag_max_frac


def test_air_force_signs():
    fx, fy = H.air_force(P, 10.0, -10.0)
    assert fx > 0 and fy < 0
    assert abs(fy) > abs(fx)  # more area side-on


def test_lateral_speed_balances_forces_and_is_bounded():
    w = 10.0
    v = H.lateral_speed(P, w, 0.0)
    assert 0 < v < w
    ka = 0.5 * H.RHO_AIR * P.air_cd_side * P.air_side_area_m2
    kw = 0.5 * H.RHO_WATER * P.lateral_cd_area_m2
    assert ka * (w - v) ** 2 == pytest.approx(kw * v * v, rel=1e-9)
    assert H.lateral_speed(P, -w, 0.0) == pytest.approx(-v)
    assert H.lateral_speed(P, 0.0, 1.0) == 0.0
    # Forward speed lets the keel lift, cutting the slip
    assert H.lateral_speed(P, w, 1.0) < v


def test_unpowered_drift_is_a_few_percent_of_wind():
    # Search-and-rescue leeway tables put small craft at ~1-5 % of wind speed.
    v = H.lateral_speed(P, 10.0, 0.0)
    assert 0.02 < v / 10.0 < 0.06


def test_stokes_drift_size_and_direction():
    e, n = H.stokes_drift(2.0, 8.0, 270.0)  # waves from the west
    assert e > 0 and abs(n) < 1e-9
    assert 0.02 < math.hypot(e, n) < 0.08
    assert H.stokes_drift(0.0, 8.0, 0.0) == (0.0, 0.0)


def test_from_config_ignores_non_physics_keys():
    p = H.HullParams.from_config({"model": "kayak", "wetted_area_m2": 2.0})
    assert p.wetted_area_m2 == 2.0


def test_mass_link_leaves_the_reference_weight_alone_and_drags_more_when_heavier():
    from boatsim.config import load_design

    for path in ("configs/v4_kayak.yaml", "configs/randolph_rev_b.yaml"):
        hull = load_design(path).hull
        assert hull["mass_kg"] == hull["displacement_ref_kg"]
        at_ref = H.HullParams.from_config(hull)
        off = H.HullParams.from_config(
            {k: v for k, v in hull.items() if k != "displacement_ref_kg"}
        )
        assert at_ref == off  # baselines don't move
        heavy = H.HullParams.from_config({**hull, "mass_kg": hull["mass_kg"] * 1.1})
        light = H.HullParams.from_config({**hull, "mass_kg": hull["mass_kg"] * 0.9})
        assert light.wetted_area_m2 < at_ref.wetted_area_m2 < heavy.wetted_area_m2
        assert H.calm_drag(light, 0.8) < H.calm_drag(at_ref, 0.8) < H.calm_drag(heavy, 0.8)
    # Kayak +10 kg (big batteries): ~6.5 mm deeper, ~+2 % wetted area, ~+3 % drag.
    k = load_design("configs/v4_kayak.yaml").hull
    p0, p1 = H.HullParams.from_config(k), H.HullParams.from_config({**k, "mass_kg": 133})
    assert p1.wetted_area_m2 == pytest.approx(1.9 + 2.1 * 2.9 * 10 / (1025 * 1.5))
    assert H.calm_drag(p1, 0.85) / H.calm_drag(p0, 0.85) == pytest.approx(1.028, abs=0.004)
