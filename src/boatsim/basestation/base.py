from __future__ import annotations

from typing import Protocol

from boatsim.oceandata.base import Environment
from boatsim.types import Mission


class BasePolicy(Protocol):
    def on_report(self, report: dict, forecast: Environment) -> Mission | None:
        """Return a new mission to uplink, or None to leave the boat alone."""
        ...


class HoldCoursePolicy:
    """Stub: never sends corrections."""

    def on_report(self, report, forecast):
        return None
