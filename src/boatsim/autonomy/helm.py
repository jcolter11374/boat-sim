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

Power is a fraction of the motors' full drive power (0 to 1).

Safe mode is off by default, so the battery is the player's to manage. The
hardware still cuts out at empty (the vessel model turns the electronics off
and back on as the sun recharges it). With ``safe=True`` the STM32 rules from
safemode.py apply on top of the order: throttle back on low charge, stop and
recharge below 15%, and give a lone surviving thruster the whole drive power.

Owner: Sam.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from boatsim.autonomy.guidance import WaypointAutopilot
from boatsim.autonomy.safemode import SafeModeAutopilot
from boatsim.autonomy.sailing import Tactician
from boatsim.geo import bearing_deg
from boatsim.types import Command, Mission, Sensors

HEADING_MODES = ("finish", "route")


@dataclass
class OrderMission(Mission):
    """A route from base that also sets the motor power ("Real base station"
    mode). On the real boat this is the normal route uplink plus one byte of
    power; the boat follows the waypoints and runs the motors at `power`."""

    power: float = 0.0


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
    ):
        self.finish = finish
        self.safe = safe
        self.tactician = tactician
        self.guidance = WaypointAutopilot()
        self._rules = SafeModeAutopilot(
            cruise_fraction=1.0, guidance=self.guidance, thruster_count=thruster_count
        )
        self.heading: float | str = "route"
        self.power = 0.0
        self.set_order(heading, power)
        self.last: Command | None = None
        self._mission_seen: Mission | None = None

    def set_order(self, heading: float | str, power: float) -> None:
        if isinstance(heading, str):
            if heading not in HEADING_MODES:
                raise ValueError(f"heading must be degrees or one of {HEADING_MODES}")
        else:
            heading = float(heading) % 360.0
        if not 0.0 <= power <= 1.0:
            raise ValueError("power is a fraction of full drive power, 0 to 1")
        self.heading, self.power = heading, float(power)

    def on_message_received(self, t: datetime) -> None:
        self._rules.on_message_received(t)

    def update(self, sensors: Sensors, mission: Mission, t: datetime) -> Command:
        if mission is not self._mission_seen:
            # An order delivered by satellite: follow its route at its power.
            self._mission_seen = mission
            if isinstance(mission, OrderMission):
                self.set_order("route", mission.power)
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
            heading = self.tactician.heading(
                to_mark, heading, sensors.wind_from_deg, sensors.wind_speed_ms, sensors.heading, t
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
        self.last = Command(heading=heading, thrust_fraction=frac)
        return self.last
