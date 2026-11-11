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

from bisect import bisect_right
from collections import OrderedDict
from collections.abc import Callable, Hashable, Iterable
from dataclasses import dataclass
from datetime import datetime

import numpy as np

_SEC = np.dtype("datetime64[s]")


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
        # All fields in one block when they share a dtype, so one lookup reads
        # the 8 corners of every field; self.fields then holds views into it.
        self._stack = None
        self._row: dict[str, int] = {}
        if fields and len({a.dtype for a in fields.values()}) == 1:
            self._stack = np.stack(list(fields.values()))
            self._row = {n: r for r, n in enumerate(fields)}
            fields = {n: self._stack[r] for n, r in self._row.items()}
        self.fields = fields
        self._t_sec = self.times.astype(np.int64)
        # Plain Python copies for the per-sample lookups: bisect on a list is the
        # same search as np.searchsorted(side="right") and far cheaper for one
        # value; the weights come out of the same IEEE double arithmetic.
        self._t_list = self._t_sec.tolist()
        self._lat_list = self.lats.tolist()
        self._lon_list = self.lons.tolist()

    @property
    def t_start(self) -> np.datetime64:
        return self.times[0]

    @property
    def t_end(self) -> np.datetime64:
        return self.times[-1]

    def _time_weights(self, t: np.datetime64) -> tuple[int, float]:
        ts = (
            int(t.astype("datetime64[s]").astype(np.int64))
            if t.dtype != _SEC
            else int(t.astype(np.int64))
        )
        tl = self._t_list
        if ts < tl[0] or ts > tl[-1]:
            raise OutsideCoverage(f"time {t} is outside {self.times[0]}..{self.times[-1]}")
        if len(tl) == 1:
            return 0, 0.0
        k = min(bisect_right(tl, ts) - 1, len(tl) - 2)
        # int / int is correctly rounded, as numpy's int64 / int64 (both below 2^53)
        return k, (ts - tl[k]) / (tl[k + 1] - tl[k])

    @staticmethod
    def _axis_weights(axis: list[float], x: float, what: str) -> tuple[int, float]:
        if x < axis[0] or x > axis[-1]:
            raise OutsideCoverage(f"{what} {x} is outside {axis[0]}..{axis[-1]}")
        i = min(bisect_right(axis, x) - 1, len(axis) - 2)
        return i, (x - axis[i]) / (axis[i + 1] - axis[i])

    def sample(
        self, t: datetime | np.datetime64, lat: float, lon: float, names: Iterable[str]
    ) -> dict[str, float]:
        """Interpolated values of the named fields at one point and time."""
        k, wt = self._time_weights(to_datetime64(t))
        i, wy = self._axis_weights(self._lat_list, lat, "latitude")
        j, wx = self._axis_weights(self._lon_list, lon, "longitude")
        # 2 times x 2 lats x 2 lons = 8 corner weights (each product rounds as
        # numpy's elementwise one would)
        ws = ((1 - wy) * (1 - wx), (1 - wy) * wx, wy * (1 - wx), wy * wx)
        a, b = 1 - wt, wt
        w = np.array(
            [ws[0] * a, ws[1] * a, ws[2] * a, ws[3] * a, ws[0] * b, ws[1] * b, ws[2] * b, ws[3] * b]
        )
        names = list(names)
        wall = None  # w.sum(), once, for corners that are all finite
        k1 = min(k + 1, len(self._t_list) - 1)
        kk = (k, k, k, k, k1, k1, k1, k1)
        ii = (i, i, i + 1, i + 1, i, i, i + 1, i + 1)
        jj = (j, j + 1, j, j + 1, j, j + 1, j, j + 1)
        out = {}
        if self._stack is not None:
            rows = [self._row[n] for n in names]
            # order="C": each field's 8 corners contiguous, as the per-field
            # arrays were. np.dot on a strided row can add in another order.
            vs = self._stack[:, kk, ii, jj].astype(np.float64, order="C")
            if np.isfinite(vs if len(rows) == len(vs) else vs[rows]).all():
                wsum = w.sum()
                for name, r in zip(names, rows, strict=True):
                    # the same numbers as the masked form below, all corners finite
                    out[name] = float(np.dot(w, vs[r]) / wsum) if wsum > 1e-12 else float("nan")
                return out
        for name in names:
            v = self.fields[name][kk, ii, jj].astype(np.float64)
            ok = np.isfinite(v)
            if ok.all():
                # same numbers as the masked form below: w[ok] is w, v[ok] is v
                if wall is None:
                    wall = w.sum()
                wsum = wall
                out[name] = float(np.dot(w, v) / wsum) if wsum > 1e-12 else float("nan")
                continue
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
