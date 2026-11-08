"""Onboard autopilot (Python copy of ArduPilot Rover guidance + STM32 safe-mode
rules). Owner: Sam (thread 3)."""

from boatsim.autonomy.base import Autopilot, WaypointAutopilot

__all__ = ["Autopilot", "WaypointAutopilot"]
