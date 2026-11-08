"""Fast point sampling of gridded fields (pure NumPy, no xarray needed).

The runner asks for the weather at one point every 10 simulated minutes, so
this has to be cheap: no xarray calls per sample, just index arithmetic on
arrays that are already in memory.

Interpolation is bilinear in space and linear in time. Grid points that are
NaN (land, sea ice, or no data) are skipped and the remaining weights are
renormalised, so a boat near the coast still gets a sensible value from the
sea-side grid points. If every surrounding point is NaN, the result is NaN and
the caller decides what that means.
"""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Callable, Hashable, Iterable
from dataclasses import dataclass
from datetime import datetime

import numpy as np


class OutsideCoverage(ValueError):
    """The requested point or time is outside the data we have."""


@dataclass(frozen=True)
class Box:
    """A lat/lon box. Longitudes are -180..180 and the box must not cross 180."""

    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float

    def contains(self, lat: float, lon: float) -> bool:
        return self.lat_min <= lat <= self.lat_max and self.lon_min <= lon <= self.lon_max


# The route box from the plan: Bay mouth to Ireland, Portugal and the Azores.
ROUTE_BOX = Box(lat_min=25.0, lat_max=60.0, lon_min=-82.0, lon_max=5.0)


def to_datetime64(t: datetime | np.datetime64) -> np.datetime64:
    """Naive UTC datetime (the simulator's convention) to datetime64[s]."""
    if isinstance(t, np.datetime64):
        return t.astype("datetime64[s]")
    if t.tzinfo is not None:
        t = t.replace(tzinfo=None) - (t.utcoffset() or 0)
    return np.datetime64(t, "s")


class GridSeries:
    """A stack of 2-D fields on one regular lat/lon grid over a span of time.

    times: sorted datetime64 array, shape (nt,)
    lats, lons: strictly ascending 1-D arrays (degrees; lons -180..180)
    fields: name -> array of shape (nt, nlat, nlon)
    """

    def __init__(
        self,
        times: np.ndarray,
        lats: np.ndarray,
        lons: np.ndarray,
        fields: dict[str, np.ndarray],
    ):
        self.times = np.asarray(times).astype("datetime64[s]")
        self.lats = np.asarray(lats, dtype=np.float64)
        self.lons = np.asarray(lons, dtype=np.float64)
        if np.any(np.diff(self.lats) <= 0) or np.any(np.diff(self.lons) <= 0):
            raise ValueError("lats and lons must be strictly ascending")
        if np.any(np.diff(self.times.astype(np.int64)) <= 0):
            raise ValueError("times must be strictly ascending")
        shape = (len(self.times), len(self.lats), len(self.lons))
        for name, arr in fields.items():
            if arr.shape != shape:
                raise ValueError(f"field {name} has shape {arr.shape}, expected {shape}")
        self.fields = fields
        self._t_sec = self.times.astype(np.int64)

    @property
    def t_start(self) -> np.datetime64:
        return self.times[0]

    @property
    def t_end(self) -> np.datetime64:
        return self.times[-1]

    def _time_weights(self, t: np.datetime64) -> tuple[int, float]:
        ts = int(t.astype("datetime64[s]").astype(np.int64))
        if ts < self._t_sec[0] or ts > self._t_sec[-1]:
            raise OutsideCoverage(f"time {t} is outside {self.times[0]}..{self.times[-1]}")
        k = int(np.searchsorted(self._t_sec, ts, side="right")) - 1
        k = min(k, len(self._t_sec) - 2) if len(self._t_sec) > 1 else 0
        if len(self._t_sec) == 1:
            return 0, 0.0
        span = self._t_sec[k + 1] - self._t_sec[k]
        return k, (ts - self._t_sec[k]) / span

    @staticmethod
    def _axis_weights(axis: np.ndarray, x: float, what: str) -> tuple[int, float]:
        if x < axis[0] or x > axis[-1]:
            raise OutsideCoverage(f"{what} {x} is outside {axis[0]}..{axis[-1]}")
        i = int(np.searchsorted(axis, x, side="right")) - 1
        i = min(i, len(axis) - 2)
        return i, (x - axis[i]) / (axis[i + 1] - axis[i])

    def sample(
        self, t: datetime | np.datetime64, lat: float, lon: float, names: Iterable[str]
    ) -> dict[str, float]:
        """Interpolated values of the named fields at one point and time."""
        k, wt = self._time_weights(to_datetime64(t))
        i, wy = self._axis_weights(self.lats, lat, "latitude")
        j, wx = self._axis_weights(self.lons, lon, "longitude")
        # 2 times x 2 lats x 2 lons = 8 corner weights
        w_space = np.array([(1 - wy) * (1 - wx), (1 - wy) * wx, wy * (1 - wx), wy * wx])
        w = np.concatenate([w_space * (1 - wt), w_space * wt])
        k1 = min(k + 1, len(self.times) - 1)
        out = {}
        for name in names:
            a = self.fields[name]
            v = np.array(
                [
                    a[k, i, j],
                    a[k, i, j + 1],
                    a[k, i + 1, j],
                    a[k, i + 1, j + 1],
                    a[k1, i, j],
                    a[k1, i, j + 1],
                    a[k1, i + 1, j],
                    a[k1, i + 1, j + 1],
                ],
                dtype=np.float64,
            )
            ok = np.isfinite(v)
            wsum = w[ok].sum()
            out[name] = float(np.dot(w[ok], v[ok]) / wsum) if wsum > 1e-12 else float("nan")
        return out


class TileCache:
    """Keep the few most recently used tiles (e.g. days) in memory.

    A voyage walks forward in time, so a handful of tiles is enough and memory
    stays flat no matter how long the voyage is.
    """

    def __init__(self, load: Callable[[Hashable], GridSeries], max_tiles: int = 3):
        self._load = load
        self._max = max_tiles
        self._tiles: OrderedDict[Hashable, GridSeries] = OrderedDict()

    def get(self, key: Hashable) -> GridSeries:
        if key in self._tiles:
            self._tiles.move_to_end(key)
            return self._tiles[key]
        tile = self._load(key)
        self._tiles[key] = tile
        while len(self._tiles) > self._max:
            self._tiles.popitem(last=False)
        return tile
