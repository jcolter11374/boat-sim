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
