"""Shared data types passed between packages.

These are the contracts between threads. Change them only through a PR that
the Lead (Maya) reviews, because every package depends on them.

Units: SI unless the name says otherwise. Angles in degrees, headings are
compass degrees (0 = north, 90 = east). Vectors are (east, north) components.
Times are UTC datetimes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


@dataclass(frozen=True)
class EnvState:
    """Weather and ocean conditions at one point and time (from oceandata)."""

    wind_u: float = 0.0  # m/s, eastward wind at 10 m
    wind_v: float = 0.0  # m/s, northward wind at 10 m
    current_u: float = 0.0  # m/s, eastward surface current
    current_v: float = 0.0  # m/s, northward surface current
    hs: float = 0.0  # m, significant wave height
    tp: float = 0.0  # s, peak wave period
    wave_dir: float = 0.0  # deg, direction waves come FROM
    ghi: float = 0.0  # W/m^2, global horizontal irradiance (sunlight on a flat panel)
    cloud_fraction: float = 0.0  # 0..1
    air_temp: float = 15.0  # deg C
    rain: float = 0.0  # mm/h, rain and snow (display only: no physics uses it)
    ship_density: float = 0.0  # ships per km^2 (for collision odds)


@dataclass(frozen=True)
class Command:
    """What the autopilot asks the boat to do (from autonomy)."""

    heading: float  # deg, desired heading through the water
    thrust_fraction: float  # 0..1 of max thruster power
    # Keelboats only (vessel/keelboat.py): None = the boat picks (auto reefing);
    # or a sail plan name from its polar ("full", "reef1", "reef2", "storm", "down").
    sail_plan: str | None = None
    # Keelboats only: None = auto (motor in calms when thrust_fraction > 0),
    # True = engine on at thrust_fraction, False = off.
    engine: bool | None = None
    # Keelboats only: share of the crew's best speed this watch (a helm spell);
    # None = the autopilot's own (autopilot_factor). Sail speed only.
    trim_share: float | None = None


@dataclass
class BoatState:
    """Everything that changes during a voyage (owned by vessel)."""

    t: datetime
    lat: float
    lon: float
    heading: float = 90.0  # deg
    speed_through_water: float = 0.0  # m/s
    battery_wh: float = 0.0  # stored energy
    battery_capacity_wh: float = 0.0
    alive: bool = True
    damage: dict[str, bool] = field(default_factory=dict)  # part name -> failed?

    @property
    def soc(self) -> float:
        """Battery state of charge, 0..1."""
        if self.battery_capacity_wh <= 0:
            return 0.0
        return self.battery_wh / self.battery_capacity_wh


@dataclass(frozen=True)
class Sensors:
    """What the onboard computer can see. Not the true state: noise and
    failures belong here, so the autopilot can't cheat."""

    t: datetime
    lat: float
    lon: float
    heading: float
    soc: float
    gps_ok: bool = True
    thrusters_ok: int | None = (
        None  # working thrusters, from motor-controller current; None = unknown
    )
    # Masthead wind vane, sailboats only (None on boats without one): where the
    # wind comes from (deg) and its speed (m/s), relative to the water.
    wind_from_deg: float | None = None
    wind_speed_ms: float | None = None


@dataclass(frozen=True)
class Waypoint:
    lat: float
    lon: float


@dataclass
class Mission:
    """The route the boat is following; replaced when base sends a new one."""

    waypoints: list[Waypoint]
    active_index: int = 0
    version: int = 0


class EventKind(str, Enum):
    ARRIVED = "arrived"
    AGROUND = "aground"
    START_LINE = "start_line"  # crossed the Microtransat western line
    FINISH_LINE = "finish_line"  # crossed the eastern line (finish only inside the target)
    DISQUALIFIED = "disqualified"
    BATTERY_EMPTY = "battery_empty"
    CAPSIZE = "capsize"
    PART_FAILED = "part_failed"
    SHIP_STRIKE = "ship_strike"
    LOST = "lost"  # e.g. sank, aground, or left the simulation box
    MESSAGE_SENT = "message_sent"
    MESSAGE_RECEIVED = "message_received"
    MISSION_UPDATED = "mission_updated"
    SAFE_MODE = "safe_mode"
    TIMEOUT = "timeout"


@dataclass(frozen=True)
class Event:
    t: datetime
    kind: EventKind
    detail: str = ""


@dataclass(frozen=True)
class Message:
    """A satellite message. size_bytes is checked against the link limits."""

    t_sent: datetime
    direction: str  # "up" (boat -> base) or "down" (base -> boat)
    payload: dict
    size_bytes: int


class Outcome(str, Enum):
    ARRIVED = "arrived"
    LOST = "lost"
    AGROUND = "aground"  # ran onto land before finishing (#70)
    DISQUALIFIED = "disqualified"  # Microtransat rule: silent >10 days in a row or >15 total
    TIMEOUT = "timeout"
