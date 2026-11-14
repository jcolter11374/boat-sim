"""The numbered autopilot policies (M5 piece G2): policy 1 is the autopilot behind the odds,
untouched; policy 2 is the game's; a game and an odds run can be put on the same one."""

import base64
import io
import json
import zlib

import pytest
from test_sandbox import _fake_sources
from test_sandbox_helm import MAY1

from boatsim.autonomy.guidance import WaypointAutopilot
from boatsim.autonomy.policy import GAME_POLICY, ODDS_POLICY, POLICIES, policy
from boatsim.autonomy.safemode import DEFAULT_THROTTLE_STEPS, SafeModeAutopilot
from boatsim.basestation import ForecastReplanPolicy
from boatsim.runner.simulate import default_mission, standard_components
from boatsim.sandbox import catalog
from boatsim.sandbox import forcing as F
from boatsim.sandbox import run as R
from boatsim.sandbox.helm import Game

QUIET = {"ghost_passes": False, "land_within_km": None, "breakdown": False}


@pytest.fixture(scope="module")
def env():
    era5, glorys, ships = _fake_sources()
    buf = io.BytesIO()
    F.cut(2020, buf, era5, glorys, ships, log=lambda *_: None, first=(5, 1), last=(5, 4))
    return R.open_bundle(buf.getvalue())


def _parts(c):
    """The safe-mode autopilot (inside any sailing wrapper), its steering, and base."""
    ap = c.autopilot
    while not isinstance(ap, SafeModeAutopilot):
        ap = ap.inner
    return ap, ap.guidance, c.base


def test_policy_1_is_every_parts_own_default():
    p = policy(1)
    g = WaypointAutopilot()
    assert (p.pursuit_crab_deg, p.track_near_land_km) == (g.pursuit_crab_deg, g.track_near_land_km)
    assert p.throttle_steps == DEFAULT_THROTTLE_STEPS == SafeModeAutopilot().throttle_steps
    assert p.replan_min_gain_h is None  # each planner keeps its own number
    assert ODDS_POLICY == 1 and GAME_POLICY == 2
    assert all(POLICIES[v].version == v for v in POLICIES)
    with pytest.raises(ValueError, match="no autopilot policy 7"):
        policy(7)


def test_policy_2_only_adds_power_above_policy_1s_steps():
    steps = policy(2).throttle_steps
    assert (
        steps[-len(DEFAULT_THROTTLE_STEPS) :] == DEFAULT_THROTTLE_STEPS
    )  # the easing is unchanged
    floors = [f for f, _ in steps]
    assert floors == sorted(floors, reverse=True)  # checked top to bottom
    assert all(scale > 1.0 for floor, scale in steps if floor > DEFAULT_THROTTLE_STEPS[0][0])
    # Cruise power times the top step never asks for more than the motors have (the kayak: 25 of 100 W).
    prop = catalog.design_for(None).propulsion
    assert prop["cruise_drive_w"] / prop["max_drive_w"] * max(s for _, s in steps) <= 1.0


def test_components_take_the_policy_asked_for(env):
    design = catalog.design_for(None)
    for version in (None, 1):
        ap, guidance, base = _parts(standard_components(design, env, env, seed=1, policy=version))
        assert ap.throttle_steps == DEFAULT_THROTTLE_STEPS
        assert (guidance.pursuit_crab_deg, guidance.track_near_land_km) == (20.0, 150.0)
        assert base.min_gain_h == ForecastReplanPolicy(route=default_mission().waypoints).min_gain_h
    ap, guidance, base = _parts(standard_components(design, env, env, seed=1, policy=2))
    assert ap.throttle_steps == policy(2).throttle_steps
    assert (guidance.pursuit_crab_deg, guidance.track_near_land_km) == (0.0, 50.0)
    assert base.min_gain_h == float(
        "inf"
    )  # no detours for speed; a leg that hits land is still replaced


def test_the_game_sails_both_boats_on_the_games_policy(env):
    g = Game(env, launch_index=MAY1, max_days=1.0)
    assert g.policy == GAME_POLICY
    ap, guidance, base = _parts(g.ghost.c)
    assert ap.throttle_steps == policy(GAME_POLICY).throttle_steps
    assert guidance.pursuit_crab_deg == 0.0 and base.min_gain_h == float("inf")
    assert g.result()["autopilot_policy"] == GAME_POLICY


