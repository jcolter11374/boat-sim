"""Forcing bundle for the in-browser sandbox: one launch season of weather,
currents and ship traffic, thinned to the route corridor and packed in one
compressed .npz the browser downloads once.

What is in it, and what that changes against the full-resolution runs:

* ERA5 wind, waves and cloud at 1 deg every 6 h (full runs: 0.25 deg hourly);
  air temperature daily.
* ERA5 rain at 1 deg but HOURLY, as the full runs read it: showers last an
  hour or two, and the stock dinghy and beach cat capsize in squalls (gusts
  grow with the rain rate; vessel/keelboat.py). Mostly zeros, so it packs
  small. Bundles cut before rain was added read as dry.
* Sunlight as a daily clearness index (the day's ERA5 sunlight over a clear-sky
  model's) times that clear-sky model at the boat's time and place. Hourly
  sunlight at sea would be far too big to ship.
* GLORYS12 surface current at 0.25 deg, daily (full runs: 1/12 deg); the Gulf
  Stream is about 100 km wide, so this is as coarse as it can go.
* The ship-density map, as in the full runs.

So sandbox results are "sandbox, 2020 weather", not the headline odds: close,
but not the same voyages. Every value is stored as int16 with its scale, split
into its low and high bytes (two planes: the high bytes barely change, so they
compress well).

Cutting needs the full data (xarray, the ERA5 and GLORYS caches): Actions only.
Reading needs only numpy, so it runs in Pyodide.
"""

from __future__ import annotations

import io
import json
import math
from bisect import bisect_right
from datetime import date, datetime, timedelta
from itertools import pairwise
from pathlib import Path

import numpy as np

from boatsim.oceandata.grid import Box, GridSeries, OutsideCoverage, to_datetime64
from boatsim.types import EnvState

CORRIDOR = Box(lat_min=28.0, lat_max=50.0, lon_min=-78.0, lon_max=-8.0)
ERA5_RES = 1.0  # deg
ERA5_STEP_H = 6
CURRENT_RES = 0.25  # deg
FIRST = (4, 1)  # season: 1 April ...
LAST = (11, 20)  # ... to 20 November (last launch 15 June + 150 days, + forecast look-ahead)
FILL = -32768

# Stored field -> scale (value = int16 * scale)
SCALES = {
    "wind_u": 0.1,
    "wind_v": 0.1,
    "hs": 0.02,
    "tp": 0.1,
    "wave_dir": 1.0,  # deg, "from"; read back as a unit vector so 359 and 1 average to 0
    "cloud_fraction": 0.02,
    "rain": 0.01,  # mm/h, hourly (squalls: the stock dinghy and beach cat read it)
    "air_temp": 0.1,
    "clearness": 0.001,
    "current_u": 0.01,  # 1 cm/s: GLORYS itself is uncertain by ~10 cm/s; 1 mm/s doubled the bundle
    "current_v": 0.01,
    "ship_density": None,  # float32 (spans orders of magnitude)
}


# --- Sun -----------------------------------------------------------------------


def clear_sky(t: np.datetime64 | datetime, lat: float, lon: float) -> float:
    """Clear-sky sunlight on flat ground, W/m^2 (Haurwitz 1945), from a low-order
    solar position (Astronomical Almanac). Good to about a degree, which is all
    a daily clearness index needs."""
    secs = int(np.datetime64(t, "s").astype(np.int64)) - 946728000  # 2000-01-01 12:00 UTC
    n = secs / 86400.0
    g = math.radians((357.529 + 0.98560028 * n) % 360.0)
    q = (280.459 + 0.98564736 * n) % 360.0
    ecl = math.radians((q + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g)) % 360.0)
    obl = math.radians(23.439 - 0.00000036 * n)
    dec = math.asin(math.sin(obl) * math.sin(ecl))
    ra = math.atan2(math.cos(obl) * math.sin(ecl), math.cos(ecl))
    gmst = (18.697374558 + 24.06570982441908 * n) % 24.0
    ha = math.radians(gmst * 15.0 + lon) - ra
    la = math.radians(lat)
    cz = math.sin(la) * math.sin(dec) + math.cos(la) * math.cos(dec) * math.cos(ha)
    return 1098.0 * cz * math.exp(-0.057 / cz) if cz > 0.01 else 0.0


