"""How strong does ERA5 make tropical storms? A check against IBTrACS (issue #13).

The simulator's wind and waves come from ERA5. ERA5's 0.25 degree grid
(about 25 km) is coarser than a hurricane's core, so it is known to
understate peak winds. This check measures by how much on our route box, so
we know whether the knockdown risk near storms needs a correction.

Reference: IBTrACS v04r01 North Atlantic (Knapp et al. 2010,
doi:10.1175/2009BAMS2755.1; https://www.ncei.noaa.gov/products/international-best-track-archive),
free, no account; reachable from GitHub Actions, not from thread sandboxes.
We use the US National Hurricane Center's columns: USA_WIND (maximum 1-minute
sustained wind at 10 m, knots) and USA_SSHS (Saffir-Simpson category: 0 tropical storm, 1 to 5 hurricane
categories; negative codes are tropical depressions, subtropical and
post-tropical systems and disturbances).

Method, for every 6-hourly best-track point inside the route box:
    ERA5 peak = the highest hourly 10 m wind speed on ERA5 grid points within
    RADIUS_KM of the storm centre, at that hour.
    ratio = ERA5 peak / best-track maximum wind.
ERA5 winds are hourly values, closer to a 10-minute mean than a 1-minute
peak; the usual 1-minute to 10-minute factor at sea is about 0.93 (WMO
guidelines on wind averaging, WMO/TD-1555, 2010), so a ratio of 0.93 would be
perfect agreement and anything below it is ERA5 undershooting.
"""

from __future__ import annotations

import math
import os
from datetime import date, datetime
from functools import lru_cache
from pathlib import Path

import numpy as np

from boatsim.oceandata.grid import ROUTE_BOX, Box

IBTRACS_NA = (
    "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/"
    "v04r01/access/csv/ibtracs.NA.list.v04r01.csv"
)
KNOT = 0.514444  # m/s
RADIUS_KM = 200.0  # GUESS: wide enough to catch the peak despite track position error
ONE_TO_TEN_MIN = 0.93  # WMO/TD-1555 at-sea gust factor, 1-minute to 10-minute mean


