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
from boatsim.sandbox.helm import LAND_CLOSE_KM, LAND_REARM_KM, LAND_WARN_KM, Game, launch_days
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


@pytest.mark.parametrize(
    "base",
    ["joke_canoe", "joke_flamingo", "stock_dinghy14", "stock_sail_drone7", "stock_ocean_rower45"],
)
def test_stock_and_joke_boats_sail_in_the_helm(env, base):
    g = Game(env, choices={"base": base}, launch_index=MAY1, max_days=0.9)
    g.order("finish", 1.0)
    g.run(hours=12)
    r = g.result()
    assert r["build"] == base
    assert r["boat"]["ending"]["boat"] == g.design.stock["label"]


# ------------------------------------------------------------- start from a port


def test_a_port_start_moves_both_boats_and_survives_save(env):
    from boatsim.oceandata import ports

    boston = ports.load()["boston"]
    at = (boston["launch_lat"], boston["launch_lon"])
    g = Game(env, launch_index=MAY1, start_port="boston", max_days=1.0)
    assert g.drop == at
    assert (g.mine.state.lat, g.mine.state.lon) == at == (g.ghost.state.lat, g.ghost.state.lon)
    assert g._route[0].lat == at[0] and g.finish == FINISH  # the route starts there, same finish
    g.order("finish", 0.5)
    g.run(hours=6)
    back = Game.load(env, g.save())
    assert back.start_port == "boston" and back.mine.state == g.mine.state
    assert g.result()["start_port"] == "boston"
    # Old links (no "sp") start from the usual drop.
    assert Game(env, launch_index=MAY1, max_days=0.5).start_port is None


def test_ports_you_cannot_start_from(env):
    with pytest.raises(ValueError, match="no port called"):
        Game(env, launch_index=MAY1, start_port="atlantis")
    with pytest.raises(ValueError, match="start line"):
        Game(env, launch_index=MAY1, start_port="lisboa")  # east of the start line
    with pytest.raises(ValueError, match="drift out of the weather"):
        Game(env, launch_index=MAY1, start_port="saint-john-s")  # Newfoundland: drifts past 50N


def test_a_port_start_still_logs_the_start_line(env, monkeypatch):
    """The picker only offers ports west of the race's start line; a voyage from
    one must still log the Microtransat start when it crosses it."""
    from boatsim.oceandata import ports

    near = {"id": "edge", "name": "Edge", "launch_lat": 40.0, "launch_lon": -65.04}
    near |= {"in_corridor": True, "crosses_start": True}
    monkeypatch.setattr(ports, "load", lambda path=None: {"edge": near})
    g = Game(env, launch_index=MAY1, start_port="edge", breakdowns=False, max_days=1.0)
    assert g.mine.log.t_start_line is None
    g.order(90.0, 1.0)  # due east, across the line at 40N 65W
    g.run(hours=12)
    assert g.mine.log.t_start_line is not None


def test_a_port_must_be_inside_the_weather_loaded(env, monkeypatch):
    """Checked against the bundle in use (a challenge brings its own), not only
    the precomputed corridor flag: no drop on or past the grid's edge."""
    from boatsim.oceandata import ports

    lats, lons = env.weather.lats, env.weather.lons
    edge = {"id": "edge", "name": "Edge", "in_corridor": True, "crosses_start": True}
    edge |= {"launch_lat": float(lats[0]) + 0.5, "launch_lon": float(lons[0]) + 5}
    inside = edge | {"id": "in", "launch_lat": float(lats[0]) + 2}
    monkeypatch.setattr(ports, "load", lambda path=None: {"edge": edge, "in": inside})
    with pytest.raises(ValueError, match="doesn't reach"):
        Game(env, launch_index=MAY1, start_port="edge")
    assert (
        Game(env, launch_index=MAY1, start_port="in", max_days=0.5).drop[0] == inside["launch_lat"]
    )


def _picker_ports():
    from boatsim.oceandata import ports

    return sorted(k for k, p in ports.load().items() if p["in_corridor"] and p["crosses_start"])


def test_every_offered_port_sails_a_day_without_running_aground(env):
    """Ravi's check on #246: from every port the picker offers, both boats sail
    the launch route for a day and neither hits land or the weather's edge."""
    offered = _picker_ports()
    assert len(offered) >= 20
    for pid in offered:
        g = Game(env, launch_index=MAY1, start_port=pid, breakdowns=False, max_days=2.0)
        g.run(hours=24, land_within_km=None, breakdown=False, ghost_passes=False)
        for v in (g.mine, g.ghost):
            assert not v.done, (pid, g.result())


def test_ports_file_is_read_once():
    from boatsim.oceandata import ports

    assert ports.load() is ports.load()


CRUISER = {"base": "stock_cruiser31"}


def test_sail_and_engine_orders_on_the_cruiser(env):
    g = Game(env, CRUISER, launch_index=MAY1, max_days=0.9)
    assert g.status()["sailboat"] and g.status()["sailing"]["plan"] is not None
    g.order("finish", 0.0, sails="reef2", engine=False)
    g.run(hours=6, ghost_passes=False, land_within_km=None, breakdown=False)
    st = g.status()
    assert st["order"]["sails"] == "reef2" and st["order"]["engine"] is False
    assert st["sailing"]["plan"] == "reef2" and st["sailing"]["engine_on"] is False
    assert st["sailing"]["tactic"] in ("beat", "run", "reach")
    g.order("finish", 0.5, engine=True)  # motor-sail; sails back to the boat's choice
    g.run(hours=1, ghost_passes=False, land_within_km=None, breakdown=False)
    assert g.status()["sailing"]["engine_on"] is True
    with pytest.raises(ValueError):
        g.order("finish", 0.5, sails="spinnaker")
    json.dumps(g.status())


