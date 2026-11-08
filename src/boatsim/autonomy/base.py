from __future__ import annotations

from datetime import datetime
from typing import Protocol

from boatsim.types import Command, Mission, Sensors


class Autopilot(Protocol):
    def update(self, sensors: Sensors, mission: Mission, t: datetime) -> Command: ...
