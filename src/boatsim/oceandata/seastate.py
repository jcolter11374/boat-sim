"""Baked sea state and depth for the 3D view (display only: no physics reads it).

Sea state: ERA5 wave partitions from Google's ARCO-ERA5 store (Hersbach et al.
2020, doi:10.1002/qj.3803; Copernicus Climate Change Service), the same store
era5.py streams. Three wave systems, each with significant height, mean period
and the direction it comes FROM (degrees true, as EnvState.wave_dir):

    ws   wind sea: significant_height_of_wind_waves,
         mean_wave_period_based_on_first_moment_for_wind_waves,
         mean_direction_of_wind_waves
    s1   first (largest) swell partition: significant_wave_height_of_first_swell_partition,
         mean_wave_period_of_first_swell_partition, mean_wave_direction_of_first_swell_partition
    s2   second swell partition, likewise

Two swell partitions rather than ERA5's "total swell", whose direction averages
crossing swells into one nobody would see. ERA5 gives MEAN periods, not peak
periods: a JONSWAP-style sea has Tp of about 1.2-1.3 x Tm01 (GUESS; Theo owns
the factor the 3D sea uses). Combined Hs is sqrt(ws^2 + s1^2 + s2^2) plus a
little from any third swell.

Grid: the sandbox corridor (sandbox/forcing.py, 28-50N, 78-8W) at 1 degree,
every 3 hours, sampled at ERA5 grid points (no averaging: directions don't
average). No data over land and sea ice. At a sea point where another
system has values, no data means that system is absent there: height 0 (about
1% of sea points for the wind sea in a spring 2020 check). One file per month:

    seastate_YYYY-MM.json     header: grid, times, fields and their scales
    seastate_YYYY-MM.bin.gz   int16 little-endian, [time][field][lat][lon],
                              lat south->north, lon west->east, value = int * scale,
                              -32768 = no data (land)
    seastate_index.json       the months available

Depth: the GEBCO global grid (GEBCO Compilation Group, GEBCO 2024 Grid,
doi:10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f) for the Chesapeake-Delmarva box
at its own 15 arc-second (~450 m) spacing, as elevation in metres (negative =
below sea level), same file layout with one field and no time:

    depth_chesapeake.json / depth_chesapeake.bin.gz

Fetching needs the cloud stores: run it in GitHub Actions ("Sea state data").
"""

from __future__ import annotations

import gzip
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from boatsim.oceandata.era5 import ARCO_ERA5_URL, _box_indices, _open_store
from boatsim.oceandata.grid import Box

CORRIDOR = Box(lat_min=28.0, lat_max=50.0, lon_min=-78.0, lon_max=-8.0)  # = sandbox.forcing
RES = 1.0  # deg
STEP_H = 3
FILL = -32768
SEASON = (4, 11)  # April to November, the sandbox season

# (short name, ARCO variable, units, scale)
FIELDS: list[tuple[str, str, str, float]] = [
    ("ws_hs", "significant_height_of_wind_waves", "m", 0.01),
    ("ws_tm", "mean_wave_period_based_on_first_moment_for_wind_waves", "s", 0.01),
    ("ws_dir", "mean_direction_of_wind_waves", "deg from, true", 0.1),
    ("s1_hs", "significant_wave_height_of_first_swell_partition", "m", 0.01),
    ("s1_tm", "mean_wave_period_of_first_swell_partition", "s", 0.01),
    ("s1_dir", "mean_wave_direction_of_first_swell_partition", "deg from, true", 0.1),
    ("s2_hs", "significant_wave_height_of_second_swell_partition", "m", 0.01),
    ("s2_tm", "mean_wave_period_of_second_swell_partition", "s", 0.01),
    ("s2_dir", "mean_wave_direction_of_second_swell_partition", "deg from, true", 0.1),
]

DEPTH_BOX = Box(lat_min=36.5, lat_max=39.7, lon_min=-77.5, lon_max=-74.0)
# OPeNDAP copies of a global elevation grid, tried in order. GEBCO first (Maya's
# pick); NOAA ETOPO 2022 15" as the fallback (finer at US coasts, public domain).
_CEDA = "https://dap.ceda.ac.uk/thredds/dodsC/bodc/gebco/global"
_NCEI = "https://www.ngdc.noaa.gov/thredds/dodsC/global/ETOPO2022"
DEPTH_SOURCES = [  # GUESS at the exact OPeNDAP paths; the workflow log shows which answered
    ("GEBCO 2024", f"{_CEDA}/gebco_2024/ice_surface_elevation/netcdf/GEBCO_2024.nc"),
    ("GEBCO 2023", f"{_CEDA}/gebco_2023/ice_surface_elevation/netcdf/GEBCO_2023.nc"),
    (
        "ETOPO 2022 30s",
        f"{_NCEI}/30s/30s_surface_elev_netcdf/ETOPO_2022_v1_30s_N90W180_surface.nc",
    ),
]
DEPTH_ATTRIBUTION = {
    "GEBCO": "GEBCO Compilation Group (2024) GEBCO 2024 Grid "
    "(doi:10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f)",
    "ETOPO": "NOAA National Centers for Environmental Information (2022) ETOPO 2022 "
    "15 Arc-Second Global Relief Model (doi:10.25921/fd45-gt74), public domain",
}