def clear_sky_grid(t: np.datetime64, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """clear_sky on a lat x lon grid at once (for cutting; same formulas)."""
    n = (int(np.datetime64(t, "s").astype(np.int64)) - 946728000) / 86400.0
    g = math.radians((357.529 + 0.98560028 * n) % 360.0)
    q = (280.459 + 0.98564736 * n) % 360.0
    ecl = math.radians((q + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g)) % 360.0)
    obl = math.radians(23.439 - 0.00000036 * n)
    dec = math.asin(math.sin(obl) * math.sin(ecl))
    ra = math.atan2(math.cos(obl) * math.sin(ecl), math.cos(ecl))
    gmst = (18.697374558 + 24.06570982441908 * n) % 24.0
    ha = np.radians(gmst * 15.0 + np.asarray(lons, dtype=np.float64))[None, :] - ra
    la = np.radians(np.asarray(lats, dtype=np.float64))[:, None]
    cz = np.sin(la) * math.sin(dec) + np.cos(la) * math.cos(dec) * np.cos(ha)
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        out = 1098.0 * cz * np.exp(-0.057 / cz)
    return np.where(cz > 0.01, out, 0.0)


# --- Reading (numpy only) --------------------------------------------------------


def _unpack(z, name: str) -> np.ndarray:
    a = z[name]
    if a.dtype != np.uint8:
        return a.astype(np.float32)
    a = np.ascontiguousarray(np.moveaxis(a, 0, -1)).view("<i2")[..., 0]  # unshuffle
    out = a.astype(np.float32) * np.float32(SCALES[name])
    out[a == FILL] = np.nan
    return out


def _wave_vectors(z) -> dict[str, np.ndarray]:
    rad = np.deg2rad(_unpack(z, "wave_dir"))
    return {"_wd_x": np.sin(rad).astype(np.float32), "_wd_y": np.cos(rad).astype(np.float32)}


def _times(z, key: str) -> np.ndarray:
    return z[key].astype("datetime64[s]")


# Each time axis and the stored fields on it. A bundle split by month (split()
# below) keeps the axes whole in its "static" file and these fields in the parts.
AXES = {
    "t_weather": ("wind_u", "wind_v", "hs", "tp", "wave_dir", "cloud_fraction"),
    "t_daily": ("air_temp", "clearness"),
    "t_rain": ("rain",),
    "t_current": ("current_u", "current_v"),
}


class WeatherNotLoaded(Exception):
    """A split bundle was asked for a time whose month hasn't been added yet.
    On purpose not an OutsideCoverage or a ValueError: code that shortens a
    forecast at the end of the weather must never take a missing month for the
    end. The page fetches the part named here and asks again."""

    def __init__(self, part: str):
        super().__init__(f"WEATHER_PART {part}")
        self.part = part


