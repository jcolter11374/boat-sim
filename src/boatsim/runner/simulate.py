from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np

from boatsim.autonomy.base import Autopilot
from boatsim.basestation.base import BasePolicy
from boatsim.comms.base import Link
from boatsim.comms.packing import pack_report
from boatsim.oceandata.base import Environment, Forecast
from boatsim.runner.arrival import EAST_LINE, WEST_LINE, FinishTarget, SilenceClock, crosses
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
    land: object | None = None  # runner.land.LandMask; None = no aground check (#70)
    finish: FinishTarget = field(default_factory=FinishTarget)  # Microtransat target circle


@dataclass
class VoyageLog:
    start: datetime
    seed: int
    outcome: Outcome = Outcome.TIMEOUT
    end: datetime | None = None
    rows: list[dict] = field(default_factory=list)
    events: list[Event] = field(default_factory=list)
    t_start_line: datetime | None = None  # crossed the western (start) line
    t_finish_line: datetime | None = None  # crossed the eastern line, target or not

    @property
    def days(self) -> float:
        end = self.end or (self.rows[-1]["t"] if self.rows else self.start)
        return (end - self.start).total_seconds() / 86400.0

    def to_dataframe(self):
        import pandas as pd  # lazy: the in-browser sandbox has no pandas

        return pd.DataFrame(self.rows)


def _report(state) -> dict:
    """The daily position report the boat sends home, packed to 16 bytes
    (comms/packing.py) so it costs one Iridium credit."""
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


