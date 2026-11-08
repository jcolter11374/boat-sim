"""ERA5 wind, waves, sunlight, cloud and air temperature, read on demand from
Google's public ARCO-ERA5 cloud copy. No account and no bulk download.

Source: ERA5 hourly reanalysis (Hersbach et al. 2020, doi:10.1002/qj.3803),
as the analysis-ready Zarr store published by Google Research:
    gs://gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3
(Carver et al. 2023, https://github.com/google-research/arco-era5). Hourly,
0.25 degree grid. Wave fields come from ECMWF's wave model on a 0.5 degree grid
and are interpolated to 0.25 degree in this store; they are NaN over land.

How fetching works: the store keeps each hour of each variable as one global
chunk, so reading our route box still transfers the whole globe for that hour
(about 18 MB for the 8 variables below, measured). We therefore fetch one UTC
day at a time, crop it to the route box, pack it, and cache it as one small
NetCDF file under data/era5/. A voyage only fetches the days it actually uses,
and every later run reads the local file.

Conversions done here, so the rest of the code is SI and plain:
    ssrd (J/m^2 accumulated over the hour ending at the time stamp)
        -> ghi in W/m^2 (divide by 3600), treated as valid at the middle of
           that hour (see ERA5Source.sample)
    t2m (K) -> air_temp (deg C)
    mean_wave_direction is the direction waves come FROM, degrees true,
        same convention as EnvState.wave_dir
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np

from boatsim.oceandata.grid import (
    ROUTE_BOX,
    Box,
    GridSeries,
    OutsideCoverage,
    TileCache,
    to_datetime64,
)

ARCO_ERA5_URL = "gs://gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3"
DEFAULT_CACHE = Path(os.environ.get("BOATSIM_DATA", "data")) / "era5"

# ARCO-ERA5 variable name -> (our name, packing scale, packing offset)
# Packing to int16 keeps files small. The scale is the resolution we keep,
# chosen well below the data's own accuracy (e.g. 0.01 m/s for wind).
VARIABLES: dict[str, tuple[str, float, float]] = {
    "10m_u_component_of_wind": ("wind_u", 0.01, 0.0),  # m/s
    "10m_v_component_of_wind": ("wind_v", 0.01, 0.0),  # m/s
    "significant_height_of_combined_wind_waves_and_swell": ("hs", 0.001, 0.0),  # m
    "peak_wave_period": ("tp", 0.001, 0.0),  # s
    "mean_wave_direction": ("wave_dir", 0.01, 180.0),  # deg, coming from
    "surface_solar_radiation_downwards": ("ghi", 0.05, 0.0),  # W/m^2 after conversion
    "total_cloud_cover": ("cloud_fraction", 0.0001, 0.0),  # 0..1
    "2m_temperature": ("air_temp", 0.01, 0.0),  # deg C after conversion
}
FIELDS = [v[0] for v in VARIABLES.values()]
HOURS_PER_TILE = 26  # 00:00 of the day to 01:00 next day, so every in-day sample has a bracket


@dataclass
class FetchStats:
    day: date
    seconds: float
    bytes_transferred: int  # compressed bytes read from the cloud store
    bytes_on_disk: int  # our cached file


@lru_cache(maxsize=2)
def _open_store(url: str = ARCO_ERA5_URL):
    import xarray as xr

    opts = {"storage_options": {"token": "anon"}} if url.startswith("gs://") else {}
    return xr.open_zarr(url, chunks=None, **opts)


def _box_indices(lat: np.ndarray, lon: np.ndarray, box: Box) -> tuple[np.ndarray, np.ndarray]:
    """Indices into the store's lat (90..-90) and lon (0..360) axes, ordered so
    the result has ascending lat and ascending -180..180 lon."""
    lat_idx = np.where((lat >= box.lat_min) & (lat <= box.lat_max))[0]
    lat_idx = lat_idx[np.argsort(lat[lat_idx])]
    lon180 = ((lon + 180.0) % 360.0) - 180.0
    lon_idx = np.where((lon180 >= box.lon_min) & (lon180 <= box.lon_max))[0]
    lon_idx = lon_idx[np.argsort(lon180[lon_idx])]
    return lat_idx, lon_idx


def tile_path(day: date, cache_dir: Path = DEFAULT_CACHE) -> Path:
    return Path(cache_dir) / f"{day:%Y}" / f"{day:%m}" / f"era5_{day:%Y%m%d}.nc"


def fetch_day(
    day: date,
    cache_dir: Path = DEFAULT_CACHE,
    box: Box = ROUTE_BOX,
    url: str = ARCO_ERA5_URL,
    measure: bool = False,
) -> FetchStats:
    """Read one UTC day (plus the next day's first hour) for the route box from
    ARCO-ERA5 and cache it as packed NetCDF. Skips the read if already cached.

    measure=True also looks up how many compressed bytes were pulled (slower;
    for reporting data sizes only)."""
    import xarray as xr

    path = tile_path(day, cache_dir)
    if path.exists():
        return FetchStats(day, 0.0, 0, path.stat().st_size)
    t0 = time.monotonic()
    store = _open_store(url)
    lat_idx, lon_idx = _box_indices(store.latitude.values, store.longitude.values, box)
    start = np.datetime64(datetime(day.year, day.month, day.day), "ns")
    times = store.time.values
    it0 = int(np.searchsorted(times, start))
    if it0 >= len(times) or times[it0] != start:
        raise ValueError(f"{day} is not in the ERA5 store")
    t_idx = np.arange(it0, it0 + HOURS_PER_TILE)
    valid_stop = np.datetime64(store.attrs.get("valid_time_stop_era5t", "2100-01-01"))
    if times[t_idx[-1]] > valid_stop + np.timedelta64(23, "h"):
        raise ValueError(f"{day} is later than ERA5's latest data ({valid_stop})")

    sub = store[list(VARIABLES)].isel(time=t_idx, latitude=lat_idx, longitude=lon_idx).load()
    sub = sub.assign_coords(longitude=((sub.longitude + 180.0) % 360.0) - 180.0)

    out = xr.Dataset(coords={"time": sub.time, "lat": sub.latitude.values, "lon": sub.longitude})
    encoding = {}
    for src, (name, scale, offset) in VARIABLES.items():
        a = sub[src].values.astype(np.float32)
        if name == "ghi":
            a = np.maximum(a / 3600.0, 0.0)  # J/m^2 per hour -> mean W/m^2
        elif name == "air_temp":
            a = a - 273.15
        if not np.isfinite(a).any() and name not in ("hs", "tp", "wave_dir"):
            raise ValueError(f"{src} is all missing on {day}")
        out[name] = (("time", "lat", "lon"), a)
        encoding[name] = {
            "dtype": "int16",
            "scale_factor": scale,
            "add_offset": offset,
            "_FillValue": np.int16(-32768),
            "zlib": True,
            "complevel": 4,
        }
    out.attrs = {
        "source": url,
        "citation": "Hersbach et al. 2020 (ERA5), via Google ARCO-ERA5",
        "ghi_note": "hourly mean of the hour ENDING at the time stamp",
        "box": f"{box}",
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".nc.part")
    out.to_netcdf(tmp, encoding=encoding, engine="netcdf4")
    tmp.rename(path)
    seconds = time.monotonic() - t0

    if not measure:
        return FetchStats(day, seconds, -1, path.stat().st_size)
    # Compressed bytes we pulled: one global chunk per hour per variable.
    transferred = 0
    try:
        import gcsfs

        fs = gcsfs.GCSFileSystem(token="anon")
        root = url.removeprefix("gs://")
        for src in VARIABLES:
            for it in t_idx:
                transferred += fs.info(f"{root}/{src}/{it}.0.0")["size"]
    except (ImportError, OSError, KeyError):  # sizes are for reporting only
        transferred = -1
    return FetchStats(day, seconds, transferred, path.stat().st_size)


def load_tile(path: Path) -> GridSeries:
    import xarray as xr

    with xr.open_dataset(path, engine="netcdf4") as ds:
        fields = {name: ds[name].values.astype(np.float32) for name in FIELDS}
        times, lats, lons = ds.time.values, ds.lat.values, ds.lon.values
    # Directions are averaged as unit vectors, so 350 and 10 degrees give 0, not 180.
    rad = np.deg2rad(fields["wave_dir"])
    fields["_wd_x"] = np.sin(rad).astype(np.float32)
    fields["_wd_y"] = np.cos(rad).astype(np.float32)
    return GridSeries(times=times, lats=lats, lons=lons, fields=fields)


class ERA5Source:
    """Samples ERA5 at any point in the route box, fetching days as needed."""

    def __init__(
        self,
        cache_dir: str | Path = DEFAULT_CACHE,
        box: Box = ROUTE_BOX,
        fetch: bool = True,
        url: str = ARCO_ERA5_URL,
    ):
        self.cache_dir = Path(cache_dir)
        self.box = box
        self.fetch = fetch
        self.url = url
        self._tiles = TileCache(self._load_day, max_tiles=3)

    def _load_day(self, day: date) -> GridSeries:
        path = tile_path(day, self.cache_dir)
        if not path.exists():
            if not self.fetch:
                raise FileNotFoundError(f"{path} not cached and fetching is off")
            fetch_day(day, self.cache_dir, self.box, self.url)
        return load_tile(path)

    def sample(self, t: datetime, lat: float, lon: float) -> dict[str, float]:
        if not self.box.contains(lat, lon):
            raise OutsideCoverage(f"({lat}, {lon}) is outside the data box {self.box}")
        t64 = to_datetime64(t)
        day = t64.astype("datetime64[D]").astype(object)
        tile = self._tiles.get(day)
        out = tile.sample(t64, lat, lon, [f for f in FIELDS if f not in ("ghi", "wave_dir")])
        # Sunlight: each value is the mean over the hour ending at its stamp, so
        # the value stamped hh:00 best represents hh-0:30. Sampling at t + 30 min
        # lines the hourly means up with the time they describe.
        out.update(tile.sample(t64 + np.timedelta64(30, "m"), lat, lon, ["ghi"]))
        out["wave_dir"] = _sample_direction(tile, t64, lat, lon)
        return out


def _sample_direction(tile: GridSeries, t64, lat: float, lon: float) -> float:
    v = tile.sample(t64, lat, lon, ["_wd_x", "_wd_y"])
    if not np.isfinite(v["_wd_x"]):
        return float("nan")
    return float(np.rad2deg(np.arctan2(v["_wd_x"], v["_wd_y"])) % 360.0)


def days_between(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def fetch_days(
    days: list[date], cache_dir: Path = DEFAULT_CACHE, workers: int = 4, measure: bool = False
) -> list[FetchStats]:
    """Fetch many days in parallel. Uses processes, not threads, because the
    NetCDF/HDF5 writer is not thread-safe."""
    from concurrent.futures import ProcessPoolExecutor

    if workers <= 1:
        return [fetch_day(d, cache_dir, measure=measure) for d in days]
    with ProcessPoolExecutor(workers) as ex:
        futures = [ex.submit(fetch_day, d, cache_dir, measure=measure) for d in days]
        return [f.result() for f in futures]
