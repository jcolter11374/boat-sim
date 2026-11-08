"""Surface currents from GLORYS12 (Copernicus Marine), subset on request.

Source: Copernicus Marine product GLOBAL_MULTIYEAR_PHY_001_030 ("GLORYS12V1"),
https://doi.org/10.48670/moi-00021 . Daily means on a 1/12 degree grid,
1993 onward. We read only the top model level (0.49 m deep), only uo/vo
(eastward/northward current, m/s), and only the route box and month we need.

Two datasets cover the record:
    cmems_mod_glo_phy_my_0.083deg_P1D-m     reanalysis, 1993 to mid-2021
    cmems_mod_glo_phy_myint_0.083deg_P1D-m  "interim" extension, mid-2021 on
We ask the reanalysis first and fall back to the interim set for later dates.

ACCOUNT NEEDED: Copernicus Marine is free but needs a registered login
(https://data.marine.copernicus.eu/register). Put it in the environment as
COPERNICUSMARINE_SERVICE_USERNAME and COPERNICUSMARINE_SERVICE_PASSWORD
(GitHub Actions secrets in CI); the copernicusmarine toolbox reads them.

Time stamps: each daily mean is stamped 00:00 of its day. We move it to 12:00,
the middle of the day it averages, so linear interpolation between days is
centred correctly.

One month is cached per file under data/glorys/, with one extra day on each
side so any time inside the month has two days to interpolate between.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta
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

DATASETS = [
    "cmems_mod_glo_phy_my_0.083deg_P1D-m",
    "cmems_mod_glo_phy_myint_0.083deg_P1D-m",
]
FIRST_DAY = date(1993, 1, 1)
DEFAULT_CACHE = Path(os.environ.get("BOATSIM_DATA", "data")) / "glorys"
SCALE = 0.001  # m/s kept in the int16 cache file


class CopernicusLoginMissing(RuntimeError):
    pass


def _have_login() -> bool:
    if os.environ.get("COPERNICUSMARINE_SERVICE_USERNAME") and os.environ.get(
        "COPERNICUSMARINE_SERVICE_PASSWORD"
    ):
        return True
    # copernicusmarine login stores a credentials file in the home directory
    return (Path.home() / ".copernicusmarine" / ".copernicusmarine-credentials").exists()


def _copernicus_open(dataset_id: str, box: Box, start: datetime, end: datetime):
    import copernicusmarine

    return copernicusmarine.open_dataset(
        dataset_id=dataset_id,
        variables=["uo", "vo"],
        minimum_longitude=box.lon_min,
        maximum_longitude=box.lon_max,
        minimum_latitude=box.lat_min,
        maximum_latitude=box.lat_max,
        minimum_depth=0.0,
        maximum_depth=1.0,
        start_datetime=start.isoformat(),
        end_datetime=end.isoformat(),
    )


def month_span(year: int, month: int) -> tuple[date, date]:
    """First and last day to fetch for a month, padded by one day each side."""
    first = date(year, month, 1)
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    return max(first - timedelta(days=1), FIRST_DAY), nxt


def tile_path(year: int, month: int, cache_dir: Path = DEFAULT_CACHE) -> Path:
    return Path(cache_dir) / f"glorys_uv0_{year:04d}{month:02d}.nc"


def fetch_month(
    year: int,
    month: int,
    cache_dir: Path = DEFAULT_CACHE,
    box: Box = ROUTE_BOX,
    opener=_copernicus_open,
) -> Path:
    """Subset one month of surface currents and cache it. Returns the file path."""
    import xarray as xr

    path = tile_path(year, month, cache_dir)
    if path.exists():
        return path
    if opener is _copernicus_open and not _have_login():
        raise CopernicusLoginMissing(
            "GLORYS currents need a free Copernicus Marine login. Register at "
            "https://data.marine.copernicus.eu/register and set "
            "COPERNICUSMARINE_SERVICE_USERNAME / COPERNICUSMARINE_SERVICE_PASSWORD."
        )
    first, last = month_span(year, month)
    start, end = (
        datetime.combine(first, datetime.min.time()),
        datetime.combine(last, datetime.min.time()),
    )
    parts, need_from, last_error = [], start, None
    for dataset_id in DATASETS:
        try:
            ds = opener(dataset_id, box, need_from, end)
        except Exception as e:  # noqa: BLE001  toolbox errors vary; try the next dataset
            last_error = e
            continue
        ds = ds.sel(time=slice(np.datetime64(need_from), np.datetime64(end)))
        if ds.sizes.get("time", 0):
            parts.append(ds)
            got_to = ds.time.values[-1].astype("datetime64[s]").astype(datetime)
            if got_to >= end:
                break
            need_from = got_to + timedelta(days=1)
    if not parts:
        raise ValueError(f"no GLORYS data for {year}-{month:02d}: {last_error!r}")
    ds = xr.concat(parts, dim="time") if len(parts) > 1 else parts[0]
    if "depth" in ds.dims:
        ds = ds.isel(depth=0)
    ds = ds.rename({"latitude": "lat", "longitude": "lon"}).sortby("lat").sortby("lon")
    ds = ds.assign_coords(time=ds.time + np.timedelta64(12, "h"))  # daily mean -> mid-day
    out = xr.Dataset(
        {
            "current_u": (("time", "lat", "lon"), ds["uo"].values.astype(np.float32)),
            "current_v": (("time", "lat", "lon"), ds["vo"].values.astype(np.float32)),
        },
        coords={"time": ds.time.values, "lat": ds.lat.values, "lon": ds.lon.values},
        attrs={
            "source": "Copernicus Marine GLOBAL_MULTIYEAR_PHY_001_030, doi:10.48670/moi-00021",
            "time_note": "daily means, stamped at 12:00 UTC of the day they average",
            "box": f"{box}",
        },
    )
    enc = {
        "dtype": "int16",
        "scale_factor": SCALE,
        "_FillValue": np.int16(-32768),
        "zlib": True,
        "complevel": 4,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".nc.part")
    out.to_netcdf(tmp, encoding={"current_u": enc, "current_v": enc}, engine="netcdf4")
    tmp.rename(path)
    return path


def load_tile(path: Path) -> GridSeries:
    import xarray as xr

    with xr.open_dataset(path, engine="netcdf4") as ds:
        return GridSeries(
            times=ds.time.values,
            lats=ds.lat.values,
            lons=ds.lon.values,
            fields={n: ds[n].values.astype(np.float32) for n in ("current_u", "current_v")},
        )


class GlorysSource:
    """Samples GLORYS12 surface current at any point in the route box."""

    def __init__(
        self,
        cache_dir: str | Path = DEFAULT_CACHE,
        box: Box = ROUTE_BOX,
        fetch: bool = True,
        opener=_copernicus_open,
    ):
        self.cache_dir = Path(cache_dir)
        self.box = box
        self.fetch = fetch
        self.opener = opener
        self._tiles = TileCache(self._load_month, max_tiles=2)

    def _load_month(self, key: tuple[int, int]) -> GridSeries:
        path = tile_path(*key, self.cache_dir)
        if not path.exists():
            if not self.fetch:
                raise FileNotFoundError(f"{path} not cached and fetching is off")
            fetch_month(*key, self.cache_dir, self.box, self.opener)
        return load_tile(path)

    def sample(self, t: datetime, lat: float, lon: float) -> dict[str, float]:
        if not self.box.contains(lat, lon):
            raise OutsideCoverage(f"({lat}, {lon}) is outside the data box {self.box}")
        t64 = to_datetime64(t)
        d = t64.astype("datetime64[D]").astype(object)
        return self._tiles.get((d.year, d.month)).sample(t64, lat, lon, ["current_u", "current_v"])
