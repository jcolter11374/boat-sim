"""Forcing bundle for the in-browser sandbox: one launch season of weather,
currents and ship traffic, thinned to the route corridor and packed in one
compressed .npz the browser downloads once.

What is in it, and what that changes against the full-resolution runs:

* ERA5 wind, waves and cloud at 1 deg every 6 h (full runs: 0.25 deg hourly);
  air temperature daily.
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
import math
from datetime import date, datetime, timedelta

import numpy as np

from boatsim.oceandata.grid import Box, GridSeries
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


class BundleEnvironment:
    """Environment.sample(t, lat, lon) from a forcing bundle (path or bytes)."""

    def __init__(self, source):
        if isinstance(source, (bytes, bytearray, memoryview)):
            source = io.BytesIO(bytes(source))
        with np.load(source) as z:
            lat, lon = z["lat"], z["lon"]
            self.meta = {k[5:]: z[k].item() for k in z.files if k.startswith("meta_")}
            self.weather = GridSeries(
                _times(z, "t_weather"),
                lat,
                lon,
                {
                    **{
                        k: _unpack(z, k) for k in ("wind_u", "wind_v", "hs", "tp", "cloud_fraction")
                    },
                    **_wave_vectors(z),
                },
            )
            self.daily = GridSeries(
                _times(z, "t_daily"),
                lat,
                lon,
                {k: _unpack(z, k) for k in ("air_temp", "clearness")},
            )
            self.currents = None
            if "current_u" in z.files:
                self.currents = GridSeries(
                    _times(z, "t_current"),
                    z["lat_current"],
                    z["lon_current"],
                    {k: _unpack(z, k) for k in ("current_u", "current_v")},
                )
            self.ships = None
            if "ship_density" in z.files:
                self.ships = GridSeries(
                    np.array(["2000-01-01"], dtype="datetime64[s]"),
                    z["lat_ships"],
                    z["lon_ships"],
                    {"ship_density": _unpack(z, "ship_density")[None]},
                )

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


def _idx(axis: np.ndarray, lo: float, hi: float, res: float) -> np.ndarray:
    step = max(1, round(res / float(axis[1] - axis[0])))
    i = np.where((axis >= lo - 1e-6) & (axis <= hi + 1e-6))[0]
    return i[::step]


def cut(
    year: int, out, era5=None, glorys=None, ships=None, log=print, first=FIRST, last=LAST
) -> dict:
    """Cut one season's bundle from the cached full data and save it to `out`
    (path or file). glorys=False / ships=False leave currents / ships out.
    Returns the stored arrays' sizes in bytes."""
    from boatsim.oceandata import ERA5Source, GlorysSource
    from boatsim.oceandata.traffic import default_source

    era5 = era5 or ERA5Source(fetch=False, max_tiles=2)
    if glorys is None:
        glorys = GlorysSource(fetch=False)
    if ships is None:
        ships = default_source()
    box = CORRIDOR
    d0, d1 = date(year, *first), date(year, *last)
    days = [d0 + timedelta(days=i) for i in range((d1 - d0).days + 1)]

    weather = {k: [] for k in ("wind_u", "wind_v", "hs", "tp", "wave_dir", "cloud_fraction")}
    daily = {"air_temp": [], "clearness": []}
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
    arrays["meta_year"] = np.array(year)
    arrays["meta_first"] = np.array(str(d0))
    arrays["meta_last"] = np.array(str(d1))
    np.savez_compressed(out, **arrays)
    return {k: v.nbytes for k, v in arrays.items()}
