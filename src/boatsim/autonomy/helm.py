"""Take the helm: the player's orders, as an autopilot the runner can use.

An order is a heading and a power level. The heading is one of:

* a compass number (degrees, through the water: a side current still pushes
  the boat off that line, the way it would a real boat);
* ``"finish"``: point straight at the finish circle, re-aimed every step;
* ``"route"``: follow the stored route with the normal waypoint follower,
  which also crabs into the current (see guidance.py).

On a sailboat with a polar (the 31 ft cruiser), "finish" and "route" tack and
gybe with the sailing tactician (sailing.py) when the mark is upwind or dead
downwind. A compass number is steered as given; if it points into the wind
the boat sails as close as it can on the nearer tack (the vessel's limit).

Power is a fraction of the motors' full drive power (0 to 1). On a keelboat
that is the engine's power.

Sailboats with a polar also take two optional orders (None = the boat decides):

* ``sails``: a sail plan, "full", "reef1", "reef2", "storm" (smallest sails)
  or "down" (bare poles). Left to itself the boat reefs to stay under its heel
  limit.
* ``engine``: True to motor at `power`, False to keep it off. Left to itself
  it motors only in a calm.

Safe mode is off by default, so the battery is the player's to manage. The
hardware still cuts out at empty (the vessel model turns the electronics off
and back on as the sun recharges it). With ``safe=True`` the STM32 rules from
safemode.py apply on top of the order: throttle back on low charge, stop and
recharge below 15%, and give a lone surviving thruster the whole drive power.

Owner: Sam.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from boatsim.autonomy.guidance import WaypointAutopilot
from boatsim.autonomy.safemode import SafeModeAutopilot
from boatsim.autonomy.sailing import Tactician, open_water_km
from boatsim.geo import bearing_deg
from boatsim.types import Command, Mission, Sensors
from boatsim.vessel.keelboat import DOWN

HEADING_MODES = ("finish", "route")


def sail_orders_for(vessel) -> tuple[tuple[str, ...], bool]:
    """What a player may order on this boat: its own sail plans (from its polar,
    biggest first, plus "down" for bare poles) and whether it has an engine.
    A boat with no polar (the kayak, Rev B/C) has neither."""
    polar = getattr(vessel, "polar", None)
    if polar is None:
        return (), False
    return (*polar.plans, DOWN), float(getattr(vessel, "engine_kn", 0.0)) > 0.0


@dataclass
class OrderMission(Mission):
    """A route from base that also sets the motor power ("Real base station"
    mode). On the real boat this is the normal route uplink plus one byte of
    power; the boat follows the waypoints and runs the motors at `power`."""

    power: float = 0.0
    sails: str | None = None
    engine: bool | None = None


class HelmAutopilot:
    """Implements `Autopilot` from the player's current order."""

    def __init__(
        self,
        finish: tuple[float, float],
        thruster_count: int = 2,
        safe: bool = False,
        heading: float | str = "route",
        power: float = 0.0,
        tactician: Tactician | None = None,
        sails: str | None = None,
        engine: bool | None = None,
        sail_plans: Sequence[str] = (),
        has_engine: bool = False,
    ):
        """sail_plans and has_engine: what this boat can be ordered to do
        (sail_orders_for(vessel)); the defaults, none and no, suit a boat
        without sails."""
        self.finish = finish
        self.sail_plans = tuple(sail_plans)
        self.has_engine = has_engine
        self.safe = safe
        self.tactician = tactician
        self.guidance = WaypointAutopilot()
        self._rules = SafeModeAutopilot(
            cruise_fraction=1.0, guidance=self.guidance, thruster_count=thruster_count
        )
        self.heading: float | str = "route"
        self.power = 0.0
        self.sails: str | None = None
        self.engine: bool | None = None
        self.set_order(heading, power, sails, engine)
        self.last: Command | None = None
        self._mission_seen: Mission | None = None

    def set_order(
        self,
        heading: float | str,
        power: float,
        sails: str | None = None,
        engine: bool | None = None,
    ) -> None:
        if sails is not None and sails not in self.sail_plans:
            if not self.sail_plans:
                raise ValueError("this boat has no sails to order")
            raise ValueError(f"sails must be one of {self.sail_plans} (or None: the boat decides)")
        if engine is not None:
            if not isinstance(engine, bool):
                raise ValueError("engine must be True, False or None (the boat decides)")
            if not self.has_engine:
                raise ValueError("this boat has no engine to order")
        if isinstance(heading, str):
            if heading not in HEADING_MODES:
                raise ValueError(f"heading must be degrees or one of {HEADING_MODES}")
        else:
            heading = float(heading) % 360.0
        if not 0.0 <= power <= 1.0:
            raise ValueError("power is a fraction of full drive power, 0 to 1")
        self.heading, self.power = heading, float(power)
        self.sails, self.engine = sails, engine

    def on_message_received(self, t: datetime) -> None:
        self._rules.on_message_received(t)

    def update(self, sensors: Sensors, mission: Mission, t: datetime) -> Command:
        if mission is not self._mission_seen:
            # An order delivered by satellite: follow its route at its power.
            self._mission_seen = mission
            if isinstance(mission, OrderMission):
                self.set_order("route", mission.power, mission.sails, mission.engine)
        # Keep the waypoint follower's crab estimate current even when it isn't
        # steering, so switching to "route" mid-voyage starts from a good guess.
        self.guidance.hold_crab = self.last is not None and self.last.thrust_fraction <= 0.0
        follow = self.guidance.update(sensors, mission, t)
        if self.heading == "route":
            heading = follow.heading
            wp = mission.waypoints[mission.active_index]
            mark = (wp.lat, wp.lon)
        elif self.heading == "finish":
            heading = bearing_deg(sensors.lat, sensors.lon, *self.finish)
            mark = self.finish
        else:
            heading, mark = self.heading, None
        tacking = False
        if (
            self.tactician is not None
            and mark is not None
            and sensors.gps_ok
            and sensors.wind_from_deg is not None
            and sensors.wind_speed_ms is not None
        ):
            to_mark = bearing_deg(sensors.lat, sensors.lon, *mark)
            lat, lon = sensors.lat, sensors.lon
            heading = self.tactician.heading(
                to_mark,
                heading,
                sensors.wind_from_deg,
                sensors.wind_speed_ms,
                sensors.heading,
                t,
                open_water=lambda h: open_water_km(lat, lon, h),
            )
            tacking = self.tactician.mode != "reach"
        self.guidance.tacking = tacking
        frac = self.power
        if self.safe:
            frac = min(
                1.0,
                frac
                * self._rules.throttle_scale(sensors.soc)
                * self._rules.thruster_scale(sensors),
            )
        self.last = Command(
            heading=heading, thrust_fraction=frac, sail_plan=self.sails, engine=self.engine
        )
        return self.last
