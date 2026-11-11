"""Take the helm (boatsim.sandbox.helm, autonomy/helm.py): the player's orders,
stop conditions, the ghost and fairness."""

import io
import json
from datetime import datetime, timedelta

import pytest
from test_sandbox import _fake_sources

from boatsim.autonomy.helm import HelmAutopilot
from boatsim.sandbox import forcing as F
from boatsim.sandbox import run as R
from boatsim.sandbox.helm import Game
from boatsim.types import Mission, Sensors, Waypoint

MAY1 = 2  # launch index of 1 May 2020, inside the test bundle (1-4 May)
FINISH = (39.5, -13.5)


@pytest.fixture(scope="module")
def env():
    era5, glorys, ships = _fake_sources()
    buf = io.BytesIO()
    F.cut(2020, buf, era5, glorys, ships, log=lambda *_: None, first=(5, 1), last=(5, 4))
    return R.open_bundle(buf.getvalue())


def _sensors(soc=0.9, ok=None):
    return Sensors(datetime(2020, 5, 1), 36.65, -74.94, 90.0, soc, thrusters_ok=ok)


def test_helm_orders_become_commands():
    h = HelmAutopilot(FINISH)
    route = Mission([Waypoint(*FINISH)])
    h.set_order(200, 0.4)
    cmd = h.update(_sensors(), route, datetime(2020, 5, 1))
    assert cmd.heading == 200 and cmd.thrust_fraction == 0.4
    h.set_order("finish", 1.0)
    assert 60 < h.update(_sensors(), route, datetime(2020, 5, 1)).heading < 80  # ENE
    with pytest.raises(ValueError):
        h.set_order("home", 0.5)
    with pytest.raises(ValueError):
        h.set_order(90, 1.5)


def test_no_safe_mode_unless_asked():
    route = Mission([Waypoint(*FINISH)])
    t = datetime(2020, 5, 1)
    bold = HelmAutopilot(FINISH, heading=90, power=1.0)
    assert bold.update(_sensors(soc=0.10, ok=1), route, t).thrust_fraction == 1.0
    careful = HelmAutopilot(FINISH, heading=90, power=0.5, safe=True)
    assert careful.update(_sensors(soc=0.10), route, t).thrust_fraction == 0.0  # recharging
    careful = HelmAutopilot(FINISH, heading=90, power=0.5, safe=True)
    assert careful.update(_sensors(soc=0.9, ok=1), route, t).thrust_fraction == 1.0  # lone motor


def test_the_ghost_is_the_odds_run_voyage(env):
    """Same launch, same build: the ghost sails exactly the Boatyard's voyage."""
    g = Game(env, launch_index=MAY1, max_days=0.9)
    g.order("finish", 1.0)
    g.run(ghost_passes=False, land_within_km=None, breakdown=False)
    odds = R.run_voyage(None, env, *R.launches(env)[MAY1], max_days=0.9)["result"]
    assert g.result()["ghost"]["outcome"] == odds["outcome"]
    last = g.ghost.log.rows[-1]
    assert odds["outcome"] in ("timeout", "lost")
    assert g.status()["over"] and last["t"] <= g.mine.state.t + timedelta(hours=1)


def test_run_stops_on_time_and_the_ghost_never_runs_ahead(env):
    g = Game(env, launch_index=MAY1, max_days=0.9)
    g.order("route", 0.6)
    out = g.run(hours=6, ghost_passes=False, land_within_km=None)
    assert out["stopped"] == "time"
    assert g.mine.state.t == g.start + timedelta(hours=6)
    assert g.ghost.state.t == g.mine.state.t
    assert [r["t"] for r in out["track"]["boat"]] == ["2020-05-01T12:10"]  # one row per 6 h
    assert [r["t"] for r in out["track"]["ghost"]] == ["2020-05-01T12:10"]
    again = g.run(hours=6, ghost_passes=False, land_within_km=None)["track"]
    assert [r["t"] for r in again["boat"]] == ["2020-05-01T18:10"]
    json.dumps(out)  # what the worker hands the page
    json.dumps(g.forecast(hours=24))


def test_stop_conditions(env):
    g = Game(env, launch_index=MAY1, max_days=0.9)
    g.order(270, 0.0)  # drifting, motors off: the autopilot pulls ahead
    out = g.run(land_within_km=None, breakdown=False)
    assert out["stopped"] == "ghost_passed" and out["status"]["lead_km"] < 0
    g = Game(env, launch_index=MAY1, max_days=0.9)
    g.order("finish", 1.0)
    out = g.run(soc_below=0.99, ghost_passes=False, land_within_km=None)
    assert out["stopped"] == "battery" and out["status"]["boat"]["soc"] < 0.99
    g = Game(env, launch_index=MAY1, max_days=0.9)
    out = g.run(wind_above=0.1, ghost_passes=False, land_within_km=None)
    assert out["stopped"] == "wind"


def test_breakdowns_off_turns_them_off_for_both(env):
    g = Game(env, launch_index=MAY1, breakdowns=False, max_days=1)
    for v in (g.mine, g.ghost):
        assert not v.c.vessel.hazards.enabled and not v.c.vessel.hazards.failures_enabled
    assert Game(env, launch_index=MAY1, max_days=1).mine.c.vessel.hazards.failures_enabled


def test_results_card(env):
    g = Game(env, launch_index=MAY1, max_days=1)
    g.order("finish", 0.3)
    g.run(ghost_passes=False, land_within_km=None, breakdown=False)
    r = g.result()
    assert r["verdict"] == "neither_finished" and r["margin_days"] is None
    assert r["build"] == "k-p25" and r["launch"] == "2020-05-01T12:00"
    assert r["orders"][0]["heading"] == "finish" and 0 < r["boat"]["battery_low"] <= 1
    json.dumps(r)
