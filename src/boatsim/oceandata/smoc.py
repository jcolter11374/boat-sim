"""Surface currents from SMOC (Mercator, Copernicus Marine): a second opinion.

SMOC is what the Randolph team's simulator drifts with (through Open-Meteo,
see currents_check.py). SmocSource lets our simulator use it in place of
GLORYS12, so Ravi's drifter check (#73) can score both against real drifters.
It has the same interface as GlorysSource: sample(t, lat, lon) returns
current_u and current_v (m/s, eastward and northward).

Product: Copernicus Marine GLOBAL_ANALYSISFORECAST_PHY_001_024
(doi:10.48670/moi-00016), Mercator's operational ocean model on a
1/12 degree grid. Two kinds, as Ravi asked:

    kind="model"  daily mean ocean-model current at the surface (0.49 m):
                  dataset cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m, uo/vo.
                  The same kind of thing GLORYS gives, so it's a like-for-like
                  swap. Daily means are moved from 00:00 to 12:00, like GLORYS.
    kind="total"  hourly current including tides and the waves' Stokes drift
                  (the slow push waves give anything floating at the
                  surface): dataset cmems_mod_glo_phy_anfc_merged-uv_PT1H-i,
                  utotal/vtotal, instantaneous on the hour. CAREFUL: Stokes
                  drift is already inside this, so a model that adds ERA5's
                  Stokes drift on top (the drifter check's "float" and
                  "kayak") counts it twice.

Coverage: an operational product, so it starts late (about Nov 2020, GUESS:
check the first month in Actions) and runs to the present. Not a reanalysis:
the model changed versions over the years.

Box: hourly fields are big (about 200 MB a month for the default box), so the
default is the Gulf Stream stretch both teams cross (36-42N, 75-50W, #73)
padded so a 10-day drift stays inside: 33-46N, 78-40W. A full route box
would be about 1.5 GB a month hourly; ask before using one.

ACCOUNT NEEDED: the same free Copernicus Marine login as GLORYS.
One month is cached per file under data/smoc/, one day of padding each side.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np

from boatsim.oceandata.glorys import SCALE, CopernicusLoginMissing, _have_login, load_tile
from boatsim.oceandata.grid import Box, OutsideCoverage, TileCache, to_datetime64

KINDS = {
    # kind: (dataset, (u variable, v variable), hours added to the time stamp)
    "model": ("cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m", ("uo", "vo"), 12),
    "total": ("cmems_mod_glo_phy_anfc_merged-uv_PT1H-i", ("utotal", "vtotal"), 0),
}
SMOC_BOX = Box(lat_min=33.0, lat_max=46.0, lon_min=-78.0, lon_max=-40.0)
DEFAULT_CACHE = Path(os.environ.get("BOATSIM_DATA", "data")) / "smoc"


def _copernicus_open(dataset_id: str, variables, box: Box, start: datetime, end: datetime):
    import copernicusmarine

    return copernicusmarine.open_dataset(
        dataset_id=dataset_id,
        variables=list(variables),
        minimum_longitude=box.lon_min,
        maximum_longitude=box.lon_max,
        minimum_latitude=box.lat_min,
        maximum_latitude=box.lat_max,
        minimum_depth=0.0,
        maximum_depth=1.0,
        start_datetime=start.isoformat(),
        end_datetime=end.isoformat(),
    )


def month_span(year: int, month: int) -> tuple[datetime, datetime]:
    """First and last time to fetch for a month, padded by one day each side."""
    first = datetime(year, month, 1) - timedelta(days=1)
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    return first, datetime.combine(nxt, datetime.min.time()) + timedelta(hours=23)


def tile_path(year: int, month: int, kind: str, cache_dir: Path = DEFAULT_CACHE) -> Path:
    return Path(cache_dir) / f"smoc_{kind}_uv0_{year:04d}{month:02d}.nc"


def fetch_month(
    year: int,
    month: int,
    kind: str = "model",
    cache_dir: Path = DEFAULT_CACHE,
    box: Box = SMOC_BOX,
    opener=_copernicus_open,
) -> Path:
    """Subset one month of SMOC surface current and cache it. Returns the path."""
    import xarray as xr

    dataset_id, (vu, vv), shift_h = KINDS[kind]
    path = tile_path(year, month, kind, cache_dir)
    if path.exists():
        return path
    if opener is _copernicus_open and not _have_login():
        raise CopernicusLoginMissing(
            "SMOC currents need a free Copernicus Marine login (the same one as GLORYS): "
            "set COPERNICUSMARINE_SERVICE_USERNAME / COPERNICUSMARINE_SERVICE_PASSWORD."
        )
    start, end = month_span(year, month)
    ds = opener(dataset_id, (vu, vv), box, start, end)
    ds = ds.sel(time=slice(np.datetime64(start), np.datetime64(end)))
    if not ds.sizes.get("time", 0):
        raise ValueError(f"no SMOC {kind} data for {year}-{month:02d} (coverage starts ~2020-11)")
    if "depth" in ds.dims:
        ds = ds.isel(depth=0)
    ds = ds.rename({"latitude": "lat", "longitude": "lon"}).sortby("lat").sortby("lon")
    ds = ds.assign_coords(time=ds.time + np.timedelta64(shift_h, "h"))
    out = xr.Dataset(
        {
            "current_u": (("time", "lat", "lon"), ds[vu].values.astype(np.float32)),
            "current_v": (("time", "lat", "lon"), ds[vv].values.astype(np.float32)),
        },
        coords={"time": ds.time.values, "lat": ds.lat.values, "lon": ds.lon.values},
        attrs={
            "source": f"Copernicus Marine GLOBAL_ANALYSISFORECAST_PHY_001_024 {dataset_id}, "
            "doi:10.48670/moi-00016",
            "kind": kind,
            "variables": f"{vu}, {vv}",
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


class SmocSource:
    """Samples SMOC surface current; a drop-in for GlorysSource."""

    def __init__(
        self,
        kind: str = "model",
        cache_dir: str | Path = DEFAULT_CACHE,
        box: Box = SMOC_BOX,
        fetch: bool = True,
        opener=_copernicus_open,
        max_tiles: int = 2,  # month-tiles kept in memory (hourly: ~400 MB each)
    ):
        if kind not in KINDS:
            raise ValueError(f"kind must be one of {sorted(KINDS)}, not {kind!r}")
        self.kind = kind
        self.cache_dir = Path(cache_dir)
        self.box = box
        self.fetch = fetch
        self.opener = opener
        self._tiles = TileCache(self._load_month, max_tiles=max_tiles)

    def _load_month(self, key: tuple[int, int]):
        path = tile_path(*key, self.kind, self.cache_dir)
        if not path.exists():
            if not self.fetch:
                raise FileNotFoundError(f"{path} not cached and fetching is off")
            fetch_month(*key, self.kind, self.cache_dir, self.box, self.opener)
        return load_tile(path)

    def sample(self, t: datetime, lat: float, lon: float) -> dict[str, float]:
        if not self.box.contains(lat, lon):
            raise OutsideCoverage(f"({lat}, {lon}) is outside the SMOC box {self.box}")
        t64 = to_datetime64(t)
        d = t64.astype("datetime64[D]").astype(object)
        return self._tiles.get((d.year, d.month)).sample(t64, lat, lon, ["current_u", "current_v"])