class PartSeries:
    """A GridSeries whose values arrive a part at a time (a bundle split by
    month). The whole time axis is known from the start; each part holds its
    own steps and the first step of the next part, so every sample has both of
    its bracketing steps in one part and comes out exactly as from the whole
    series: the same steps, the same weights, the same arithmetic."""

    def __init__(self, times, lats, lons, names, keys, starts):
        self.times = np.asarray(times).astype("datetime64[s]")
        self.lats = np.asarray(lats, dtype=np.float64)
        self.lons = np.asarray(lons, dtype=np.float64)
        self.fields = dict.fromkeys(names)  # the names, as GridSeries.fields has them
        self._t = self.times.astype(np.int64).tolist()
        self._keys = list(keys)
        self._starts = [int(i) for i in starts]  # each part's first step on the axis
        self._first = [self._t[i] for i in self._starts]
        self._parts: dict[int, GridSeries] = {}

    def add(self, n: int, fields: dict[str, np.ndarray]) -> None:
        i0 = self._starts[n]
        i1 = self._starts[n + 1] if n + 1 < len(self._starts) else len(self._t) - 1
        nt = len(next(iter(fields.values())))
        if nt != i1 - i0 + 1:
            raise ValueError(f"part {self._keys[n]} has {nt} steps, expected {i1 - i0 + 1}")
        self._parts[n] = GridSeries(self.times[i0 : i1 + 1], self.lats, self.lons, fields)

    def sample(self, t, lat: float, lon: float, names) -> dict[str, float]:
        t64 = to_datetime64(t)
        ts = int(t64.astype(np.int64))
        if ts < self._t[0] or ts > self._t[-1]:
            raise OutsideCoverage(f"time {t64} is outside {self.times[0]}..{self.times[-1]}")
        # The last part that starts at or before t: a time on a boundary is read
        # from the part it opens, as the whole series reads it (weight 0 on the
        # step after).
        n = bisect_right(self._first, ts) - 1
        g = self._parts.get(n)
        if g is None:
            raise WeatherNotLoaded(self._keys[n])
        return g.sample(t64, lat, lon, names)


def _source(source):
    if isinstance(source, (bytes, bytearray, memoryview)):
        return io.BytesIO(bytes(source))
    return source


def _weather_fields(z) -> dict[str, np.ndarray]:
    return {
        **{k: _unpack(z, k) for k in ("wind_u", "wind_v", "hs", "tp", "cloud_fraction")},
        **_wave_vectors(z),
    }


