"""Ship traffic density along the route (issue #13).

EnvState.ship_density is the number of ships per km^2 at any given moment
(Maya's ruling). The vessel model turns that into ship-strike odds per hour.

Sources (both free, no account; reachable from GitHub Actions, not from
thread sandboxes):

1. EMODnet Human Activities, Vessel Density, all ship types, annual
   averages (https://emodnet.ec.europa.eu/en/human-activities; WCS coverage
   emodnet__vesseldensity_allavg). 1 km grid over EU waters and some
   neighbouring sea, which on our route means the European approaches, the
   Azores and part of the eastern Atlantic. Units: hours of ship presence
   per km^2 per month. Divided by the hours in an average month (730.5),
   that is exactly the average number of ships in each km^2 at any moment.
   No conversion guesswork.

2. World Bank / IMF Global Shipping Traffic Density (Cerdeiro et al. 2020;
   https://datacatalog.worldbank.org/search/dataset/0037580). 0.005 degree
   grid, counts of AIS position reports, Jan 2015 to Feb 2021, worldwide.
   Used where EMODnet has no data (the US side and the open ocean), after
   two corrections:
     a. The file contains isolated spurious cells of ~1.7 million and ~25
        million whose values drift steadily with row number (seen in the
        #13 probe, PR #62), each surrounded by counts of 0 to 5. A cell far
        above all eight of its neighbours is treated as no data (_spikes).
        A plain threshold does not work: real lane and port cells near the
        Bay mouth also pass 100,000.
     b. Position counts are not ships per km^2: they depend on how often
        AIS was received. We calibrate them against EMODnet where both
        exist (see calibrate()), and record the factor and its spread.

Stored result: one NetCDF on a 0.1 degree grid over the route box, built by
build() (python -m boatsim.oceandata build-ships) in GitHub Actions and
cached under data/traffic/.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from boatsim.oceandata.grid import ROUTE_BOX, Box, GridSeries

DEFAULT_PATH = Path(os.environ.get("BOATSIM_DATA", "data")) / "traffic" / "ship_density_v1.nc"
HOURS_PER_MONTH = 730.5
RES = 0.1  # degrees
BAD_COUNT = 100_000  # only for the log: how many real cells are this busy
SPIKE_MIN = 10_000  # GUESS: below this a lone high cell could be a real anchored ship
SPIKE_FACTOR = 100.0  # GUESS: spikes are 10^5 to 10^7 times their neighbours
EMODNET_WCS = "https://ows.emodnet-humanactivities.eu/wcs"
EMODNET_YEARS = (2022, 2023)  # 2020 had COVID-era traffic; 2024 lost satellite AIS from June
WORLD_BANK_ZIP = (
    "https://datacatalogfiles.worldbank.org/ddh-published/0037580/DR0045406/shipdensity_global.zip"
)
WB_YEARS = 6.16  # Jan 2015 to Feb 2021


def grid_axes(box: Box = ROUTE_BOX, res: float = RES) -> tuple[np.ndarray, np.ndarray]:
    lats = np.round(np.arange(box.lat_min + res / 2, box.lat_max, res), 6)
    lons = np.round(np.arange(box.lon_min + res / 2, box.lon_max, res), 6)
    return lats, lons


def _bin(lat, lon, values, box: Box, res: float, shape):
    """Sum and count of values per 0.1 degree cell (NaN not counted in sum)."""
    i = np.floor((lat - box.lat_min) / res).astype(int)
    j = np.floor((lon - box.lon_min) / res).astype(int)
    ok = (i >= 0) & (i < shape[0]) & (j >= 0) & (j < shape[1])
    i, j, v = i[ok], j[ok], values[ok]
    total = np.zeros(shape)
    n_all = np.zeros(shape)
    n_valid = np.zeros(shape)
    np.add.at(n_all, (i, j), 1)
    good = np.isfinite(v)
    np.add.at(total, (i[good], j[good]), v[good])
    np.add.at(n_valid, (i[good], j[good]), 1)
    return total, n_valid, n_all


# ----------------------------------------------------------------- EMODnet


def emodnet_grid(box: Box = ROUTE_BOX, res: float = RES, tile_deg: float = 5.0, log=print):
    """Mean ships/km^2 per 0.1 degree cell from EMODnet, NaN where no data.

    Returns (mean_valid, valid_fraction): the mean over 1 km pixels that have
    a value, and the share of pixels in the cell that have one.
    """
    import requests
    from pyproj import Transformer
    from rasterio.io import MemoryFile

    lats, lons = grid_axes(box, res)
    shape = (len(lats), len(lons))
    total = np.zeros(shape)
    n_valid = np.zeros(shape)
    n_all = np.zeros(shape)
    fwd = Transformer.from_crs(4326, 3857, always_xy=True)
    inv = Transformer.from_crs(3857, 4326, always_xy=True)
    n_px = n_nan = n_zero = 0
    for year in EMODNET_YEARS:
        for s in np.arange(box.lat_min, box.lat_max, tile_deg):
            for w in np.arange(box.lon_min, box.lon_max, tile_deg):
                n, e = min(s + tile_deg, box.lat_max), min(w + tile_deg, box.lon_max)
                x0, y0 = fwd.transform(w, s)
                x1, y1 = fwd.transform(e, n)
                params = [
                    ("SERVICE", "WCS"),
                    ("VERSION", "2.0.1"),
                    ("REQUEST", "GetCoverage"),
                    ("COVERAGEID", "emodnet__vesseldensity_allavg"),
                    ("FORMAT", "image/tiff"),
                    ("SUBSET", f"X({x0},{x1})"),
                    ("SUBSET", f"Y({y0},{y1})"),
                    ("SUBSET", f'time("{year}-01-01T00:00:00.000Z")'),
                ]
                r = requests.get(EMODNET_WCS, params=params, timeout=600)
                if r.status_code != 200 or not r.content.startswith((b"II*", b"MM\x00")):
                    continue  # outside EMODnet's coverage
                with MemoryFile(r.content) as mf, mf.open() as t:
                    a = t.read(1).astype(np.float64)
                    if t.nodata is not None:
                        a[a == t.nodata] = np.nan
                    a[a < 0] = np.nan
                    n_px += a.size
                    n_nan += int(np.isnan(a).sum())
                    n_zero += int((a == 0).sum())
                    rows, cols = np.indices(a.shape)
                    xs, ys = t.xy(rows.ravel(), cols.ravel())
                lo, la = inv.transform(np.asarray(xs), np.asarray(ys))
                t_, v_, a_ = _bin(la, lo, a.ravel() / HOURS_PER_MONTH, box, res, shape)
                total += t_
                n_valid += v_
                n_all += a_
        log(f"EMODnet {year}: done")
    # If valid pixels are never exactly 0, the blanks probably mean "no ships"
    # rather than "no data", and mean_valid overstates quiet water.
    log(f"EMODnet pixels: {n_px}, blank {n_nan / max(n_px, 1):.1%}, exactly zero {n_zero}")
    with np.errstate(invalid="ignore", divide="ignore"):
        mean_valid = np.where(n_valid > 0, total / n_valid, np.nan)
        frac = np.where(n_all > 0, n_valid / n_all, 0.0)
    return mean_valid, frac


# -------------------------------------------------------------- World Bank


def _spikes(a: np.ndarray, factor: float = SPIKE_FACTOR) -> np.ndarray:
    """Cells far above all 8 neighbours: the file's spurious values.

    The bad cells are single pixels (~1.7 million or ~25 million, drifting
    with row number) surrounded by counts of 0 to 5. A shipping lane or port
    is high too, but so are its neighbours along the lane, so it survives.
    """
    z = np.where(np.isfinite(a), a, 0.0)
    p = np.pad(z, 1)
    h, w = z.shape
    nb = np.zeros_like(z)
    for di in (0, 1, 2):
        for dj in (0, 1, 2):
            if di == 1 and dj == 1:
                continue
            nb = np.maximum(nb, p[di : di + h, dj : dj + w])
    return np.isfinite(a) & (a >= SPIKE_MIN) & (a > factor * (nb + 1.0))


def world_bank_grid(tif: str | Path, box: Box = ROUTE_BOX, res: float = RES, log=print):
    """AIS positions per km^2 per year per 0.1 degree cell, plus ocean fraction.

    Reads the route box in strips so memory stays small.
    """
    import rasterio
    from rasterio.windows import from_bounds

    lats, lons = grid_axes(box, res)
    shape = (len(lats), len(lons))
    pos = np.zeros(shape)
    n_ok = np.zeros(shape)
    n_all = np.zeros(shape)
    n_bad = n_big = 0
    with rasterio.open(tif) as r:
        step = 1.0  # degree strips of latitude
        for s in np.arange(box.lat_min, box.lat_max, step):
            win = from_bounds(box.lon_min, s, box.lon_max, s + step, r.transform).round_offsets()
            a = r.read(1, window=win).astype(np.float64)
            a[a == r.nodata] = np.nan
            bad = _spikes(a)
            n_bad += int(bad.sum())
            a[bad] = np.nan
            n_big += int((a >= BAD_COUNT).sum())
            t = r.window_transform(win)
            rows, cols = np.indices(a.shape)
            lo = t.c + (cols + 0.5) * t.a
            la = t.f + (rows + 0.5) * t.e
            t_, v_, a_ = _bin(la.ravel(), lo.ravel(), a.ravel(), box, res, shape)
            pos += t_
            n_ok += v_
            n_all += a_
    log(
        f"World Bank: {n_bad} isolated spikes dropped in the route box; "
        f"{n_big} real cells of {BAD_COUNT} or more kept (busy lanes and ports)"
    )
    # Cell area of one 0.005 degree pixel at the cell's latitude.
    km_per_deg = 111.32
    px_km2 = (0.005 * km_per_deg) ** 2 * np.cos(np.deg2rad(lats))[:, None]
    with np.errstate(invalid="ignore", divide="ignore"):
        per_km2_year = np.where(n_ok > 0, pos / (n_ok * px_km2) / WB_YEARS, np.nan)
        frac = np.where(n_all > 0, n_ok / n_all, 0.0)
    return per_km2_year, frac


# ------------------------------------------------------------- calibration


def calibrate(emod: np.ndarray, emod_frac: np.ndarray, wb: np.ndarray, lats, lons, log=print):
    """Factor k with ships/km^2 = k x (AIS positions per km^2 per year).

    Uses 0.1 degree cells where EMODnet covers at least half the cell and
    both have traffic. Reports the factor by region and by traffic level, so
    a reviewer can see whether one factor fits coast and open ocean alike.
    """
    ok = (emod_frac >= 0.5) & np.isfinite(emod) & (emod > 0) & np.isfinite(wb) & (wb > 0)
    ratio = np.where(ok, emod / np.where(wb > 0, wb, 1.0), np.nan)
    k = float(np.nanmedian(ratio))
    log(f"calibration cells: {int(ok.sum())}; median k = {k:.3e}")
    # Same, if EMODnet's blank pixels mean "no ships" (mean over all pixels).
    k_blank0 = float(
        np.nanmedian(np.where(ok, emod * emod_frac / np.where(wb > 0, wb, 1.0), np.nan))
    )
    log(f"  if blank EMODnet pixels mean zero ships: median k = {k_blank0:.3e}")
    lat2, lon2 = np.meshgrid(lats, lons, indexing="ij")
    regions = {
        "Iberian approaches": (36, 44, -12, -6),
        "Azores": (36, 40.5, -32, -24),
        "Biscay/Channel approaches": (44, 51, -10, -3),
        "Ireland west": (50, 56, -16, -9),
        "open ocean east of 20W": (38, 50, -20, -12),
    }
    for name, (s, n, w, e) in regions.items():
        m = ok & (lat2 >= s) & (lat2 < n) & (lon2 >= w) & (lon2 < e)
        if m.any():
            q = np.nanpercentile(ratio[m], [25, 50, 75])
            log(
                f"  {name:28s} cells {int(m.sum()):5d}  k p25/p50/p75 = {q[0]:.2e} {q[1]:.2e} {q[2]:.2e}"
            )
    for lo_, hi_ in [(0, 10), (10, 100), (100, 1e3), (1e3, 1e4), (1e4, 1e9)]:
        m = ok & (wb >= lo_) & (wb < hi_)
        if m.any():
            log(
                f"  WB {lo_:>7g}-{hi_:<7g} pos/km2/yr: cells {int(m.sum()):5d}  median k {np.nanmedian(ratio[m]):.2e}"
            )
    return k, ratio


def build(out: Path = DEFAULT_PATH, wb_tif: str | Path | None = None, log=print) -> Path:
    """Build the 0.1 degree ship-density grid for the route box."""
    import xarray as xr

    lats, lons = grid_axes()
    emod, emod_frac = emodnet_grid(log=log)
    wb, _ = world_bank_grid(wb_tif, log=log)
    k, _ = calibrate(emod, emod_frac, wb, lats, lons, log=log)
    use_emod = (emod_frac >= 0.5) & np.isfinite(emod)
    ships = np.where(use_emod, emod, k * wb)
    ships = np.where(np.isfinite(ships), ships, 0.0)  # land or no data from either source
    source = np.where(use_emod, 1, np.where(np.isfinite(wb), 2, 0)).astype(np.int8)
    ds = xr.Dataset(
        {
            "ship_density": (("lat", "lon"), ships.astype(np.float32)),
            "source": (("lat", "lon"), source),
        },
        coords={"lat": lats, "lon": lons},
        attrs={
            "units": "ships per km^2 at any moment",
            "source_codes": "1 EMODnet vessel density; 2 World Bank AIS counts x k; 0 none",
            "k_ships_per_position_km2_year": k,
            "emodnet_years": str(EMODNET_YEARS),
            "built": datetime.now(UTC).isoformat(timespec="seconds"),
        },
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    ds.to_netcdf(out)
    for name, (la, lo) in {
        "drop point": (36.85, -75.7),
        "Gulf Stream 38N 70W": (38.0, -70.0),
        "mid-ocean 40N 45W": (40.0, -45.0),
        "Azores 38.5N 28W": (38.5, -28.0),
        "off Lisbon 38.7N 9.6W": (38.7, -9.6),
    }.items():
        i = int(np.argmin(abs(lats - la)))
        j = int(np.argmin(abs(lons - lo)))
        log(f"  {name:24s} {ships[i, j]:.2e} ships/km2 (source {source[i, j]})")
    return out


class ShipDensitySource:
    """Samples the stored grid (bilinear). No time variation yet."""

    def __init__(self, path: str | Path = DEFAULT_PATH):
        import xarray as xr

        with xr.open_dataset(path) as ds:
            f = ds["ship_density"].values.astype(np.float32)[None]
            self._g = GridSeries(
                np.array(["2000-01-01"], dtype="datetime64[s]"),
                ds.lat.values,
                ds.lon.values,
                {"ship_density": f},
            )

    def sample(self, lat: float, lon: float) -> float:
        lats, lons = self._g.lats, self._g.lons
        lat = min(max(lat, lats[0]), lats[-1])
        lon = min(max(lon, lons[0]), lons[-1])
        v = self._g.sample(self._g.times[0], lat, lon, ["ship_density"])["ship_density"]
        return v if np.isfinite(v) else 0.0


def default_source(path: str | Path = DEFAULT_PATH) -> ShipDensitySource | None:
    """The built map if it is in the data folder, else None (no ship traffic) with a warning."""
    if Path(path).exists():
        return ShipDensitySource(path)
    import warnings

    warnings.warn(
        f"{path} not found: running with no ship traffic. Build it with the "
        '"Build ship density" workflow and put it there.',
        stacklevel=2,
    )
    return None