class Voyage:
    """One voyage that can be paused and resumed (Take the helm).

    `simulate()` is `Voyage(...).run()`; a game calls `run_until(t)`, looks at
    `state`, `env` and `log`, changes what the autopilot will do, and carries
    on. Stepping in pieces gives exactly the same voyage as one call: the loop
    body is the same code in the same order, with the same random streams.
    """

    def __init__(
        self,
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
    ):
        self.c, self.dt, self.report_every, self.log_every = c, dt, report_every, log_every
        self.mission = mission
        # Separate random streams, so that a change in one part (say base sends an
        # extra route, which costs the link a few draws) doesn't reshuffle the dice
        # of another (the boat's failures). Paired comparisons in the sensitivity
        # study rely on this: same seed, same luck at sea, whatever base does.
        self.hull_rng, self.sense_rng, self.link_rng, self.ping_rng = (
            np.random.default_rng(s) for s in np.random.SeedSequence(seed).spawn(4)
        )
        self.state = c.vessel.initial_state(start, start_lat, start_lon)
        self.env = None  # conditions at the boat on the last step
        self.log = VoyageLog(start=start, seed=seed)
        self.next_report = start + report_every
        self.next_ping = start
        self.pending_up: list[tuple[datetime, dict]] = []
        self.pending_down: list[tuple[datetime, Mission]] = []
        self.n_steps = int(timedelta(days=max_days) / dt)
        self.was_powered = True
        self.silence = SilenceClock(start)
        self.i = 0  # steps taken
        self.done = False

    def _stop(self) -> bool:
        self.done = True
        return True

    def run(self) -> VoyageLog:
        """To the end: arrived, lost, aground, disqualified or out of time."""
        while not self.done:
            self.step()
        return self.log

    def run_until(self, t: datetime) -> VoyageLog:
        """Step until the boat's clock reaches `t` or the voyage ends."""
        while not self.done and (self.state.t < t or self.i >= self.n_steps):
            self.step()
        return self.log

    def step(self) -> bool:
        """One time step; True once the voyage has ended."""
        if self.done:
            return True
        if self.i >= self.n_steps:
            self.log.end = self.state.t
            self.log.events.append(Event(self.state.t, EventKind.TIMEOUT))
            return self._stop()
        env = self.env = self.c.env.sample(self.state.t, self.state.lat, self.state.lon)
        sensors = self.c.vessel.sense(self.state, self.sense_rng)
        cmd = self.c.autopilot.update(sensors, self.mission, self.state.t)
        prev_pos = (self.state.lat, self.state.lon)
        self.state, events = self.c.vessel.step(self.state, cmd, env, self.dt, self.hull_rng)
        self.log.events.extend(events)
        pos = (self.state.lat, self.state.lon)
        if self.log.t_start_line is None and crosses(WEST_LINE, prev_pos, pos):
            self.log.t_start_line = self.state.t
            self.log.events.append(Event(self.state.t, EventKind.START_LINE))
        if self.log.t_finish_line is None and crosses(EAST_LINE, prev_pos, pos):
            self.log.t_finish_line = self.state.t
            self.log.events.append(Event(self.state.t, EventKind.FINISH_LINE))

        # A flat battery cuts power to the Iridium modem: no reports, no mailbox
        # checks, and routes from base wait in the mailbox until it restarts.
        # A dead modem, antenna or main box (hazards, #89) silences it the same
        # way, for good. The Globalstar beacon has its own solar cell and keeps
        # pinging unless it has failed itself.
        powered = getattr(self.state, "electronics_on", True) and getattr(
            self.state, "iridium_ok", True
        )
        if powered != self.was_powered:
            note = getattr(self.c.link, "set_powered", None)
            if note is not None:
                note(self.state.t, powered)
            if powered:
                # Routes that arrived while it was off are collected at the
                # first mailbox check after restart.
                next_check = getattr(self.c.link, "next_mailbox_check", None)
                for k, (t_due, new) in enumerate(self.pending_down):
                    if t_due <= self.state.t and next_check is not None:
                        self.pending_down[k] = (next_check(self.state.t), new)
            self.was_powered = powered

        # Satellite traffic. Reports and routes take effect when they are
        # delivered, not when they are sent: an uplink may need retries, and a
        # route from base waits in the Iridium mailbox until the boat checks it.
        if self.state.t >= self.next_report:
            self.next_report += self.report_every
            if powered:
                report = _report(self.state)
                msg = Message(self.state.t, "up", report, size_bytes=len(pack_report(report)))
                t_up = self.c.link.send(msg, env, self.link_rng)
                if t_up is not None:
                    self.log.events.append(Event(self.state.t, EventKind.MESSAGE_SENT))
                    self.pending_up.append((t_up, report))

        for item in [x for x in self.pending_up if x[0] <= self.state.t]:
            self.pending_up.remove(item)
            t_up, report = item
            self.log.events.append(Event(t_up, EventKind.MESSAGE_RECEIVED, "report at base"))
            self.silence.heard(t_up)
            new = self.c.base.on_report(report, self.c.forecast.issue(t_up))
            if new is not None:
                down = Message(
                    t_up,
                    "down",
                    {"waypoints": len(new.waypoints)},
                    size_bytes=mission_size_bytes(new),
                )
                t_down = self.c.link.send(down, env, self.link_rng)
                if t_down is not None:
                    self.pending_down.append((t_down, new))

        for item in [x for x in self.pending_down if x[0] <= self.state.t and powered]:
            self.pending_down.remove(item)
            new = item[1]
            new.version = self.mission.version + 1
            self.mission = new
            self.log.events.append(Event(self.state.t, EventKind.MISSION_UPDATED))
            # Any delivered base message proves the link works (safe mode's lost-comms clock).
            notify = getattr(self.c.autopilot, "on_message_received", None)
            if notify is not None:
                notify(self.state.t)

        if self.c.pinger is not None and self.state.t >= self.next_ping:
            self.next_ping += self.c.pinger.every
            if (
                getattr(self.state, "beacon_ok", True)
                and self.c.pinger.ping(
                    self.state.t, self.state.lat, self.state.lon, env, self.ping_rng
                )
                is not None
            ):
                self.log.events.append(
                    Event(self.state.t, EventKind.MESSAGE_RECEIVED, "globalstar ping")
                )
                self.silence.heard(self.state.t)

        if self.i % self.log_every == 0:
            self.log.rows.append(
                {
                    "t": self.state.t,
                    "lat": self.state.lat,
                    "lon": self.state.lon,
                    "heading": self.state.heading,
                    "stw": self.state.speed_through_water,
                    "soc": self.state.soc,
                    "wind_u": env.wind_u,
                    "wind_v": env.wind_v,
                    "hs": env.hs,
                    "tp": env.tp,
                    "wave_dir": env.wave_dir,
                    "current_u": env.current_u,
                    "current_v": env.current_v,
                    "ghi": env.ghi,
                    "rain": getattr(env, "rain", 0.0),
                    # Radios this hour (the 3D page shades silent spells from these).
                    "iridium_ok": bool(
                        getattr(self.state, "electronics_on", True)
                        and getattr(self.state, "iridium_ok", True)
                    ),
                    "beacon_ok": bool(getattr(self.state, "beacon_ok", True)),
                }
            )

        if not self.state.alive:
            self.log.outcome, self.log.end = Outcome.LOST, self.state.t
            return self._stop()
        if self.c.finish.reached(self.state.lat, self.state.lon):
            # Microtransat finish: inside the target circle, and the boat logs
            # its position there (the GPS log counts).
            self.log.outcome, self.log.end = Outcome.ARRIVED, self.state.t
            self.log.events.append(Event(self.state.t, EventKind.ARRIVED))
            return self._stop()
        if self.c.land is not None and self.c.land.on_land(self.state.lat, self.state.lon):
            # Ashore before reaching the target: a kayak can't get off again.
            self.log.outcome, self.log.end = Outcome.AGROUND, self.state.t
            where = f"{self.state.lat:.2f}N {abs(self.state.lon):.2f}W"
            self.log.events.append(Event(self.state.t, EventKind.AGROUND, where))
            return self._stop()
        why = self.silence.disqualified(self.state.t)
        if why is not None:
            self.log.outcome, self.log.end = Outcome.DISQUALIFIED, self.state.t
            self.log.events.append(Event(self.state.t, EventKind.DISQUALIFIED, why))
            return self._stop()

        self.i += 1
        return False


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
    return Voyage(
        c, start, start_lat, start_lon, mission, seed, dt, max_days, report_every, log_every
    ).run()


