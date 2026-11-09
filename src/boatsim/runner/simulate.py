from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from boatsim.autonomy.base import Autopilot
from boatsim.basestation.base import BasePolicy
from boatsim.comms.base import Link
from boatsim.oceandata.base import Environment, Forecast
from boatsim.runner.arrival import in_europe
from boatsim.types import Event, EventKind, Message, Mission, Outcome, Waypoint
from boatsim.vessel.base import Vessel


@dataclass
class Components:
    """One of each package's implementation. Swap stubs for real ones here."""

    env: Environment
    forecast: Forecast
    vessel: Vessel
    autopilot: Autopilot
    link: Link
    base: BasePolicy
    pinger: object | None = None  # e.g. comms.GlobalstarPinger; one-way position beacon


@dataclass
class VoyageLog:
    start: datetime
    seed: int
    outcome: Outcome = Outcome.TIMEOUT
    end: datetime | None = None
    rows: list[dict] = field(default_factory=list)
    events: list[Event] = field(default_factory=list)

    @property
    def days(self) -> float:
        end = self.end or (self.rows[-1]["t"] if self.rows else self.start)
        return (end - self.start).total_seconds() / 86400.0

    def to_dataframe(self) -> pd.DataFrame:
        return pd.DataFrame(self.rows)


def _report(state) -> dict:
    """The daily position report the boat sends home. Keep it under 340 bytes."""
    return {
        "t": state.t.isoformat(timespec="minutes"),
        "lat": round(state.lat, 4),
        "lon": round(state.lon, 4),
        "soc": round(state.soc, 3),
        "hdg": round(state.heading),
    }


def mission_size_bytes(mission: Mission) -> int:
    """Uplinked route size: 8-byte header plus lat/lon as two int32 per waypoint."""
    return 8 + 8 * len(mission.waypoints)


def simulate(
    c: Components,
    start: datetime,
    start_lat: float,
    start_lon: float,
    mission: Mission,
    seed: int = 0,
    dt: timedelta = timedelta(minutes=10),
    max_days: float = 120.0,
    report_every: timedelta = timedelta(hours=24),
    log_every: int = 6,
) -> VoyageLog:
    """Run one voyage until it arrives, is lost, or times out.

    log_every: keep one log row per N steps (6 x 10 min = hourly) to keep files small.
    """
    rng = np.random.default_rng(seed)
    state = c.vessel.initial_state(start, start_lat, start_lon)
    log = VoyageLog(start=start, seed=seed)
    next_report = start + report_every
    next_ping = start
    pending_up: list[tuple[datetime, dict]] = []
    pending_down: list[tuple[datetime, Mission]] = []
    n_steps = int(timedelta(days=max_days) / dt)
    was_powered = True

    for i in range(n_steps):
        env = c.env.sample(state.t, state.lat, state.lon)
        sensors = c.vessel.sense(state, rng)
        cmd = c.autopilot.update(sensors, mission, state.t)
        state, events = c.vessel.step(state, cmd, env, dt, rng)
        log.events.extend(events)

        # A flat battery cuts power to the Iridium modem: no reports, no mailbox
        # checks, and routes from base wait in the mailbox until it restarts.
        # The Globalstar beacon has its own solar cell and keeps pinging.
        powered = getattr(state, "electronics_on", True)
        if powered != was_powered:
            note = getattr(c.link, "set_powered", None)
            if note is not None:
                note(state.t, powered)
            if powered:
                # Routes that arrived while it was off are collected at the
                # first mailbox check after restart.
                next_check = getattr(c.link, "next_mailbox_check", None)
                for k, (t_due, new) in enumerate(pending_down):
                    if t_due <= state.t and next_check is not None:
                        pending_down[k] = (next_check(state.t), new)
            was_powered = powered

        # Satellite traffic. Reports and routes take effect when they are
        # delivered, not when they are sent: an uplink may need retries, and a
        # route from base waits in the Iridium mailbox until the boat checks it.
        if state.t >= next_report:
            next_report += report_every
            if powered:
                report = _report(state)
                msg = Message(state.t, "up", report, size_bytes=len(str(report)))
                t_up = c.link.send(msg, env, rng)
                if t_up is not None:
                    log.events.append(Event(state.t, EventKind.MESSAGE_SENT))
                    pending_up.append((t_up, report))

        for item in [x for x in pending_up if x[0] <= state.t]:
            pending_up.remove(item)
            t_up, report = item
            log.events.append(Event(t_up, EventKind.MESSAGE_RECEIVED, "report at base"))
            new = c.base.on_report(report, c.forecast.issue(t_up))
            if new is not None:
                down = Message(
                    t_up,
                    "down",
                    {"waypoints": len(new.waypoints)},
                    size_bytes=mission_size_bytes(new),
                )
                t_down = c.link.send(down, env, rng)
                if t_down is not None:
                    pending_down.append((t_down, new))

        for item in [x for x in pending_down if x[0] <= state.t and powered]:
            pending_down.remove(item)
            new = item[1]
            new.version = mission.version + 1
            mission = new
            log.events.append(Event(state.t, EventKind.MISSION_UPDATED))
            # Any delivered base message proves the link works (safe mode's lost-comms clock).
            notify = getattr(c.autopilot, "on_message_received", None)
            if notify is not None:
                notify(state.t)

        if c.pinger is not None and state.t >= next_ping:
            next_ping += c.pinger.every
            if c.pinger.ping(state.t, state.lat, state.lon, env, rng) is not None:
                log.events.append(Event(state.t, EventKind.MESSAGE_RECEIVED, "globalstar ping"))

        if i % log_every == 0:
            log.rows.append(
                {
                    "t": state.t,
                    "lat": state.lat,
                    "lon": state.lon,
                    "heading": state.heading,
                    "stw": state.speed_through_water,
                    "soc": state.soc,
                    "wind_u": env.wind_u,
                    "wind_v": env.wind_v,
                    "hs": env.hs,
                    "ghi": env.ghi,
                }
            )

        if not state.alive:
            log.outcome, log.end = Outcome.LOST, state.t
            break
        if in_europe(state.lat, state.lon):
            log.outcome, log.end = Outcome.ARRIVED, state.t
            log.events.append(Event(state.t, EventKind.ARRIVED))
            break
    else:
        log.end = state.t
        log.events.append(Event(state.t, EventKind.TIMEOUT))

    return log


def default_mission() -> Mission:
    """Placeholder great-circle-ish route: Bay mouth to the Azores to Portugal."""
    return Mission(
        waypoints=[
            Waypoint(36.9, -75.5),
            Waypoint(38.5, -28.0),
            Waypoint(39.5, -9.6),
        ]
    )
