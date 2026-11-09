from datetime import datetime, timedelta

from boatsim.autonomy import WaypointAutopilot
from boatsim.comms import GlobalstarPinger, PerfectLink
from boatsim.config import load_design
from boatsim.oceandata import ConstantEnvironment, PerfectForecast
from boatsim.runner import Components, simulate
from boatsim.runner.simulate import default_mission
from boatsim.types import EnvState, EventKind, Mission, Waypoint
from boatsim.vessel import KinematicVessel


class DelayedDownLink(PerfectLink):
    """Up arrives at once; down waits a fixed time (like the Iridium mailbox)."""

    def __init__(self, delay: timedelta):
        self.delay = delay

    def send(self, msg, env, rng):
        super().send(msg, env, rng)
        return msg.t_sent if msg.direction == "up" else msg.t_sent + self.delay


class DeadLink(PerfectLink):
    def send(self, msg, env, rng):
        return None


class OneShotBase:
    """Sends one new route after the first report, and records when it saw reports."""

    def __init__(self):
        self.seen: list[str] = []

    def on_report(self, report, forecast):
        self.seen.append(report["t"])
        if len(self.seen) == 1:
            return Mission([Waypoint(30.0, -60.0)])
        return None


def _run(link, base, pinger=None, days=3):
    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(EnvState(ghi=1000.0))
    c = Components(
        env=env,
        forecast=PerfectForecast(env),
        vessel=KinematicVessel(design),
        autopilot=WaypointAutopilot(),
        link=link,
        base=base,
        pinger=pinger,
    )
    return simulate(c, datetime(2020, 10, 1), 36.85, -75.7, default_mission(), max_days=days)


def _first(log, kind):
    return next(e.t for e in log.events if e.kind == kind)


def test_new_route_applies_only_when_delivered():
    log = _run(DelayedDownLink(timedelta(hours=6)), OneShotBase())
    sent = _first(log, EventKind.MESSAGE_RECEIVED)
    applied = _first(log, EventKind.MISSION_UPDATED)
    assert applied - sent >= timedelta(hours=6)
    assert applied - sent < timedelta(hours=6, minutes=10)


def test_lost_reports_never_reach_base():
    base = OneShotBase()
    log = _run(DeadLink(), base)
    assert base.seen == []
    assert not any(e.kind == EventKind.MISSION_UPDATED for e in log.events)


def test_globalstar_pings_on_schedule():
    pinger = GlobalstarPinger(p_copy_calm=1.0)
    _run(PerfectLink(), OneShotBase(), pinger=pinger, days=2)
    assert len(pinger.pings) == 9  # at launch, then every 6 h through hour 48
    assert all(ok for _, ok in pinger.pings)


class ContactRecorder(WaypointAutopilot):
    def __init__(self):
        super().__init__()
        self.contacts = []

    def on_message_received(self, t):
        self.contacts.append(t)


def test_delivered_route_counts_as_contact_for_safe_mode():
    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(EnvState(ghi=1000.0))
    ap = ContactRecorder()
    c = Components(
        env=env,
        forecast=PerfectForecast(env),
        vessel=KinematicVessel(design),
        autopilot=ap,
        link=DelayedDownLink(timedelta(hours=6)),
        base=OneShotBase(),
    )
    log = simulate(c, datetime(2020, 10, 1), 36.85, -75.7, default_mission(), max_days=3)
    assert ap.contacts == [_first(log, EventKind.MISSION_UPDATED)]


class DarkThenSun:
    """No sun for the first 4 days (the battery runs flat), then bright sun."""

    def __init__(self, dark_days=4.0):
        self.dark_until = None
        self.dark_days = dark_days

    def sample(self, t, lat, lon):
        if self.dark_until is None:
            self.dark_until = t + timedelta(days=self.dark_days)
        return EnvState(ghi=0.0 if t < self.dark_until else 900.0)


class PowerLog:
    """Wraps a vessel and records (t, electronics_on) after every step."""

    def __init__(self, vessel):
        self.vessel, self.trace = vessel, []

    def initial_state(self, *a):
        return self.vessel.initial_state(*a)

    def sense(self, *a):
        return self.vessel.sense(*a)

    def step(self, *a):
        state, events = self.vessel.step(*a)
        self.trace.append((state.t, state.electronics_on))
        return state, events


class EveryReportBase:
    """Sends a route after every report, and records when it saw reports."""

    def __init__(self):
        self.seen = []

    def on_report(self, report, forecast):
        self.seen.append(datetime.fromisoformat(report["t"]))
        return Mission([Waypoint(38.5, -28.0)])


def test_dead_boat_stops_reporting_and_collects_routes_after_restart():
    from boatsim.comms import IridiumSBDLink
    from boatsim.vessel import KayakVessel

    design = load_design("configs/v4_kayak.yaml")
    vessel = PowerLog(KayakVessel(design))
    env = DarkThenSun()
    link = IridiumSBDLink(p_try_calm=1.0, mailbox="scheduled")
    base = EveryReportBase()
    pinger = GlobalstarPinger(p_copy_calm=1.0)
    # Full thrust with no sun drains the 1,280 Wh battery in under a day.
    c = Components(env, PerfectForecast(env), vessel, WaypointAutopilot(), link, base, pinger)
    log = simulate(c, datetime(2020, 10, 1), 36.85, -75.7, default_mission(), max_days=8)

    off = [t for t, on in vessel.trace if not on]
    assert off, "battery should have gone flat in the dark"
    off_start, back_on = off[0], next(t for t, on in vessel.trace if on and t > off[-1])

    sent = [e.t for e in log.events if e.kind == EventKind.MESSAGE_SENT]
    assert not any(off_start <= t < back_on for t in sent)  # silent while dead
    assert any(t >= back_on for t in sent)  # talks again after restart
    assert not any(off_start <= t < back_on for t in base.seen)

    updates = [e.t for e in log.events if e.kind == EventKind.MISSION_UPDATED]
    assert not any(off_start <= t < back_on for t in updates)

    # Globalstar has its own solar cell and keeps pinging throughout.
    pings = [e.t for e in log.events if e.detail == "globalstar ping"]
    assert any(off_start <= t < back_on for t in pings)

    # No mailbox checks are billed while the modem was dead.
    full = IridiumSBDLink(p_try_calm=1.0, mailbox="scheduled")
    cost_dead = link.voyage_cost_usd(log.start, log.end)["empty_mailbox_checks"]
    cost_alive = full.voyage_cost_usd(log.start, log.end)["empty_mailbox_checks"]
    assert cost_dead < cost_alive


def test_silent_boat_is_disqualified_after_ten_days():
    """Microtransat rule: no transmission for more than 10 days in a row."""
    from boatsim.types import Outcome

    log = _run(DeadLink(), OneShotBase(), days=20)
    assert log.outcome == Outcome.DISQUALIFIED
    assert 10.0 < log.days < 10.1


def test_globalstar_pings_keep_a_boat_with_a_dead_modem_in_the_race():
    from boatsim.types import Outcome

    log = _run(DeadLink(), OneShotBase(), pinger=GlobalstarPinger(p_copy_calm=1.0), days=20)
    assert log.outcome != Outcome.DISQUALIFIED
