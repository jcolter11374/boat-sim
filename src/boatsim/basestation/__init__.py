"""Base-station policy: reads boat reports and the forecast, sends new routes.
Owner: Sam (thread 3)."""

from boatsim.basestation.base import BasePolicy, HoldCoursePolicy

__all__ = ["BasePolicy", "HoldCoursePolicy"]