def test_sail_orders_survive_a_share_link(env):
    g = Game(env, CRUISER, launch_index=MAY1, max_days=0.9)
    g.order(80, 0.0, sails="reef1")
    g.run(hours=3, ghost_passes=False, land_within_km=None, breakdown=False)
    g.order("finish", 0.3, engine=True)
    g.run(hours=2, ghost_passes=False, land_within_km=None, breakdown=False)
    h = Game.load(env, g.save())
    assert (h.mine.state.lat, h.mine.state.lon) == (g.mine.state.lat, g.mine.state.lon)
    assert [o.get("sails") for o in h.orders] == ["reef1", None]


def test_no_sail_orders_for_boats_without_sails(env):
    g = Game(env, launch_index=MAY1, max_days=0.9)
    assert not g.status()["sailboat"] and "sailing" not in g.status()
    with pytest.raises(ValueError):
        g.order("finish", 0.5, sails="reef1")
    with pytest.raises(ValueError):
        g.order("finish", 0.5, engine=True)


@pytest.mark.parametrize(
    ("base", "plans", "engine"),
    [
        ("stock_cruiser31", ["full", "reef1", "reef2", "storm", "down"], True),
        ("stock_dinghy14", ["full", "down"], False),
        ("stock_beachcat16", ["full", "main_only", "down"], False),
    ],
)
def test_each_sailboat_takes_only_its_own_sail_plans(env, base, plans, engine):
    """Ravi's check of #242 (docs/qa/helm-sail-engine-orders.md): the dinghy took
    reef1 and did nothing, and the beach cat refused main_only. Each boat now
    takes exactly its own polar's plans, and engine orders only if it has one."""
    g = Game(env, {"base": base}, launch_index=MAY1, max_days=0.9)
    st = g.status()["sailing"]
    assert st["plans"] == plans and st["has_engine"] is engine
    for plan in plans:
        g.order("finish", 0.5, sails=plan)
    for plan in {"full", "reef1", "reef2", "storm", "main_only", "down"} - set(plans):
        with pytest.raises(ValueError):
            g.order("finish", 0.5, sails=plan)
    if engine:
        g.order("finish", 0.5, engine=False)
    else:
        with pytest.raises(ValueError, match="no engine"):
            g.order("finish", 0.5, engine=True)


def test_base_station_sends_sail_orders_with_the_route(env):
    g = Game(env, CRUISER, launch_index=MAY1, max_days=2.5, mode="base")
    sent = g.order("finish", 0.0, sails="storm", engine=False)
    assert sent["accepted"] and g.helm.sails is None  # not aboard yet
    out = g.run(ghost_passes=False, land_within_km=None, breakdown=False)
    assert out["stopped"] == "order_arrived"
    g.run(hours=1, ghost_passes=False, land_within_km=None, breakdown=False)
    assert g.helm.sails == "storm" and g.helm.engine is False
    assert g.status()["sailing"]["plan"] == "storm"


# ------------------------------------------------------------- the near-land ring


def test_a_port_start_still_stops_before_running_ashore(env):
    """Ravi's port check (11 Nov): from Yarmouth, ~23 km off Nova Scotia and so
    already inside the 50 km ring, a boat ran ashore with no "land" stop. The
    10 km ring stops it the first time it closes in, with the boat still afloat."""
    g = Game(env, launch_index=MAY1, start_port="yarmouth", breakdowns=False, max_days=3.0)
    assert g._land_km() < LAND_WARN_KM  # starts inside the outer ring
    g.order(0.0, 1.0)  # due north, onto the Nova Scotia shore
    out = g.run(ghost_passes=False, breakdown=False)
    assert out["stopped"] == "land" and not g.mine.done
    assert g._land_km() <= LAND_CLOSE_KM
    # Fires once: carrying on in, the next stop is the grounding itself.
    assert g.run(ghost_passes=False, breakdown=False)["stopped"] == "over"
    assert g.result()["boat"]["outcome"] == "aground"


def test_the_near_ring_rearms_only_once_clear(env):
    g = Game(env, launch_index=MAY1, start_port="yarmouth", breakdowns=False, max_days=3.0)
    g.order(0.0, 1.0)
    assert g.run(ghost_passes=False, breakdown=False)["stopped"] == "land"
    g.order(180.0, 1.0)  # back out to sea
    g.run(hours=3, ghost_passes=False, breakdown=False, land_within_km=None)
    assert g._land_km() >= LAND_REARM_KM and g.close_armed
    g.order(0.0, 1.0)  # and in again: a second warning
    assert g.run(ghost_passes=False, breakdown=False)["stopped"] == "land"
    # Saving and loading replays the ring the same way.
    back = Game.load(env, g.save())
    assert back.close_armed == g.close_armed and back.mine.state == g.mine.state