# Where the support boat drops the kayak: 100 km ESE of Cape Henry (9 Nov 2026),
# the same point as configs/v4_kayak.yaml voyage.drop_lat/drop_lon.
DROP_POINT = (36.65, -74.94)


def default_mission(drop: tuple[float, float] | None = None) -> Mission:
    """Launch route: the drop point, then straight (great circle) to the finish target.

    The great circle peaks near 42.6N and passes about 250 km north of Flores and
    Corvo, so it clears the Azores. It replaced a dog-leg south of the Azores via
    36N 26W: in the Nov 2026 sensitivity study (run 42556820831, 2012-2021
    Apr-Jun launches, 100 voyages) the straight route finished 72/100 against
    56/100 for the dog-leg, sign test p ~ 0.01. Base still re-plans around
    foul currents and land on the way (basestation/replan.py).

    `drop` starts the route at another design's drop point (its voyage block);
    the default is ours.
    """
    return Mission(
        waypoints=[
            Waypoint(*(drop or DROP_POINT)),
            Waypoint(39.5, -13.5),  # the finish target (runner/arrival.py)
        ]
    )


def standard_components(
    design, env, forecast_env, seed: int = 0, forecast_error: float = 1.0, land=None
) -> Components:
    """The team's current components for one voyage of `design` (a config.Design)
    in `env`. Every voyage gets fresh vessel, autopilot, link and base objects
    (they keep per-voyage state such as the airtime ledger). Shared by the batch
    runs (runner.parallel) and the browser sandbox (boatsim.sandbox)."""
    from boatsim.autonomy import SafeModeAutopilot
    from boatsim.basestation import ForecastReplanPolicy
    from boatsim.comms import GlobalstarPinger, IridiumSBDLink
    from boatsim.oceandata.forecast import ErrorForecast
    from boatsim.vessel import KayakVessel

    prop = design.propulsion
    drop = (design.voyage["drop_lat"], design.voyage["drop_lon"])
    return Components(
        env=env,
        forecast=ErrorForecast(forecast_env, seed=seed, scale=forecast_error),
        vessel=KayakVessel(design),
        autopilot=SafeModeAutopilot(
            cruise_fraction=prop["cruise_drive_w"] / prop["max_drive_w"],
            thruster_count=int(prop.get("thruster_count", 2)),
        ),
        link=IridiumSBDLink(),
        pinger=GlobalstarPinger(),
        base=ForecastReplanPolicy(route=default_mission(drop).waypoints),
        land=land,
        finish=FinishTarget.from_voyage(design.voyage),
    )
