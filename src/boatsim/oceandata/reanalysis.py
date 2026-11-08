"""The real Environment: past weather and ocean as it actually happened.

Combines ERA5 (wind, waves, sunlight, cloud, air temperature) with GLORYS12
(surface currents). Both are fetched on demand for the days a voyage uses and
cached under data/.
"""

from __future__ import annotations

import math
import warnings
from datetime import datetime

from boatsim.oceandata.era5 import ERA5Source
from boatsim.oceandata.glorys import GlorysSource
from boatsim.types import EnvState


def _or0(x: float) -> float:
    return x if math.isfinite(x) else 0.0


class ReanalysisEnvironment:
    """Environment.sample(t, lat, lon) from ERA5 + GLORYS12.

    currents=None runs with zero current and warns once. That is only for
    trying things out before the Copernicus login exists: without currents the
    Gulf Stream is missing and results are not trustworthy.

    Missing values: waves and currents are NaN on land. Near the coast we use
    the sea-side grid points; if there are none (the boat is on land, which the
    runner should have caught) the value is reported as 0.
    """

    def __init__(self, era5: ERA5Source | None = None, currents: GlorysSource | None = None):
        self.era5 = era5 or ERA5Source()
        self.currents = currents
        self._warned = False

    def sample(self, t: datetime, lat: float, lon: float) -> EnvState:
        w = self.era5.sample(t, lat, lon)
        if self.currents is not None:
            c = self.currents.sample(t, lat, lon)
        else:
            if not self._warned:
                warnings.warn("ReanalysisEnvironment has no currents: using 0 m/s", stacklevel=2)
                self._warned = True
            c = {"current_u": 0.0, "current_v": 0.0}
        return EnvState(
            wind_u=_or0(w["wind_u"]),
            wind_v=_or0(w["wind_v"]),
            current_u=_or0(c["current_u"]),
            current_v=_or0(c["current_v"]),
            hs=_or0(w["hs"]),
            tp=_or0(w["tp"]),
            wave_dir=_or0(w["wave_dir"]),
            ghi=max(_or0(w["ghi"]), 0.0),
            cloud_fraction=min(max(_or0(w["cloud_fraction"]), 0.0), 1.0),
            air_temp=w["air_temp"] if math.isfinite(w["air_temp"]) else 15.0,
            ship_density=0.0,  # issue #13
        )
