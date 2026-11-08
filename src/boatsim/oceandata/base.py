from __future__ import annotations

from datetime import datetime
from typing import Protocol

from boatsim.types import EnvState


class Environment(Protocol):
    """The true weather and ocean, as it actually happened."""

    def sample(self, t: datetime, lat: float, lon: float) -> EnvState: ...


class Forecast(Protocol):
    """What the base station can see: the truth plus error that grows with lead time.

    The base station must never get the true Environment directly.
    """

    def issue(self, t_issue: datetime) -> Environment:
        """Return a forecast issued at t_issue, sampled like an Environment."""
        ...


class ConstantEnvironment:
    """Stub: the same conditions everywhere, always. For tests and M0."""

    def __init__(self, state: EnvState | None = None):
        self.state = state or EnvState(ghi=250.0)

    def sample(self, t: datetime, lat: float, lon: float) -> EnvState:
        return self.state


class PerfectForecast:
    """Stub: a forecast that is exactly the truth. Replace before trusting any
    result about the value of course corrections."""

    def __init__(self, env: Environment):
        self.env = env

    def issue(self, t_issue: datetime) -> Environment:
        return self.env
