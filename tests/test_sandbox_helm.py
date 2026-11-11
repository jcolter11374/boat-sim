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
from boatsim.sandbox.helm import Game, launch_days
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
    assert out["stopped"] == "ghost_passed" and out["status"]["lead_km"] < -1.0
    assert g.mine.state.t >= g.start + timedelta(hours=1)
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


# --- Real base station mode, the 3-day cap, save and resume -------------------


def test_until_something_happens_stops_within_three_days(env):
    g = Game(env, launch_index=MAY1, max_days=3.5)
    g.order("finish", 0.3)
    out = g.run(ghost_passes=False, land_within_km=None, breakdown=False)
    assert out["stopped"] in ("time", "over")
    assert g.mine.state.t <= g.start + timedelta(hours=72, minutes=10)


def test_base_mode_order_arrives_with_the_next_daily_report(env):
    g = Game(env, launch_index=MAY1, mode="base", max_days=2.5)
    assert g.helm.safe  # the boat's own safe mode acts between orders
    g.run(hours=2, ghost_passes=False, land_within_km=None)  # just missed the launch report
    first = g.order("finish", 0.6)
    assert first["accepted"] and first["from_report"] == "2020-05-01T12:00"
    due = datetime.fromisoformat(first["arrives"])
    assert timedelta(hours=20) < due - g.start <= timedelta(hours=26)
    again = g.order(200, 0.1)
    assert not again["accepted"] and again["next_allowed"] == "2020-05-02T14:00"
    assert g.status()["base"]["waiting"] == [{"due": first["arrives"], "power": 0.6}]
    out = g.run(ghost_passes=False, land_within_km=None, breakdown=False)
    assert out["stopped"] == "order_arrived" and g.mine.state.t >= due
    assert g.mine.mission.power == 0.6  # delivered; the autopilot takes it next step
    assert g.mine.mission.waypoints[-1].lon == pytest.approx(-13.5)
    g.run(hours=1, ghost_passes=False, land_within_km=None, breakdown=False)
    assert g.helm.heading == "route" and g.helm.power == 0.6
    assert g.status()["base"]["waiting"] == []


def test_save_and_resume_gives_the_same_game(env):
    for mode in ("hands_on", "base"):
        g = Game(env, launch_index=MAY1, mode=mode, max_days=2.0)
        g.order("finish", 0.5)
        g.run(hours=25, ghost_passes=False, land_within_km=None, breakdown=False)
        g.order(120, 0.2)
        g.run(hours=7, ghost_passes=False, land_within_km=None, breakdown=False)
        code = g.save()
        assert len(code) < 400 and code.isascii() and "/" not in code and "+" not in code
        h = Game.load(env, code)
        assert h.mode == mode and h.mine.state.t == g.mine.state.t
        assert (h.mine.state.lat, h.mine.state.lon, h.mine.state.soc) == (
            g.mine.state.lat,
            g.mine.state.lon,
            g.mine.state.soc,
        )
        assert h.orders == g.orders
        a = g.run(hours=6, ghost_passes=False, land_within_km=None)
        b = h.run(hours=6, ghost_passes=False, land_within_km=None)
        assert a == b  # and they carry on identically
    with pytest.raises(ValueError):
        Game.load(env, "not-a-game")


def test_a_mangled_link_is_a_friendly_error(env):
    import base64
    import json
    import zlib

    def code(obj):
        raw = zlib.compress(json.dumps(obj).encode())
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    good = json.loads(zlib.decompress(base64.urlsafe_b64decode(
        Game(env, launch_index=MAY1, max_days=0.5).save() + "==")))  # fmt: skip
    for bad in (
        [1, 2, 3],
        {"v": 1},
        {**good, "o": [[0, "finish"]]},
        {**good, "o": "x"},
        {**good, "l": 99},
        {**good, "c": {"thr": "warp-drive"}},
    ):
        with pytest.raises(ValueError):
            Game.load(env, code(bad))


def test_forecast_stops_at_the_end_of_the_bundle(env):
    g = Game(env, launch_index=MAY1, max_days=0.5)
    f = g.forecast(hours=240)
    assert 0 < len(f) < 41 and f[-1]["t"] <= "2020-05-04T18:00"


# --- Any launch day, and losses nobody could steer around ----------------------


def test_launch_days_cover_the_bundle_and_keep_the_odds_seeds(env):
    assert launch_days(env) == []  # 1-4 May holds no whole voyage
    days = launch_days(env, max_days=0.5, lookahead_days=0.0)
    assert [d["date"] for d in days] == ["2020-05-01", "2020-05-02", "2020-05-03", "2020-05-04"]
    may1 = days[0]
    assert may1["odds"] and may1["seed"] == R.launches(env)[MAY1][1]
    assert not days[1]["odds"] and days[1]["seed"] == 2020 * 1000 + 100 + 123  # 2 May
    assert len({d["seed"] for d in days}) == len(days)
    g = Game(env, day="2020-05-02", max_days=0.5)
    assert g.start == datetime(2020, 5, 2, 12) and g.seed == days[1]["seed"]
    h = Game.load(env, g.save())
    assert h.start == g.start and h.seed == g.seed
    with pytest.raises(ValueError):
        Game(env, day="2020-07-04", max_days=0.5)
    with pytest.raises(ValueError):
        Game(env, day="2020-05-02", launch_index=0, max_days=0.5)


