"""How far to trust ERA5's waves and wind: a check against NDBC buoys (issue #10).

Reference: NOAA National Data Buoy Center moored buoys, historical "standard
meteorological" files (https://www.ndbc.noaa.gov/data/historical/stdmet/),
free, no account; reachable from GitHub Actions, not from thread sandboxes.
Columns used:
    WVHT  significant wave height (m), from the measured wave spectrum. This is
          the same quantity as ERA5's combined wind-sea-and-swell height.
    WSPD  wind speed (m/s), averaged over 8 minutes (2 minutes on some older
          records) at the anemometer, about 4 m above the sea on 3 m discus buoys
    WDIR  wind direction, degrees true, coming from
Missing values are 99, 999 or 9999.

Wind height. ERA5 gives wind at 10 m and the buoys measure lower down, where
the wind is weaker. We scale buoy wind to 10 m with the usual power law
u10 = u_z (10 / z)^0.11 (Hsu, Meindl and Gilhousen 1994, J. Appl. Meteor.
33, 757), with z = 4.1 m for every buoy (GUESS: the 3 m discus height; NDBC
lists each station's height on its station page). That is about +10%.

Matching. Buoy reports come at hh:50 (hh:00 on older records); each is matched
to ERA5 at the nearest whole hour at the buoy's position (bilinear on the
0.25 degree grid).
"""

from __future__ import annotations

import gzip
import io
import itertools
import math
import re
from datetime import date

import numpy as np

STDMET_URL = "https://www.ndbc.noaa.gov/data/historical/stdmet/{station}h{year}.txt.gz"
STATION_TABLE_URL = "https://www.ndbc.noaa.gov/data/stations/station_table.txt"
ANEMOMETER_M = 4.1  # GUESS, see module doc
POWER = 0.11

# Off Virginia and North Carolina, then offshore along and either side of the route.
STATIONS = {
    "44014": "Virginia Beach, 64 nm east",
    "44009": "Delaware Bay, 26 nm southeast of Cape May",
    "41025": "Diamond Shoals, off Cape Hatteras",
    "41001": "150 nm east of Cape Hatteras",
    "41002": "South Hatteras, 225 nm south of Cape Hatteras",
    "41048": "West Bermuda",
    "41049": "South Bermuda",
    "44008": "Nantucket, 54 nm southeast",
    "44011": "Georges Bank",
}


def parse_stdmet(text: str):
    """NDBC standard meteorological text -> DataFrame (time, wdir, wspd, wvht)."""
    import pandas as pd

    lines = [ln for ln in text.splitlines() if ln.strip()]
    header = lines[0].lstrip("#").split()
    body = [ln for ln in lines[1:] if not ln.startswith("#")]
    df = pd.read_csv(io.StringIO("\n".join(body)), sep=r"\s+", header=None, names=header)
    year = df["YY"] if "YY" in df else df["YYYY"]
    year = np.where(year < 100, year + 1900, year)
    minute = df.get("mm", 0)
    df["time"] = pd.to_datetime(
        {"year": year, "month": df["MM"], "day": df["DD"], "hour": df["hh"], "minute": minute}
    )
    out = pd.DataFrame({"time": df["time"]})
    for src, dst, bad in (("WDIR", "wdir", 999), ("WSPD", "wspd", 99), ("WVHT", "wvht", 99)):
        v = df[src].astype(float) if src in df else np.nan
        out[dst] = np.where(v >= bad, np.nan, v)
    return out


def parse_station_table(text: str) -> dict[str, tuple[float, float]]:
    """station id -> (lat, lon) from NDBC's station_table.txt."""
    pos = {}
    for ln in text.splitlines():
        if ln.startswith("#"):
            continue
        parts = ln.split("|")
        if len(parts) < 7:
            continue
        m = re.match(r"\s*([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])", parts[6])
        if m:
            lat = float(m.group(1)) * (1 if m.group(2) == "N" else -1)
            lon = float(m.group(3)) * (1 if m.group(4) == "E" else -1)
            pos[parts[0].strip().upper()] = (lat, lon)
    return pos


def to_10m(wspd, z: float = ANEMOMETER_M):
    return wspd * (10.0 / z) ** POWER


def hourly(df):
    """Nearest-hour buoy values, one per hour (the report closest to the hour)."""
    d = df.copy()
    d["hour"] = d.time.dt.round("h")
    d["off"] = (d.time - d.hour).abs()
    return d.sort_values("off").drop_duplicates("hour").sort_values("hour").set_index("hour")


