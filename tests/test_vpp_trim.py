"""Hand trim (vpp.solve_trim / trim_table): the sails held at a sheet angle a
player chooses, for "Take the wheel" at the helm. The same force balance as
the polar, so a perfect trimmer sails the polar and nobody beats it."""

import json
import math
from pathlib import Path

import numpy as np
import pytest
import yaml

from boatsim.vessel import vpp as V
from boatsim.vessel.keelboat import KNOT

CFG = "configs/stock_cruiser31.yaml"
CASES = [(tws, twa) for tws in (6, 12, 20) for twa in (45, 60, 90, 120, 150, 180)]


@pytest.fixture(scope="module")
def p():
    return V.VPPParams.from_config(yaml.safe_load(Path(CFG).read_text())["vpp"])


def _sheets(p, n=40):
    return np.linspace(p.sheet_min_deg, 90.0, n)


@pytest.mark.parametrize("tws,twa", CASES)
def test_the_best_sheet_sails_the_polar_and_never_beats_it(p, tws, twa):
    plan = p.plans[0]
    best = V.solve(p, tws * KNOT, twa, plan, 0.0).speed
    held = [V.solve_trim(p, tws * KNOT, twa, plan, s, 0.0) for s in _sheets(p)]
    top = max(x.speed for x in held if not x.overpowered)
    # solve() tries 16 trims, a held sheet can land between them: grid resolution only.
    assert top <= best * 1.01 + 1e-9
    assert top >= best * 0.98


def test_the_optimisers_own_trim_gives_its_speed(p):
    """Hold the sheet where solve() trimmed it and you get solve()'s speed."""
    plan = p.plans[0]
    for tws, twa in [(8, 52), (12, 90), (16, 75), (20, 135)]:
        best = V.solve(p, tws * KNOT, twa, plan, 0.0)
        net, _, _, alpha, _ = V._balance(p, plan, tws * KNOT, math.radians(twa), best.speed, 0.0)
        a = float(alpha[0, np.unravel_index(int(np.argmax(net)), net.shape)[1]])
        awa = math.atan2(
            tws * KNOT * math.sin(math.radians(twa)),
            tws * KNOT * math.cos(math.radians(twa)) + best.speed,
        )
        held = V.solve_trim(p, tws * KNOT, twa, plan, math.degrees(awa - a), 0.0)
        assert held.speed == pytest.approx(best.speed, rel=0.01)


def test_eased_too_far_upwind_the_sails_flap_and_the_boat_stops(p):
    x = V.solve_trim(p, 12 * KNOT, 45, p.plans[0], 90.0, 0.0)
    assert x.speed == 0.0
    assert x.alpha_deg == 0.0


def test_sheeted_hard_on_a_run_stalls_and_costs_speed(p):
    tight = V.solve_trim(p, 12 * KNOT, 150, p.plans[0], p.sheet_min_deg, 0.0)
    eased = V.solve_trim(p, 12 * KNOT, 150, p.plans[0], 85.0, 0.0)
    assert tight.alpha_deg > p.alpha_stall_deg
    assert tight.speed < eased.speed * 0.95


def test_full_sail_in_a_gale_is_overpowered_and_a_reef_is_not(p):
    full = V.solve_trim(p, 25 * KNOT, 50, p.plans[0], p.sheet_min_deg, 0.0)
    reef = V.solve_trim(p, 25 * KNOT, 50, p.plans[2], p.sheet_min_deg, 0.0)
    assert full.overpowered and full.heel_deg > p.heel_max_deg
    assert not reef.overpowered


def test_trim_mode_leaves_the_polar_alone(p):
    """The optimiser's path through _balance is untouched (sheet=None)."""
    t = json.loads(Path("configs/polars/cruiser31.json").read_text())
    i, j = t["tws_kn"].index(16), t["twa_deg"].index(60)
    pt = V.solve(p, 16 * KNOT, 60, p.plans[0], 0.0)
    assert t["plans"]["full"]["speed_kn"][i][j] == pytest.approx(
        pt.speed * p.autopilot_factor / KNOT, abs=0.002
    )


def test_committed_trim_table_is_the_vpp_output(p):
    t = json.loads(Path("configs/polars/cruiser31_trim.json").read_text())
    assert set(t["plans"]) == {"full", "reef1", "reef2", "storm"}
    assert t["autopilot_factor"] == p.autopilot_factor
    shape = (len(t["tws_kn"]), len(t["twa_deg"]), len(t["sheet_deg"]))
    assert np.asarray(t["plans"]["reef1"]["speed_kn"]).shape == shape
    i, j, k = t["tws_kn"].index(12), t["twa_deg"].index(90), 4
    x = V.solve_trim(V.hand_sailed(p), 12 * KNOT, 90, p.plans[0], t["sheet_deg"][k], 0.0)
    assert t["plans"]["full"]["speed_kn"][i][j][k] == pytest.approx(x.speed / KNOT, abs=0.002)


def test_sheeted_in_on_a_dead_run_is_much_slower(p):
    """Theo's review: past 90 deg the sail curve is mirrored, so a sail pulled in
    tight with the wind dead astern is edge-on to it, not square to it."""
    tight = V.solve_trim(p, 12 * KNOT, 180, p.plans[0], p.sheet_min_deg, 0.0)
    eased = V.solve_trim(p, 12 * KNOT, 180, p.plans[0], 85.0, 0.0)
    assert tight.speed < eased.speed * 0.7, (tight.speed, eased.speed)


def test_overpowered_points_are_capped_at_the_polar(p):
    t = json.loads(Path("configs/polars/cruiser31_trim.json").read_text())
    i, j = t["tws_kn"].index(25), t["twa_deg"].index(50)
    full = t["plans"]["full"]
    best = V.solve(V.hand_sailed(p), 25 * KNOT, 50, p.plans[0], 0.0).speed / KNOT
    over = [k for k, o in enumerate(full["overpowered"][i][j]) if o]
    assert over, "full sail at 25 kn, 50 deg is overpowered when sheeted hard"
    for k in over:
        assert full["speed_kn"][i][j][k] <= best + 0.002
        assert full["heel_deg"][i][j][k] > t["heel_max_deg"]
