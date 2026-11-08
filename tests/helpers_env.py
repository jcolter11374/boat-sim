"""Scripted weather for vessel tests (not real data)."""

from __future__ import annotations

import math
from dataclasses import replace
from datetime import datetime

from boatsim.types import EnvState


class DiurnalEnvironment:
    """Fixed weather, with sunlight following a clear-sky-like half-sine from
    06:00 to 18:00 local solar time, scaled to a daily total in kWh/m^2."""

    def __init__(self, base: EnvState, daily_kwh_m2: float):
        self.base = base
        self.peak = daily_kwh_m2 * 1000.0 * math.pi / 24.0

    def ghi(self, t: datetime, lon: float) -> float:
        h = (t.hour + t.minute / 60.0 + lon / 15.0) % 24.0
        if 6.0 < h < 18.0:
            return self.peak * math.sin(math.pi * (h - 6.0) / 12.0)
        return 0.0

    def sample(self, t: datetime, lat: float, lon: float) -> EnvState:
        return replace(self.base, ghi=self.ghi(t, lon))