def load_ibtracs(csv, first_year: int, last_year: int, box: Box = ROUTE_BOX):
    """Best-track points (6-hourly synoptic times) in the box with a USA wind."""
    import pandas as pd

    df = pd.read_csv(
        csv,
        skiprows=[1],  # the second row holds units
        usecols=["SID", "SEASON", "NAME", "ISO_TIME", "LAT", "LON", "USA_WIND", "USA_SSHS"],
        na_values=[" ", ""],
        keep_default_na=False,
        low_memory=False,
    )
    df["time"] = pd.to_datetime(df["ISO_TIME"])
    for c in ("LAT", "LON", "USA_WIND", "USA_SSHS", "SEASON"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df[
        df.SEASON.between(first_year, last_year)
        & df.time.dt.hour.isin([0, 6, 12, 18])
        & (df.time.dt.minute == 0)
        & df.USA_WIND.notna()
        & df.LAT.between(box.lat_min, box.lat_max)
        & df.LON.between(box.lon_min, box.lon_max)
    ]
    return df.reset_index(drop=True)


def era5_peak_near(tile, t64, lat: float, lon: float, radius_km: float = RADIUS_KM):
    """Highest 10 m wind speed (m/s) and wave height (m) on ERA5 grid points
    within radius_km of (lat, lon) at time t64. tile is an era5 GridSeries."""
    it = int(np.searchsorted(tile.times, t64))
    if it >= len(tile.times) or tile.times[it] != t64:
        return math.nan, math.nan
    dlat = radius_km / 111.0
    dlon = dlat / max(math.cos(math.radians(lat)), 0.2)
    i = np.where(np.abs(tile.lats - lat) <= dlat)[0]
    j = np.where(np.abs(tile.lons - lon) <= dlon)[0]
    if not len(i) or not len(j):
        return math.nan, math.nan
    la, lo = np.meshgrid(tile.lats[i], tile.lons[j], indexing="ij")
    dy = (la - lat) * 111.0
    dx = (lo - lon) * 111.0 * np.cos(np.radians(lat))
    near = np.hypot(dx, dy) <= radius_km
    u = tile.fields["wind_u"][it][np.ix_(i, j)]
    v = tile.fields["wind_v"][it][np.ix_(i, j)]
    hs = tile.fields["hs"][it][np.ix_(i, j)]
    speed = np.where(near, np.hypot(u, v), np.nan)
    hs = np.where(near, hs, np.nan)
    return float(np.nanmax(speed)), (float(np.nanmax(hs)) if np.isfinite(hs).any() else math.nan)


def storm_days(df) -> list[date]:
    return sorted({t.date() for t in df.time})


def compare(df, era5_source) -> object:
    """Adds era5_peak (m/s), era5_hs_max (m), best_ms (m/s) and ratio columns."""
    peaks, waves = [], []
    for t, la, lo in zip(df.time, df.LAT, df.LON, strict=True):
        dt = t.to_pydatetime()
        tile = era5_source._tiles.get(dt.date())
        p, h = era5_peak_near(tile, np.datetime64(dt, "ns"), float(la), float(lo))
        peaks.append(p)
        waves.append(h)
    out = df.copy()
    out["best_ms"] = out.USA_WIND * KNOT
    out["era5_peak"] = peaks
    out["era5_hs_max"] = waves
    out["ratio"] = out.era5_peak / out.best_ms
    return out


CLASSES = [
    ("below storm strength or post-tropical", -99, -1),
    ("tropical storm (34-63 kt)", 0, 0),
    ("hurricane cat 1-2 (64-95 kt)", 1, 2),
    ("major hurricane cat 3-5 (96+ kt)", 3, 5),
]


def summarise(res, log=print) -> list[dict]:
    """Median ERA5/best-track ratio per storm class, plus a plain verdict."""
    rows = []
    log(f"{len(res)} best-track points, {res.SID.nunique()} storms, inside the route box")
    log(f"(perfect agreement = {ONE_TO_TEN_MIN}: ERA5 is roughly a 10-minute mean)")
    for name, lo, hi in CLASSES:
        m = res.USA_SSHS.between(lo, hi) & np.isfinite(res.ratio)
        if not m.any():
            continue
        r = res.ratio[m]
        row = {
            "class": name,
            "points": int(m.sum()),
            "best_track_ms_median": float(res.best_ms[m].median()),
            "era5_peak_ms_median": float(res.era5_peak[m].median()),
            "ratio_p25": float(r.quantile(0.25)),
            "ratio_median": float(r.median()),
            "ratio_p75": float(r.quantile(0.75)),
            "era5_hs_max_median": float(res.era5_hs_max[m].median()),
        }
        rows.append(row)
        log(
            f"  {name:36s} n={row['points']:4d}  best {row['best_track_ms_median']:5.1f} m/s"
            f"  ERA5 {row['era5_peak_ms_median']:5.1f} m/s  ratio {row['ratio_p25']:.2f}"
            f" / {row['ratio_median']:.2f} / {row['ratio_p75']:.2f}"
            f"  ERA5 max Hs {row['era5_hs_max_median']:.1f} m"
        )
    worst = res.loc[res.best_ms.idxmax()] if len(res) else None
    if worst is not None:
        log(
            f"strongest point: {worst.NAME} {worst.time:%Y-%m-%d %H}Z {worst.LAT:.1f}N "
            f"{worst.LON:.1f}E best {worst.best_ms:.0f} m/s, ERA5 {worst.era5_peak:.0f} m/s"
        )
    return rows


def run(csv, first_year: int, last_year: int, workers: int = 4, log=print):
    from boatsim.oceandata import era5

    df = load_ibtracs(csv, first_year, last_year)
    days = storm_days(df)
    log(f"{len(days)} storm days to fetch from ERA5 ({first_year}-{last_year})")
    era5.fetch_days(days, workers=workers)
    src = era5.ERA5Source(fetch=False, max_tiles=2)
    res = compare(df, src)
    return res, summarise(res, log=log)


# ------------------------------------------------- voyages meeting a storm

DEFAULT_TRACKS = (
    Path(os.environ.get("BOATSIM_DATA", "data")) / "storms" / "ibtracs.NA.list.v04r01.csv"
)
_EPOCH = datetime(1970, 1, 1)
NEAR_KM = 200.0  # GUESS: inside this a hurricane's gales and big seas reach the boat


class HurricaneTracks:
    """IBTrACS best-track points indexed by 6-hour slot, for fast lookups of
    "how close was the nearest storm at this moment"."""

    def __init__(self, csv=DEFAULT_TRACKS, first_year: int = 1980, last_year: int = 2100):
        df = load_ibtracs(csv, first_year, last_year)
        secs = (df.time - _EPOCH).dt.total_seconds().to_numpy()
        slot = np.round(secs / 21600.0).astype(int)
        self._by_slot: dict[int, tuple[np.ndarray, ...]] = {}
        for s in np.unique(slot):
            m = slot == s
            self._by_slot[int(s)] = (
                df.LAT.to_numpy()[m],
                df.LON.to_numpy()[m],
                df.USA_SSHS.to_numpy()[m],
                df.NAME.to_numpy()[m],
            )

    def nearest(self, t: datetime, lat: float, lon: float, min_sshs: int = 1):
        """(km, name) of the nearest storm of at least category min_sshs at the
        best-track time closest to t (within 3 hours), or (inf, "")."""
        s = round((t.replace(tzinfo=None) - _EPOCH).total_seconds() / 21600.0)  # times are UTC
        pts = self._by_slot.get(s)
        if pts is None:
            return math.inf, ""
        la, lo, cat, name = pts
        m = cat >= min_sshs
        if not m.any():
            return math.inf, ""
        dy = (la[m] - lat) * 111.0
        dx = (lo[m] - lon) * 111.0 * math.cos(math.radians(lat))
        d = np.hypot(dx, dy)
        i = int(np.argmin(d))
        return float(d[i]), str(name[m][i])


def encounter(rows, tracks: HurricaneTracks, near_km: float = NEAR_KM) -> dict:
    """Per-voyage storm fields from logged rows (t, lat, lon): closest approach
    to a hurricane and to a tropical storm or stronger, and hours spent within
    near_km of a hurricane."""
    best_h, best_ts, name = math.inf, math.inf, ""
    hours = 0.0
    prev_t = None
    for r in rows:
        dh, nm = tracks.nearest(r["t"], r["lat"], r["lon"], min_sshs=1)
        dts, _ = tracks.nearest(r["t"], r["lat"], r["lon"], min_sshs=0)
        if dh < best_h:
            best_h, name = dh, nm
        best_ts = min(best_ts, dts)
        if prev_t is not None and dh <= near_km:
            hours += (r["t"] - prev_t).total_seconds() / 3600.0
        prev_t = r["t"]
    return {
        "hurricane_min_km": best_h,
        "hurricane_name": name,
        "hurricane_hours_near": hours,
        "storm_min_km": best_ts,
    }


@lru_cache(maxsize=2)
def default_tracks(path=DEFAULT_TRACKS) -> HurricaneTracks | None:
    """The IBTrACS file if downloaded (the batch workflows fetch it), else None.
    Cached, so each worker process reads it once."""
    return HurricaneTracks(path) if Path(path).exists() else None
