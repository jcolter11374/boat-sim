from __future__ import annotations

from datetime import datetime
from typing import Protocol

from boatsim.geo import bearing_deg, distance_m
from boatsim.types import Command, Mission, Sensors


class Autopilot(Protocol):
    def update(self, sensors: Sensors, mission: Mission, t: datetime) -> Command: ...


class WaypointAutopilot:
    """Stub: steer straight at the active waypoint, full thrust, advance when close.

    No safe mode, no battery management, no cross-track control. Sam replaces this
    with a copy of ArduPilot Rover's waypoint logic and the safe-mode rules.
    """

    def __init__(self, acceptance_radius_m: float = 5_000.0, thrust_fraction: float = 1.0):
        self.acceptance_radius_m = acceptance_radius_m
        self.thrust_fraction = thrust_fraction

    def update(self, sensors: Sensors, mission: Mission, t: datetime) -> Command:
        wps = mission.waypoints
        while mission.active_index < len(wps) - 1:
            wp = wps[mission.active_index]
            if distance_m(sensors.lat, sensors.lon, wp.lat, wp.lon) > self.acceptance_radius_m:
                break
            mission.active_index += 1
        wp = wps[mission.active_index]
        heading = bearing_deg(sensors.lat, sensors.lon, wp.lat, wp.lon)
        return Command(heading=heading, thrust_fraction=self.thrust_fraction)