class BundleEnvironment:
    """Environment.sample(t, lat, lon) from a forcing bundle (path or bytes).

    A whole bundle is ready at once. The static file of a split bundle
    (split()) gives an environment that knows the season but holds no weather
    yet: add_part() each month as it arrives; sampling a month that isn't there
    raises WeatherNotLoaded. The values are the whole bundle's, bit for bit."""

    def __init__(self, source):
        self.parts: list[str] = []  # a split bundle's part names, in time order
        self.loaded: set[str] = set()
        with np.load(_source(source)) as z:
            lat, lon = z["lat"], z["lon"]
            self.meta = {k[5:]: z[k].item() for k in z.files if k.startswith("meta_")}
            if "parts_keys" in z.files:
                self.parts = [str(k) for k in z["parts_keys"]]

                def series(axis, la, lo, names):
                    starts = z["parts_" + axis].tolist()
                    return PartSeries(_times(z, axis), la, lo, names, self.parts, starts)

                self.weather = series(
                    "t_weather",
                    lat,
                    lon,
                    ("wind_u", "wind_v", "hs", "tp", "cloud_fraction", "_wd_x", "_wd_y"),
                )
                self.daily = series("t_daily", lat, lon, ("air_temp", "clearness"))
                self.rain = series("t_rain", lat, lon, ("rain",)) if "t_rain" in z.files else None
                self.currents = None
                if "t_current" in z.files:
                    self.currents = series(
                        "t_current", z["lat_current"], z["lon_current"], ("current_u", "current_v")
                    )
            else:
                self.weather = GridSeries(_times(z, "t_weather"), lat, lon, _weather_fields(z))
                self.daily = GridSeries(
                    _times(z, "t_daily"),
                    lat,
                    lon,
                    {k: _unpack(z, k) for k in ("air_temp", "clearness")},
                )
                self.rain = None
                if "rain" in z.files:
                    self.rain = GridSeries(
                        _times(z, "t_rain"), lat, lon, {"rain": _unpack(z, "rain")}
                    )
                self.currents = None
                if "current_u" in z.files:
                    self.currents = GridSeries(
                        _times(z, "t_current"),
                        z["lat_current"],
                        z["lon_current"],
                        {k: _unpack(z, k) for k in ("current_u", "current_v")},
                    )
            self.storms = None  # best-track fixes, if the bundle carries them
            if "storm_t" in z.files:
                from boatsim.oceandata.stormboost import storms_from_arrays

                self.storms = storms_from_arrays(z)
            self.ships = None
            if "ship_density" in z.files:
                self.ships = GridSeries(
                    np.array(["2000-01-01"], dtype="datetime64[s]"),
                    z["lat_ships"],
                    z["lon_ships"],
                    {"ship_density": _unpack(z, "ship_density")[None]},
                )

    def add_part(self, key: str, source) -> None:
        """One month of a split bundle (path or bytes). Adding it again does nothing."""
        if key in self.loaded:
            return
        n = self.parts.index(key)
        with np.load(_source(source)) as z:
            self.weather.add(n, _weather_fields(z))
            self.daily.add(n, {k: _unpack(z, k) for k in ("air_temp", "clearness")})
            if self.rain is not None:
                self.rain.add(n, {"rain": _unpack(z, "rain")})
            if self.currents is not None:
                self.currents.add(n, {k: _unpack(z, k) for k in ("current_u", "current_v")})
        self.loaded.add(key)

    def missing(self, t0: datetime, t1: datetime) -> list[str]:
        """The parts of a split bundle that sampling anywhere from t0 to t1 could
        read and that aren't here yet (a whole bundle: none). A day is added at
        each end: the daily values are stamped at noon and the rain half an hour
        on, so a time early on the 1st still reads the month before."""
        a = (t0 - timedelta(days=1)).strftime("%Y-%m")
        b = (t1 + timedelta(days=1)).strftime("%Y-%m")
        return [k for k in self.parts if a <= k <= b and k not in self.loaded]

    def require(self, t0: datetime, t1: datetime) -> None:
        """Raise WeatherNotLoaded for the first part missing(t0, t1) names."""
        need = self.missing(t0, t1)
        if need:
            raise WeatherNotLoaded(need[0])

    def sample(self, t: datetime, lat: float, lon: float) -> EnvState:
        t64 = np.datetime64(t, "s")
        w = self.weather.sample(t64, lat, lon, list(self.weather.fields))
        d = self.daily.sample(_clamp(self.daily, t64), lat, lon, ["air_temp", "clearness"])
        wd = math.degrees(math.atan2(w["_wd_x"], w["_wd_y"])) % 360.0 if _ok(w["_wd_x"]) else 0.0
        cu = cv = 0.0
        if self.currents is not None:
            c = self.currents.sample(
                _clamp(self.currents, t64), lat, lon, ["current_u", "current_v"]
            )
            cu, cv = _or0(c["current_u"]), _or0(c["current_v"])
        rain = 0.0
        if self.rain is not None:
            # Hourly totals stamped at the hour's end: sample half an hour on, as
            # ERA5Source does, so each hour's rain falls in that hour.
            tr = _clamp(self.rain, t64 + np.timedelta64(30, "m"))
            rain = max(_or0(self.rain.sample(tr, lat, lon, ["rain"])["rain"]), 0.0)
        ships = 0.0
        if self.ships is not None:
            g = self.ships
            la = min(max(lat, g.lats[0]), g.lats[-1])
            lo = min(max(lon, g.lons[0]), g.lons[-1])
            ships = _or0(g.sample(g.times[0], la, lo, ["ship_density"])["ship_density"])
        temp = d["air_temp"]
        return EnvState(
            wind_u=_or0(w["wind_u"]),
            wind_v=_or0(w["wind_v"]),
            current_u=cu,
            current_v=cv,
            hs=_or0(w["hs"]),
            tp=_or0(w["tp"]),
            wave_dir=wd,
            ghi=clear_sky(t64, lat, lon) * max(_or0(d["clearness"]), 0.0),
            cloud_fraction=min(max(_or0(w["cloud_fraction"]), 0.0), 1.0),
            air_temp=temp if _ok(temp) else 15.0,
            ship_density=ships,
            rain=rain,
        )


def _ok(x: float) -> bool:
    return math.isfinite(x)


def _or0(x: float) -> float:
    return x if math.isfinite(x) else 0.0


def _clamp(g: GridSeries, t64: np.datetime64) -> np.datetime64:
    """Daily series are stamped at noon: hold the first/last day's value at the ends."""
    return min(max(t64, g.times[0]), g.times[-1])