def test_a_shared_early_loss_says_so_plainly(env):
    g = Game(env, launch_index=MAY1, max_days=0.9)
    r = g.result()
    assert not r["shared_loss"] and r["note"] is None  # still at sea
    from types import SimpleNamespace as NS

    from boatsim.types import Event, EventKind, Outcome

    def dead(v):
        t = g.start + timedelta(days=3.9)
        ev = Event(t, EventKind.PART_FAILED, "electronics")
        return NS(state=NS(t=t), log=NS(rows=[{"soc": 0.7}], events=[ev], outcome=Outcome.LOST),
                  done=True, c=v.c)  # fmt: skip

    g.mine, g.ghost = dead(g.mine), dead(g.ghost)
    g._advance = lambda v, until=None: None
    r = g.result()
    assert r["shared_loss"] and r["verdict"] == "neither_finished"
    assert r["note"] == (
        "An electronics failure no one could steer around: both boats lost. Try another day."
    )


def test_a_weather_challenge_sets_the_drop_and_seed_and_survives_a_share_link():
    from boatsim.oceandata.challenges import by_id

    era5, glorys, ships = _fake_sources()
    buf = io.BytesIO()
    F.cut(2020, buf, era5, glorys, ships, log=lambda *_: None, first=(6, 14), last=(6, 17))
    june = R.open_bundle(buf.getvalue())
    g = Game(june, challenge="gentle-june", max_days=1.0)
    assert g.start == datetime(2020, 6, 15, 12) and g.seed == by_id("gentle-june").seed
    g.order("finish", 0.5)
    g.run(hours=6, ghost_passes=False, land_within_km=None, breakdown=False)
    h = Game.load(june, g.save())
    assert h.challenge == "gentle-june" and h.mine.state.t == g.mine.state.t
    assert g.result()["challenge"] == "gentle-june"


def test_a_challenge_needs_its_own_weather(env):
    with pytest.raises(ValueError, match="own weather"):
        Game(env, challenge="sandys-shadow")  # the May 2020 test bundle
    with pytest.raises(ValueError, match="no challenge"):
        Game(env, challenge="atlantis")
    with pytest.raises(ValueError, match="one of"):
        Game(env, launch_index=MAY1, challenge="gentle-june")


def test_base_mode_shows_what_base_knows_not_the_true_boat(env):
    g = Game(env, launch_index=MAY1, mode="base", max_days=2.5)
    assert Game(env, launch_index=MAY1, max_days=0.5).status()["show_true_position"]
    st = g.status()
    assert st["show_true_position"] is False
    assert st["base"]["reports"] == [st["base"]["last_report"]]  # just the drop
    g.run(hours=30, ghost_passes=False, land_within_km=None, breakdown=False)
    b = g.status()["base"]
    assert len(b["reports"]) == 2 and b["last_report"] == b["reports"][-1]
    est = b["estimate"]
    assert est["from_report"] == b["last_report"]["t"] and 5.0 < est["age_h"] < 7.0
    # Carried on along the last day's track, so it lands nearer the true boat
    # than the stale report does.
    from boatsim.geo import distance_m

    s = g.mine.state
    stale = distance_m(s.lat, s.lon, b["last_report"]["lat"], b["last_report"]["lon"])
    guess = distance_m(s.lat, s.lon, est["lat"], est["lon"])
    assert guess < stale


def test_a_pass_needs_a_clear_kilometre_and_not_in_the_first_hour(env):
    """Ravi, 1 May 2020: 'finish' at 25% stopped on a 2 m lead change 20 minutes in."""
    g = Game(env, launch_index=MAY1, max_days=0.9)
    g.order("finish", 0.25)
    out = g.run(land_within_km=None, breakdown=False)
    assert out["stopped"] == "passed_ghost" and out["status"]["lead_km"] > 1.0
    assert g.mine.state.t >= g.start + timedelta(hours=1)

    # Hysteresis: a lead wobbling inside +-1 km never stops the clock again.
    leads = iter([1.5, 0.2, -0.9, 0.4, -0.99, -1.2, 0.5, 0.9, 1.1])
    g.leader = None
    g.lead_km = lambda: next(leads)
    seen = [g._update_leader() for _ in range(9)]
    assert seen == [
        "passed_ghost",
        None,
        None,
        None,
        None,
        "ghost_passed",
        None,
        None,
        "passed_ghost",
    ]


def test_results_card_says_how_it_ended(env):
    g = Game(env, launch_index=MAY1, max_days=0.9)
    g.run(hours=6)
    end = g.result()["boat"]["ending"]
    assert end["headline"] in ("Still at sea", "Finished") and end["words"]


@pytest.mark.parametrize("base", ["joke_canoe", "joke_flamingo", "stock_dinghy14"])
def test_stock_and_joke_boats_sail_in_the_helm(env, base):
    g = Game(env, choices={"base": base}, launch_index=MAY1, max_days=0.9)
    g.order("finish", 1.0)
    g.run(hours=12)
    r = g.result()
    assert r["build"] == base
    assert r["boat"]["ending"]["boat"] == g.design.stock["label"]
