"""QA gates for Take the helm (Ravi): the game must be fair and repeatable.

* Determinism: the same orders at the same game times give bit-identical voyages.
* Pause/resume: running in many short pieces equals one straight run.
* Looking doesn't touch: status(), forecast() and track() calls change nothing.
* Ghost lockstep: the ghost is never ahead of the player's clock, and its
  voyage is bit-identical to a straight odds-run voyage of the same launch.
* Draw rule: under DRAW_DAYS is a draw, at or over it is a win or loss.
"""

import io
from datetime import timedelta
from itertools import pairwise

import pytest
from test_sandbox import _fake_sources
from test_sandbox_helm import MAY1

from boatsim.runner.land import default_land
from boatsim.runner.simulate import default_mission, simulate, standard_components
from boatsim.sandbox import catalog
from boatsim.sandbox import forcing as F
from boatsim.sandbox import helm as H
from boatsim.sandbox import run as R
from boatsim.sandbox.helm import Game
from boatsim.sandbox.run import launches

DAYS = 2.5
QUIET = {"ghost_passes": False, "land_within_km": None, "breakdown": False}
# (game hour, heading, power): a few course and power changes
ORDERS = [(0, "finish", 0.8), (9, 120, 0.3), (20, "route", 1.0), (31, 75, 0.0), (40, "finish", 0.6)]


@pytest.fixture(scope="module")
def env():
    era5, glorys, ships = _fake_sources()
    buf = io.BytesIO()
    F.cut(
        2020, buf, era5, glorys, ships, log=lambda *_: None, first=(5, 1), last=(5, 10)
    )  # room for 5-day forecasts
    return R.open_bundle(buf.getvalue())


def _rows(v):
    return [dict(r) for r in v.log.rows], [(e.t, e.kind, e.detail) for e in v.log.events]


def _play(env, pieces_h, look=False):
    """Play ORDERS to the end, letting time run in pieces of `pieces_h` hours
    between orders (None: up to the next order in one go)."""
    g = Game(env, launch_index=MAY1, max_days=DAYS)
    plan = ORDERS + [(DAYS * 24 + 1, None, None)]
    for (h, heading, power), (h_next, _, _) in pairwise(plan):
        if g.status()["over"]:
            break
        g.order(heading, power)
        target = g.start + timedelta(hours=h_next)
        while not g.status()["over"] and g.mine.state.t < target:
            left = (target - g.mine.state.t).total_seconds() / 3600
            g.run(hours=left if pieces_h is None else min(pieces_h, left), **QUIET)
            assert g.ghost.state.t <= g.mine.state.t  # lockstep: never ahead
            if look:
                g.status()
                g.forecast(hours=48)
                g.track()
                g.lead_km()
    return g


def test_same_orders_same_voyage(env):
    a, b = _play(env, None), _play(env, None)
    # A real game: both boats sailed the whole time, none fell off the weather data.
    assert not a.left_data and a.result()["boat"]["outcome"] == "timeout"
    assert a.mine.state.t >= a.start + timedelta(days=DAYS)
    assert _rows(a.mine) == _rows(b.mine)
    assert _rows(a.ghost) == _rows(b.ghost)
    assert a.result() == b.result()


@pytest.mark.parametrize("piece_h", [1, 6, 7.5])
def test_pause_and_resume_equals_a_straight_run(env, piece_h):
    straight, pieces = _play(env, None), _play(env, piece_h)
    assert _rows(pieces.mine) == _rows(straight.mine)
    assert _rows(pieces.ghost) == _rows(straight.ghost)


def test_looking_changes_nothing(env):
    quiet, nosy = _play(env, 6), _play(env, 6, look=True)
    assert _rows(nosy.mine) == _rows(quiet.mine)
    assert _rows(nosy.ghost) == _rows(quiet.ghost)


def test_ghost_is_bit_identical_to_a_straight_odds_run(env):
    g = _play(env, 6)
    g.result()  # runs the rest of the ghost's voyage
    start, seed = launches(env)[MAY1]
    design = catalog.design_for(None)
    drop = (design.voyage["drop_lat"], design.voyage["drop_lon"])
    c = standard_components(design, env, env, seed=seed, land=default_land())
    log = simulate(c, start, *drop, default_mission(drop), seed=seed, max_days=DAYS)
    assert [dict(r) for r in g.ghost.log.rows] == [dict(r) for r in log.rows]
    assert [(e.t, e.kind) for e in g.ghost.log.events] == [(e.t, e.kind) for e in log.events]


def test_ghost_never_ahead_with_every_stop_condition(env):
    g = Game(env, launch_index=MAY1, max_days=DAYS)
    g.order(270, 0.0)
    while not g.status()["over"]:
        g.run(soc_below=0.5, wind_above=8.0)  # stops often
        assert g.ghost.state.t <= g.mine.state.t
        g.order("finish", 1.0)


def _fake_game(me_days, gh_days, me="arrived", gh="arrived"):
    """A Game whose two voyages have already ended as given (no simulation)."""
    from datetime import datetime
    from types import SimpleNamespace as NS

    from boatsim.types import Outcome

    start = datetime(2020, 5, 1, 12)

    def voyage(days, outcome):
        t = start + timedelta(days=days)
        log = NS(rows=[{"soc": 0.5}], events=[], outcome=Outcome(outcome))
        return NS(state=NS(t=t), log=log, done=True)

    g = Game.__new__(Game)
    g.choices, g.seed, g.breakdowns, g.orders, g.left_data = None, 1, True, [], set()
    g.mode = "hands_on"
    g.start = start
    g.mode = "hands_on"  # #202 added mode to result(); same fix as #206 and #209
    g.mine, g.ghost = voyage(me_days, me), voyage(gh_days, gh)
    g._advance = lambda v, until=None: None
    return g


@pytest.mark.parametrize(
    ("me", "gh", "verdict"),
    [
        ((70.0, "arrived"), (70.99, "arrived"), "draw"),
        ((70.99, "arrived"), (70.0, "arrived"), "draw"),
        ((70.0, "arrived"), (70.0, "arrived"), "draw"),
        ((70.0, "arrived"), (71.0, "arrived"), "won"),  # a full day is not a draw
        ((71.0, "arrived"), (70.0, "arrived"), "lost"),
        ((95.0, "arrived"), (60.0, "lost"), "won"),  # finishing beats not finishing, however slow
        ((3.9, "lost"), (70.0, "arrived"), "lost"),
        ((3.9, "lost"), (3.9, "lost"), "neither_finished"),
        ((64.0, "disqualified"), (75.0, "aground"), "neither_finished"),
    ],
)
def test_draw_rule(me, gh, verdict):
    r = _fake_game(me[0], gh[0], me[1], gh[1]).result()
    assert H.DRAW_DAYS == 1.0
    assert r["verdict"] == verdict
    if verdict in ("won", "lost", "draw") and me[1] == gh[1] == "arrived":
        assert r["margin_days"] == pytest.approx(gh[0] - me[0])
    else:
        assert r["margin_days"] is None