# --- Cutting (Actions: needs the full ERA5/GLORYS caches) ---------------------------


def _q(a: np.ndarray, name: str) -> np.ndarray:
    s = SCALES[name]
    out = np.round(np.asarray(a, dtype=np.float64) / s)
    out = np.where(np.isfinite(out), np.clip(out, -32767, 32767), FILL).astype("<i2")
    return np.ascontiguousarray(np.moveaxis(out.view(np.uint8).reshape(*out.shape, 2), -1, 0))


RAIN_TRACE = 0.05  # mm/h: ERA5 drizzle under this is stored as dry (packs smaller)


def _dry_trace(r: np.ndarray) -> np.ndarray:
    """Negative rounding noise and trace drizzle -> 0 (NaN stays: no data). At
    0.05 mm/h the squall gust term adds 0.0015 to the gust spread: nothing."""
    return np.where(r < RAIN_TRACE, 0.0, r)


def _idx(axis: np.ndarray, lo: float, hi: float, res: float) -> np.ndarray:
    step = max(1, round(res / float(axis[1] - axis[0])))
    i = np.where((axis >= lo - 1e-6) & (axis <= hi + 1e-6))[0]
    return i[::step]


def cut(
    year: int,
    out,
    era5=None,
    glorys=None,
    ships=None,
    log=print,
    first=FIRST,
    last=LAST,
    start: date | None = None,
    end: date | None = None,
    storms_csv=None,
) -> dict:
    """Cut one season's bundle from the cached full data and save it to `out`
    (path or file). glorys=False / ships=False leave currents / ships out.
    start/end (dates) replace the season for any other window, e.g. a weather
    challenge that runs into the next year.
    storms_csv: an IBTrACS CSV; if given, the best-track fixes of storms in the
    window go into the bundle (oceandata/stormboost.py), so the page can put
    hurricane cores back into the 1 degree weather at sample time.
    Returns the stored arrays' sizes in bytes."""
    from boatsim.oceandata import ERA5Source, GlorysSource
    from boatsim.oceandata.traffic import default_source

    era5 = era5 or ERA5Source(fetch=False, max_tiles=2)
    if glorys is None:
        glorys = GlorysSource(fetch=False)
    if ships is None:
        ships = default_source()
    box = CORRIDOR
    d0, d1 = start or date(year, *first), end or date(year, *last)
    days = [d0 + timedelta(days=i) for i in range((d1 - d0).days + 1)]

    weather = {k: [] for k in ("wind_u", "wind_v", "hs", "tp", "wave_dir", "cloud_fraction")}
    daily = {"air_temp": [], "clearness": []}
    rain, t_rain = [], []
    t_weather, t_daily = [], []
    li = lj = lat = lon = None
    for day in days:
        tile = era5._tiles.get(day)
        if li is None:
            li = _idx(tile.lats, box.lat_min, box.lat_max, ERA5_RES)
            lj = _idx(tile.lons, box.lon_min, box.lon_max, ERA5_RES)
            lat, lon = tile.lats[li], tile.lons[lj]
        f = tile.fields
        hours = (tile.times - np.datetime64(day)).astype("timedelta64[h]").astype(int)
        for h in range(0, 24, ERA5_STEP_H):
            k = int(np.where(hours == h)[0][0])
            t_weather.append(tile.times[k])
            for name, series in weather.items():
                series.append(f[name][k][np.ix_(li, lj)])
        # Daily: mean temperature, and clearness = sum of hourly sunlight over the
        # sum of clear-sky sunlight at the same instants (each ERA5 value is the
        # mean over the hour ending at its stamp: evaluate clear sky at hh-0:30).
        in_day = [int(k) for k in np.where((hours >= 1) & (hours <= 24))[0]]
        # Rain: each stamp is the total over the hour ending there (mm/h); the
        # day's stamps 1-24 joined end to end give the unbroken hourly series.
        for k in in_day:
            t_rain.append(tile.times[k])
            rain.append(
                f["rain"][k][np.ix_(li, lj)] if "rain" in f else np.full((len(li), len(lj)), np.nan)
            )
        temp = np.nanmean(np.stack([f["air_temp"][k][np.ix_(li, lj)] for k in in_day]), axis=0)
        ghi = np.nansum(np.stack([f["ghi"][k][np.ix_(li, lj)] for k in in_day]), axis=0)
        cs = np.zeros_like(ghi, dtype=np.float64)
        for k in in_day:
            tk = tile.times[k] - np.timedelta64(30, "m")
            cs += clear_sky_grid(tk, lat, lon)
        daily["air_temp"].append(temp)
        daily["clearness"].append(np.clip(ghi / np.maximum(cs, 1e-6), 0.0, 1.5))
        t_daily.append(np.datetime64(day) + np.timedelta64(12, "h"))

    arrays = {
        "lat": lat,
        "lon": lon,
        "t_weather": np.array(t_weather, dtype="datetime64[s]").astype(np.int64),
        "t_daily": np.array(t_daily, dtype="datetime64[s]").astype(np.int64),
        **{k: _q(np.stack(v), k) for k, v in weather.items()},
        **{k: _q(np.stack(v), k) for k, v in daily.items()},
        "t_rain": np.array(t_rain, dtype="datetime64[s]").astype(np.int64),
        "rain": _q(_dry_trace(np.stack(rain)), "rain"),
    }
    log(f"weather {arrays['wind_u'].shape}, daily {arrays['air_temp'].shape}")

    if glorys is not False:
        cu, cv, tc = [], [], []
        ci = cj = None
        for day in days:
            g = glorys._tiles.get((day.year, day.month))
            if ci is None:
                ci = _idx(g.lats, box.lat_min, box.lat_max, CURRENT_RES)
                cj = _idx(g.lons, box.lon_min, box.lon_max, CURRENT_RES)
                arrays["lat_current"], arrays["lon_current"] = g.lats[ci], g.lons[cj]
            t = np.datetime64(day) + np.timedelta64(12, "h")
            k = int(np.where(g.times == t)[0][0])
            cu.append(g.fields["current_u"][k][np.ix_(ci, cj)])
            cv.append(g.fields["current_v"][k][np.ix_(ci, cj)])
            tc.append(t)
        arrays["t_current"] = np.array(tc, dtype="datetime64[s]").astype(np.int64)
        arrays["current_u"] = _q(np.stack(cu), "current_u")
        arrays["current_v"] = _q(np.stack(cv), "current_v")
        log(f"currents {arrays['current_u'].shape}")
    if ships:
        g = ships._g
        arrays["lat_ships"], arrays["lon_ships"] = g.lats, g.lons
        arrays["ship_density"] = g.fields["ship_density"][0].astype(np.float32)
    if storms_csv is not None:
        from boatsim.oceandata import stormboost as SB

        a = datetime.combine(d0, datetime.min.time())
        b = datetime.combine(d1, datetime.min.time()) + timedelta(days=1)
        storms = SB.storms_in_window(storms_csv, a, b)
        arrays.update(SB.storms_to_arrays(storms))
        log(f"storm tracks: {len(storms)} storms, {len(arrays['storm_t'])} fixes")
    arrays["meta_year"] = np.array(year)
    arrays["meta_first"] = np.array(str(d0))
    arrays["meta_last"] = np.array(str(d1))
    np.savez_compressed(out, **arrays)
    return {k: v.nbytes for k, v in arrays.items()}