def test_hands_off_is_still_a_dead_heat(env):
    """G3: "let the autopilot sail" is the ghost's own autopilot, whatever the policy, so a game
    with no orders sails the ghost's voyage row for row (#327)."""
    for version in (GAME_POLICY, ODDS_POLICY):
        g = Game(env, launch_index=MAY1, max_days=2.0, policy=version)
        while not g.run(hours=24, **QUIET)["status"]["over"]:
            pass
        mine = [(r["t"], r["lat"], r["lon"], r["soc"]) for r in g.mine.log.rows]
        ghost = [(r["t"], r["lat"], r["lon"], r["soc"]) for r in g.ghost.log.rows]
        assert mine == ghost and len(mine) > 10
        assert g.status()["lead_km"] == 0.0
    # And taking her back after an order of your own puts her on the same autopilot again.
    g = Game(env, launch_index=MAY1, max_days=1.0)
    g.order("finish", 0.5)
    g.run(hours=3, **QUIET)
    g.order("auto", 0.0)
    assert g.on_auto
    ap, _, base = _parts(g.mine.c)
    assert ap.throttle_steps == policy(GAME_POLICY).throttle_steps and base.min_gain_h == float(
        "inf"
    )


def test_a_boat_with_a_sail_stays_on_the_odds_policy(env):
    """Policy 2 was tuned on the kayak alone: the wing-sail boats and the yachts keep policy 1's
    steering, power steps and weather routing, and the game says which policy is in force."""
    for base in ("revc", "stock_cruiser31"):
        design = catalog.design_for({"base": base})
        asked = standard_components(design, env, env, seed=1, policy=2)
        odds = standard_components(design, env, env, seed=1)
        assert asked.policy == odds.policy == ODDS_POLICY
        for a, b in zip(_parts(asked), _parts(odds), strict=True):
            for k in ("throttle_steps", "pursuit_crab_deg", "track_near_land_km", "min_gain_h"):
                assert getattr(a, k, None) == getattr(b, k, None), (base, k)
    assert standard_components(catalog.design_for(None), env, env, seed=1, policy=2).policy == 2
    with pytest.raises(ValueError, match="no autopilot policy 9"):
        standard_components(catalog.design_for({"base": "revc"}), env, env, seed=1, policy=9)
    g = Game(env, choices={"base": "revc"}, launch_index=MAY1, max_days=0.5)
    assert g.policy == ODDS_POLICY and g.result()["autopilot_policy"] == ODDS_POLICY
    assert "ap" not in _payload(g.save())


def test_the_two_policies_sail_different_voyages(env):
    def ghost_end(version):
        g = Game(env, launch_index=MAY1, max_days=2.0, policy=version)
        while not g.run(hours=24, **QUIET)["status"]["over"]:
            pass
        return g.ghost.state.lat, g.ghost.state.lon

    assert ghost_end(1) != ghost_end(2)
    assert ghost_end(2) == ghost_end(2)  # and each is repeatable


def _payload(code):
    return json.loads(zlib.decompress(base64.urlsafe_b64decode(code + "=" * (-len(code) % 4))))


def test_a_saved_game_keeps_the_policy_it_was_sailed_with(env):
    # A game saved before policy 2 existed carries no policy: it loads on policy 1 and lands where it was.
    old = Game(env, launch_index=MAY1, max_days=2.0, policy=ODDS_POLICY)
    old.run(hours=20, **QUIET)
    code = old.save()
    assert "ap" not in _payload(code)
    back = Game.load(env, code)
    assert back.policy == ODDS_POLICY
    assert (back.mine.state.lat, back.mine.state.lon) == (old.mine.state.lat, old.mine.state.lon)
    assert (back.ghost.state.lat, back.ghost.state.lon) == (
        old.ghost.state.lat,
        old.ghost.state.lon,
    )
    # A game sailed now says so, and comes back on the same policy.
    new = Game(env, launch_index=MAY1, max_days=2.0)
    new.run(hours=20, **QUIET)
    code = new.save()
    assert _payload(code)["ap"] == GAME_POLICY
    back = Game.load(env, code)
    assert back.policy == GAME_POLICY
    assert (back.ghost.state.lat, back.ghost.state.lon) == (
        new.ghost.state.lat,
        new.ghost.state.lon,
    )