ATTRIBUTION = (
    "Contains modified Copernicus Climate Change Service information (ERA5, "
    "Hersbach et al. 2020, doi:10.1002/qj.3803), via Google ARCO-ERA5. "
    "Neither the European Commission nor ECMWF is responsible for any use of it."
)


# ----------------------------------------------------------------- packing


def pack(a: np.ndarray, scale: float) -> np.ndarray:
    """float -> int16 with scale; NaN -> FILL."""
    q = np.round(np.asarray(a, dtype=np.float64) / scale)
    q = np.clip(q, -32767, 32767)
    return np.where(np.isfinite(q), q, FILL).astype("<i2")


def unpack(q: np.ndarray, scale: float) -> np.ndarray:
    return np.where(q == FILL, np.nan, q.astype(np.float32) * scale)


def write_grid(stem: Path, header: dict, planes: np.ndarray) -> tuple[Path, Path]:
    """Header JSON and gzipped int16 planes, side by side."""
    stem = Path(stem)
    stem.parent.mkdir(parents=True, exist_ok=True)
    header = {**header, "dtype": "int16 little-endian", "fill": FILL, "shape": list(planes.shape)}
    js = stem.with_suffix(".json")
    js.write_text(json.dumps(header, indent=1))
    bz = stem.with_suffix(".bin.gz")
    bz.write_bytes(gzip.compress(np.ascontiguousarray(planes, dtype="<i2").tobytes(), 9, mtime=0))
    return js, bz


def read_grid(stem: Path) -> tuple[dict, np.ndarray]:
    stem = Path(stem)
    header = json.loads(stem.with_suffix(".json").read_text())
    raw = gzip.decompress(stem.with_suffix(".bin.gz").read_bytes())
    return header, np.frombuffer(raw, dtype="<i2").reshape(header["shape"])


# ----------------------------------------------------------------- sea state


def month_times(year: int, month: int, step_h: int = STEP_H) -> list[datetime]:
    t, end = datetime(year, month, 1), datetime(year + (month == 12), month % 12 + 1, 1)  # noqa: DTZ001  naive = UTC
    out = []
    while t < end:
        out.append(t)
        t += timedelta(hours=step_h)
    return out


def _thin(idx: np.ndarray, axis_vals: np.ndarray, res: float) -> np.ndarray:
    """Keep the indices whose coordinate is a whole multiple of res."""
    v = axis_vals[idx]
    keep = np.isclose(np.round(v / res) * res, v, atol=1e-6)
    return idx[keep]


def bake_month(
    year: int,
    month: int,
    out_dir: Path,
    url: str = ARCO_ERA5_URL,
    box: Box = CORRIDOR,
    res: float = RES,
    workers: int = 8,
    store=None,
) -> tuple[Path, Path]:
    """Read one month of wave partitions from ARCO-ERA5 and write the month file."""
    store = store if store is not None else _open_store(url)
    lats, lons = store.latitude.values, store.longitude.values
    li, lj = _box_indices(lats, lons, box)
    li, lj = _thin(li, lats, res), _thin(lj, ((lons + 180.0) % 360.0) - 180.0, res)
    times = month_times(year, month)
    tvals = store.time.values
    t_idx = np.searchsorted(tvals, np.array(times, dtype="datetime64[ns]"))
    if t_idx[-1] >= len(tvals) or tvals[t_idx[-1]] != np.datetime64(times[-1], "ns"):
        raise ValueError(f"{year}-{month:02d} is not fully in the ERA5 store")

    def one(k: int) -> np.ndarray:
        sub = store[[f[1] for f in FIELDS]].isel(time=int(t_idx[k]), latitude=li, longitude=lj)
        return np.stack([pack(sub[src].values, scale) for _, src, _, scale in FIELDS])

    with ThreadPoolExecutor(workers) as ex:  # reads only; nothing here writes NetCDF
        planes = np.stack(list(ex.map(one, range(len(times)))))
    lat_axis = lats[li]
    lon_axis = ((lons[lj] + 180.0) % 360.0) - 180.0
    header = {
        "kind": "seastate",
        "month": f"{year:04d}-{month:02d}",
        "t0": times[0].isoformat(timespec="minutes") + "Z",
        "step_h": STEP_H,
        "nt": len(times),
        "lat0": float(lat_axis[0]),
        "lon0": float(lon_axis[0]),
        "res": res,
        "nlat": len(lat_axis),
        "nlon": len(lon_axis),
        "layout": "[time][field][lat][lon], lat south->north, lon west->east",
        "fields": [{"name": n, "era5": src, "units": u, "scale": s} for n, src, u, s in FIELDS],
        "notes": (
            "Directions are where waves come FROM, degrees true. Periods are ERA5 MEAN "
            "periods (Tm01); peak period is roughly 1.2-1.3 x Tm01 (GUESS). No data "
            "(-32768) over land and sea ice; at a sea point where another system has "
            "values, no data means that system is absent (height 0)."
        ),
        "attribution": ATTRIBUTION,
    }
    return write_grid(Path(out_dir) / f"seastate_{year:04d}-{month:02d}", header, planes)