# --- Splitting by month (numpy only: the site build does it) ------------------------


def _part_starts(times: np.ndarray, months: list[str]) -> list[int]:
    """Each month's first step on a time axis (the first month starts at 0)."""
    t = times.astype("datetime64[s]")
    out = [0]
    for m in months[1:]:
        out.append(int(np.searchsorted(t, np.datetime64(f"{m}-01T00:00:00", "s"), side="left")))
    return out


def split(source, out_dir, stem: str | None = None) -> dict:
    """Split a whole bundle by calendar month, so the page downloads only the
    months a voyage sails through: `<stem>_static.npz` (grids, the whole time
    axes, ships, storms, the season) and one `<stem>_<YYYY-MM>.npz` per month
    with that month's stored values and the first step of the next month (see
    PartSeries). `<stem>_parts.json` lists them for the page.

    Nothing is re-quantised: the parts hold slices of the bundle's own stored
    bytes, and before returning this checks that the parts joined end to end
    are the bundle's arrays byte for byte."""
    source = Path(source)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = stem or source.stem
    with np.load(source) as z:
        whole = {k: z[k] for k in z.files}
    axes = {a: f for a, f in AXES.items() if a in whole}
    timed = {f for fields in axes.values() for f in fields if f in whole}
    t_all = whole["t_weather"].astype("datetime64[s]")
    months = sorted({str(t)[:7] for t in t_all.astype("datetime64[M]")})
    starts = {a: _part_starts(whole[a], months) for a in axes}
    for a, st in starts.items():
        if any(j <= i for i, j in pairwise(st)):
            raise ValueError(f"{a}: a month of the bundle holds no step")

    static = {k: v for k, v in whole.items() if k not in timed}
    static["parts_keys"] = np.array(months)
    for a, st in starts.items():
        static["parts_" + a] = np.array(st, dtype=np.int64)
    files = {"static": f"{stem}_static.npz"}
    np.savez_compressed(out_dir / files["static"], **static)

    def cut_time(name: str, i0: int, i1: int) -> np.ndarray:
        a = whole[name]
        # stored planes are (2, time, lat, lon); anything else is (time, lat, lon)
        return a[:, i0 : i1 + 1] if a.dtype == np.uint8 else a[i0 : i1 + 1]

    parts = []
    for n, m in enumerate(months):
        arrays = {}
        for a, fields in axes.items():
            st = starts[a]
            i1 = st[n + 1] if n + 1 < len(st) else len(whole[a]) - 1
            for f in fields:
                if f in whole:
                    arrays[f] = cut_time(f, st[n], i1)
        name = f"{stem}_{m}.npz"
        np.savez_compressed(out_dir / name, **arrays)
        parts.append({"key": m, "file": name, "bytes": (out_dir / name).stat().st_size})

    # The check: read the files back and join them (dropping each part's shared
    # last step); every stored array must be the bundle's, byte for byte.
    back = {m["key"]: dict(np.load(out_dir / m["file"])) for m in parts}
    for a, fields in axes.items():
        for f in fields:
            if f not in whole:
                continue
            ax = 1 if whole[f].dtype == np.uint8 else 0
            pieces = []
            for n, m in enumerate(months):
                p = back[m][f]
                last = n == len(months) - 1
                pieces.append(p if last else np.delete(p, -1, axis=ax))
            joined = np.concatenate(pieces, axis=ax)
            if joined.dtype != whole[f].dtype or joined.tobytes() != whole[f].tobytes():
                raise ValueError(f"split changed {f}: the parts don't join back to the bundle")
    with np.load(out_dir / files["static"]) as z:
        for k, v in whole.items():
            if k not in timed and (z[k].dtype != v.dtype or z[k].tobytes() != v.tobytes()):
                raise ValueError(f"split changed {k}")

    index = {
        "static": files["static"],
        "static_bytes": (out_dir / files["static"]).stat().st_size,
        "parts": parts,
        "whole": source.name,
        "whole_bytes": source.stat().st_size,
    }
    (out_dir / f"{stem}_parts.json").write_text(json.dumps(index))
    return index


def open_parts(index_path, keys=None) -> BundleEnvironment:
    """A split bundle from its `_parts.json`, with every part added (or only
    `keys`): the whole bundle's environment, read from the split files."""
    index_path = Path(index_path)
    index = json.loads(index_path.read_text())
    env = BundleEnvironment(index_path.parent / index["static"])
    for p in index["parts"]:
        if keys is None or p["key"] in keys:
            env.add_part(p["key"], index_path.parent / p["file"])
    return env