def pair(df, era5, lat: float, lon: float):
    """Buoy hours joined with ERA5 at the buoy: wvht/hs and wind speed at 10 m."""
    h = hourly(df)
    e_hs, e_ws = [], []
    for t in h.index:
        s = era5.sample(t.to_pydatetime(), lat, lon)
        e_hs.append(s["hs"])
        e_ws.append(math.hypot(s["wind_u"], s["wind_v"]))
    h["era5_hs"] = e_hs
    h["era5_ws10"] = e_ws
    h["buoy_ws10"] = to_10m(h.wspd)
    return h


def stats(obs, mod) -> dict:
    ok = np.isfinite(obs) & np.isfinite(mod)
    o, m = np.asarray(obs)[ok], np.asarray(mod)[ok]
    if len(o) < 10:
        return {"n": len(o)}
    d = m - o
    return {
        "n": len(o),
        "obs_mean": float(o.mean()),
        "bias": float(d.mean()),
        "rmse": float(np.sqrt((d**2).mean())),
        "scatter_index": float(np.sqrt((d**2).mean()) / o.mean()),
        "corr": float(np.corrcoef(o, m)[0, 1]),
        "p99_ratio": float(np.percentile(m, 99) / np.percentile(o, 99)),
    }


def by_height(obs_hs, mod_hs, edges=(0, 1, 2, 3, 4, 6, 99)) -> list[dict]:
    """Bias of ERA5 Hs in bands of observed Hs: does ERA5 flatten the big seas?"""
    o, m = np.asarray(obs_hs), np.asarray(mod_hs)
    ok = np.isfinite(o) & np.isfinite(m)
    rows = []
    for lo, hi in itertools.pairwise(edges):
        b = ok & (o >= lo) & (o < hi)
        if b.sum() >= 10:
            rows.append(
                {
                    "band": f"{lo}-{hi} m",
                    "n": int(b.sum()),
                    "obs_mean": float(o[b].mean()),
                    "era5_mean": float(m[b].mean()),
                    "ratio": float(m[b].mean() / o[b].mean()) if lo > 0 else math.nan,
                }
            )
    return rows


def fetch_text(url: str) -> str:
    import requests

    r = requests.get(url, timeout=120)
    r.raise_for_status()
    data = r.content
    return gzip.decompress(data).decode() if url.endswith(".gz") else data.decode()


def run(year: int, stations=STATIONS, workers: int = 4, log=print):
    import pandas as pd

    from boatsim.oceandata import era5 as E

    pos = parse_station_table(fetch_text(STATION_TABLE_URL))
    log(f"Fetching ERA5 for {year} ...")
    E.fetch_days(E.days_between(date(year, 1, 1), date(year, 12, 31)), workers=workers)
    src = E.ERA5Source(max_tiles=3)  # fetches the odd day outside the year (23:50 Dec 31 -> Jan 1)
    pairs, rows, bands = [], [], []
    for sid, name in stations.items():
        if sid not in pos:
            log(f"{sid}: no position in the station table, skipped")
            continue
        lat, lon = pos[sid]
        try:
            df = parse_stdmet(fetch_text(STDMET_URL.format(station=sid.lower(), year=year)))
        except Exception as e:  # noqa: BLE001  a missing buoy-year is normal; report and go on
            log(f"{sid}: no {year} data ({e!r})"[:160])
            continue
        p = pair(df[df.time.dt.year == year], src, lat, lon)
        p["station"] = sid
        pairs.append(p)
        for var, o, m in (("hs", p.wvht, p.era5_hs), ("wind10", p.buoy_ws10, p.era5_ws10)):
            rows.append(
                {"station": sid, "name": name, "lat": lat, "lon": lon, "var": var, **stats(o, m)}
            )
        log(f"{sid} {name} ({lat:.2f}N {-lon:.2f}W): {int(p.wvht.notna().sum())} wave hours")
    allp = pd.concat(pairs)
    for var, o, m in (("hs", allp.wvht, allp.era5_hs), ("wind10", allp.buoy_ws10, allp.era5_ws10)):
        rows.append({"station": "all", "name": "all buoys", "var": var, **stats(o, m)})
    bands = by_height(allp.wvht, allp.era5_hs)
    return allp, pd.DataFrame(rows), pd.DataFrame(bands)


def report(table, bands, log=print) -> None:
    cols = [
        "station",
        "name",
        "n",
        "obs_mean",
        "bias",
        "rmse",
        "scatter_index",
        "corr",
        "p99_ratio",
    ]
    for var, unit in (("hs", "m"), ("wind10", "m/s")):
        t = table[table["var"] == var][[c for c in cols if c in table]]
        log(f"\nERA5 vs buoys, {var} ({unit}); bias = ERA5 - buoy:")
        log(t.round(3).to_string(index=False))
    log("\nERA5 wave height by observed wave height (all buoys):")
    log(bands.round(3).to_string(index=False))