def write_index(out_dir: Path) -> Path:
    out_dir = Path(out_dir)
    months = sorted(
        p.name[len("seastate_") : -len(".json")] for p in out_dir.glob("seastate_*-*.json")
    )
    p = out_dir / "seastate_index.json"
    p.write_text(json.dumps({"months": months, "attribution": ATTRIBUTION}, indent=1))
    return p


def sample(header: dict, planes: np.ndarray, t: datetime, lat: float, lon: float) -> dict:
    """Nearest-time, nearest-point values (a reference reader for tests and checks)."""
    t0 = datetime.fromisoformat(header["t0"].rstrip("Z"))
    k = round((t - t0).total_seconds() / 3600.0 / header["step_h"])
    i = round((lat - header["lat0"]) / header["res"])
    j = round((lon - header["lon0"]) / header["res"])
    if not (0 <= k < header["nt"] and 0 <= i < header["nlat"] and 0 <= j < header["nlon"]):
        raise ValueError("outside the file")
    return {
        f["name"]: float(unpack(planes[k, n, i, j], f["scale"]))
        for n, f in enumerate(header["fields"])
    }


# ----------------------------------------------------------------- depth


def _span(axis: np.ndarray, lo: float, hi: float) -> slice:
    """A label slice that works on ascending and descending axes."""
    return slice(lo, hi) if axis[0] <= axis[-1] else slice(hi, lo)


def bake_depth(out_dir: Path, sources=DEPTH_SOURCES, box: Box = DEPTH_BOX, opener=None, log=print):
    """Elevation (m, negative below sea level) over the Chesapeake-Delmarva box
    from the first source that answers."""
    import xarray as xr

    opener = opener or (lambda url: xr.open_dataset(url))
    last = None
    for name, url in sources:
        try:
            ds = opener(url)
            lat = "lat" if "lat" in ds.coords else "latitude"
            lon = "lon" if "lon" in ds.coords else "longitude"
            var = next(v for v in ("elevation", "z", "Band1") if v in ds)
            sub = ds[var].sel(
                {
                    lat: _span(ds[lat].values, box.lat_min, box.lat_max),
                    lon: _span(ds[lon].values, box.lon_min, box.lon_max),
                }
            )
            if sub.size == 0:
                raise ValueError("box not in the grid")
            z = sub.values.astype(np.float64)
            la, lo = sub[lat].values, sub[lon].values
        except Exception as e:  # noqa: BLE001  try the next source, report the last error
            log(f"depth: {name} failed: {e!r}"[:300])
            last = e
            continue
        if la[0] > la[-1]:
            z, la = z[::-1], la[::-1]
        log(
            f"depth: {name}, {z.shape[0]} x {z.shape[1]} cells, {np.nanmin(z):.0f} to {np.nanmax(z):.0f} m"
        )
        header = {
            "kind": "depth",
            "source": name,
            "url": url,
            "lat0": float(la[0]),
            "lon0": float(lo[0]),
            "res": float(np.round(np.median(np.diff(la)), 8)),
            "nlat": len(la),
            "nlon": len(lo),
            "layout": "[lat][lon], lat south->north, lon west->east",
            "fields": [{"name": "elevation", "units": "m, negative below sea level", "scale": 1.0}],
            "attribution": DEPTH_ATTRIBUTION.get(name.split()[0], name),
        }
        return write_grid(Path(out_dir) / "depth_chesapeake", header, pack(z, 1.0))
    raise RuntimeError(f"no depth source answered: {last!r}")


def main(argv: list[str] | None = None) -> None:
    import argparse
    import time

    ap = argparse.ArgumentParser(description="Bake sea state and depth for the 3D view")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("seastate", help="wave partitions for a season (or given months)")
    s.add_argument("year", type=int)
    s.add_argument("--months", type=int, nargs="*", default=list(range(SEASON[0], SEASON[1] + 1)))
    s.add_argument("--out", default="site/seastate")
    s.add_argument("--workers", type=int, default=8)
    d = sub.add_parser("depth", help="Chesapeake-Delmarva elevation")
    d.add_argument("--out", default="site/seastate")
    a = ap.parse_args(argv)
    if a.cmd == "seastate":
        store = _open_store()
        for m in a.months:
            t0 = time.monotonic()
            js, bz = bake_month(a.year, m, a.out, workers=a.workers, store=store)
            h, planes = read_grid(js.with_suffix(""))
            hs = unpack(planes[:, 0], 0.01)
            sw = unpack(planes[:, 3], 0.01)
            print(
                f"{h['month']}: {bz.stat().st_size / 1e6:.2f} MB, {h['nt']} times, "
                f"{h['nlat']}x{h['nlon']}, wind sea max {np.nanmax(hs):.1f} m, "
                f"swell max {np.nanmax(sw):.1f} m, {time.monotonic() - t0:.0f} s"
            )
        write_index(a.out)
    else:
        bake_depth(a.out)


if __name__ == "__main__":
    main()
