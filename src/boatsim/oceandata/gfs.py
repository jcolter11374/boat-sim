"""Today's weather for the 3D view: the latest NOAA GFS forecast (display only).

Every 6 hours NOAA issues a new run ("cycle") of its global model, GFS, and of
the wave model coupled to it, GFS-Wave (WAVEWATCH III). This module takes the
newest complete cycle from NOAA's open data on AWS (no account or key:
https://registry.opendata.aws/noaa-gfs-bdp-pds/) and bakes the first five days
over the sandbox corridor into the same file layout as seastate.py, so the 3D
sea and the helm can show "now" with a small change to the reader they
already have (sea3d/src/seastate.ts).

Only the needed fields are downloaded: each GRIB2 file has a text index (.idx)
giving every field's byte offset, so we ask for those byte ranges alone (about
6 MB per time step, not the whole files).

Fields, every 3 hours from the cycle time (f000) to 120 h ahead (f120):

    wind_u, wind_v  10 m wind, m/s, the direction the wind blows TOWARDS
                    (u east, v north). 1 deg atmosphere file, pgrb2.1p00.
    cloud           total cloud cover, 0-1 (TCDC, entire atmosphere).
    rain            rain rate, mm/h (PRATE x 3600; instantaneous).
    ws_hs/tp/dir    wind sea: WVHGT, WVPER, WVDIR (global.0p25 wave file).
    s1_*, s2_*      swell partitions 1 and 2: SWELL, SWPER, SWDIR
                    "1 in sequence" and "2 in sequence".

Checked on the 2026-11-11 00 UTC run, f003, over the corridor:

* Wave directions are where waves come FROM, degrees true, as in seastate.py:
  where the wind sea is over 1 m it comes from within a median 3 degrees of
  where the wind comes from (836 points).
* Wave periods are PEAK periods, despite NCEP's "mean period" label: where one
  system holds over 85% of the energy its period equals the whole sea's peak
  period PERPW (median ratio 1.000, 416 wind-sea and 174 swell points). So the
  fields are named *_tp, not *_tm like seastate.py's ERA5 mean periods, and
  need no Tp/Tm01 factor.

Files (written to --out, published on the forecast-data release):

    forecast_latest.json     header as seastate_YYYY-MM.json, plus "issued"
    forecast_latest.bin.gz   int16 [time][field][lat][lon], 41 times
    forecast_index.json      {"issued": ..., "file": "forecast_latest", ...}

A FORECAST, not observations: the page must say when it was issued.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np

from boatsim.oceandata.grid import Box
from boatsim.oceandata.seastate import CORRIDOR, RES, pack, write_grid

BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
HOURS = range(0, 121, 3)
CYCLE_HOURS = (0, 6, 12, 18)

ATTRIBUTION = (
    "NOAA Global Forecast System (GFS) and GFS-Wave (WAVEWATCH III), NOAA/NWS/NCEP, "
    "public domain, from the NOAA Open Data Dissemination program on AWS "
    "(https://registry.opendata.aws/noaa-gfs-bdp-pds/). Thinned and quantised by us. "
    "A forecast, not observations."
)

# (name, file, GRIB variable, level, units, scale, factor to our units)
FIELDS: list[tuple[str, str, str, str, str, float, float]] = [
    ("wind_u", "atmos", "UGRD", "10 m above ground", "m/s towards east", 0.01, 1.0),
    ("wind_v", "atmos", "VGRD", "10 m above ground", "m/s towards north", 0.01, 1.0),
    ("cloud", "atmos", "TCDC", "entire atmosphere", "fraction", 0.001, 0.01),
    ("rain", "atmos", "PRATE", "surface", "mm/h", 0.01, 3600.0),
    ("ws_hs", "wave", "WVHGT", "surface", "m", 0.01, 1.0),
    ("ws_tp", "wave", "WVPER", "surface", "s", 0.01, 1.0),
    ("ws_dir", "wave", "WVDIR", "surface", "deg from, true", 0.1, 1.0),
    ("s1_hs", "wave", "SWELL", "1 in sequence", "m", 0.01, 1.0),
    ("s1_tp", "wave", "SWPER", "1 in sequence", "s", 0.01, 1.0),
    ("s1_dir", "wave", "SWDIR", "1 in sequence", "deg from, true", 0.1, 1.0),
    ("s2_hs", "wave", "SWELL", "2 in sequence", "m", 0.01, 1.0),
    ("s2_tp", "wave", "SWPER", "2 in sequence", "s", 0.01, 1.0),
    ("s2_dir", "wave", "SWDIR", "2 in sequence", "deg from, true", 0.1, 1.0),
]


def url(cycle: datetime, kind: str, hour: int) -> str:
    d, hh = cycle.strftime("%Y%m%d"), f"{cycle.hour:02d}"
    if kind == "atmos":
        return f"{BASE}/gfs.{d}/{hh}/atmos/gfs.t{hh}z.pgrb2.1p00.f{hour:03d}"
    return f"{BASE}/gfs.{d}/{hh}/wave/gridded/gfswave.t{hh}z.global.0p25.f{hour:03d}.grib2"


def _get(u: str, byte_range: tuple[int, int | None] | None = None) -> bytes:
    req = urllib.request.Request(u, headers={"User-Agent": "boat-sim-forecast"})
    if byte_range:
        a, b = byte_range
        req.add_header("Range", f"bytes={a}-{'' if b is None else b - 1}")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


# ----------------------------------------------------------------- index


@dataclass(frozen=True)
class Entry:
    var: str
    level: str
    fcst: str
    start: int
    end: int | None  # exclusive; None = to the end of the file


def parse_idx(text: str) -> list[Entry]:
    """'n:offset:d=YYYYMMDDHH:VAR:level:fcst:' lines -> entries with byte spans."""
    rows = []
    for line in text.splitlines():
        p = line.split(":")
        if len(p) >= 6 and p[1].isdigit():
            rows.append((int(p[1]), p[3], p[4], p[5]))
    return [
        Entry(var, lev, fc, off, rows[k + 1][0] if k + 1 < len(rows) else None)
        for k, (off, var, lev, fc) in enumerate(rows)
    ]


def _fcst_ok(fcst: str, hour: int) -> bool:
    """Instantaneous values only: 'anl' at f000, 'N hour fcst' after (not averages)."""
    return fcst == "anl" if hour == 0 else fcst == f"{hour} hour fcst"


def pick(entries: list[Entry], var: str, level: str, hour: int) -> Entry | None:
    for e in entries:
        if e.var == var and e.level == level and _fcst_ok(e.fcst, hour):
            return e
    # The wave files label f000 "0 hour fcst" rather than "anl"; accept either.
    if hour == 0:
        for e in entries:
            if e.var == var and e.level == level and e.fcst == "0 hour fcst":
                return e
    return None


# ----------------------------------------------------------------- cycle


def cycle_complete(cycle: datetime, get=_get) -> bool:
    """Every file we need is out. NOAA writes the hours slightly out of order
    (on 11 Nov 2026 the 00 UTC f120 was out while f111 wasn't), so the last
    hour alone isn't enough: check every index."""

    def have(kh: tuple[str, int]) -> bool:
        try:
            return bool(get(url(cycle, kh[0], kh[1]) + ".idx"))
        except (urllib.error.URLError, OSError):
            return False

    # The last hour first: a cycle still running fails there in one request.
    if not all(have((k, HOURS[-1])) for k in ("atmos", "wave")):
        return False
    with ThreadPoolExecutor(8) as ex:
        return all(ex.map(have, [(k, h) for h in HOURS for k in ("atmos", "wave")]))


def latest_cycle(now: datetime | None = None, get=_get, tries: int = 6) -> datetime:
    """The newest cycle whose 120 h files are out (usually about 4-5 h after it)."""
    now = (now or datetime.now(UTC)).replace(tzinfo=None)
    c = now.replace(hour=now.hour - now.hour % 6, minute=0, second=0, microsecond=0)
    for _ in range(tries):
        if cycle_complete(c, get):
            return c
        c -= timedelta(hours=6)
    raise RuntimeError(f"no complete GFS cycle in the last {tries * 6} h")


# ----------------------------------------------------------------- decode


def decode(msg: bytes) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """One GRIB2 message on a regular lat-lon grid -> (lats, lons, values[lat][lon]).

    Missing points (land in the wave files) become NaN.
    """
    import eccodes

    gid = eccodes.codes_new_from_message(msg)
    try:
        ni = eccodes.codes_get(gid, "Ni")
        nj = eccodes.codes_get(gid, "Nj")
        la0 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
        lo0 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
        dla = eccodes.codes_get(gid, "jDirectionIncrementInDegrees")
        dlo = eccodes.codes_get(gid, "iDirectionIncrementInDegrees")
        north = eccodes.codes_get(gid, "jScansPositively") == 1
        miss = eccodes.codes_get(gid, "missingValue")
        bitmap = eccodes.codes_get(gid, "bitmapPresent")
        v = eccodes.codes_get_values(gid).astype(np.float64).reshape(nj, ni)
    finally:
        eccodes.codes_release(gid)
    if bitmap:
        v[v == miss] = np.nan
    lats = la0 + (dla if north else -dla) * np.arange(nj)
    lons = lo0 + dlo * np.arange(ni)
    return lats, lons, v


def corridor_axes(box: Box = CORRIDOR, res: float = RES) -> tuple[np.ndarray, np.ndarray]:
    lat = np.arange(box.lat_min, box.lat_max + res / 2, res)
    lon = np.arange(box.lon_min, box.lon_max + res / 2, res)
    return lat, lon


def sample_corridor(
    lats: np.ndarray, lons: np.ndarray, v: np.ndarray, box: Box = CORRIDOR, res: float = RES
) -> np.ndarray:
    """Values at whole-degree points of the box, lat south->north, lon west->east.

    Picks grid points (no averaging: directions don't average) and checks they
    sit on the wanted latitudes and longitudes.
    """
    lat, lon = corridor_axes(box, res)
    dla, dlo = lats[1] - lats[0], lons[1] - lons[0]
    i = np.rint((lat - lats[0]) / dla).astype(int)
    j = np.rint(((lon - lons[0]) % 360.0) / dlo).astype(int)
    if (i < 0).any() or (i >= len(lats)).any() or (j >= len(lons)).any():
        raise ValueError("corridor outside the GRIB grid")
    if not np.allclose(lats[i], lat, atol=1e-4):
        raise ValueError("GRIB latitudes miss the whole degrees")
    if not np.allclose(((lons[j] + 180.0) % 360.0) - 180.0, lon, atol=1e-4):
        raise ValueError("GRIB longitudes miss the whole degrees")
    return v[np.ix_(i, j)]


# ----------------------------------------------------------------- bake


def bake_hour(cycle: datetime, hour: int, get=_get, dec=decode) -> np.ndarray:
    """All fields at one forecast hour -> int16 [field][lat][lon]."""
    idx = {k: parse_idx(get(url(cycle, k, hour) + ".idx").decode()) for k in ("atmos", "wave")}
    planes = []
    for name, kind, var, level, _, scale, factor in FIELDS:
        e = pick(idx[kind], var, level, hour)
        if e is None:
            raise ValueError(f"f{hour:03d}: no {var} {level} in the {kind} index")
        lats, lons, v = dec(get(url(cycle, kind, hour), (e.start, e.end)))
        planes.append(pack(sample_corridor(lats, lons, v) * factor, scale))
        if name == "cloud":  # TCDC can come out a hair over 100%
            planes[-1] = np.minimum(planes[-1], round(1.0 / scale))
    return np.stack(planes)


def bake(cycle: datetime, out_dir: Path, get=_get, dec=decode, workers: int = 8) -> Path:
    with ThreadPoolExecutor(workers) as ex:
        planes = np.stack(list(ex.map(lambda h: bake_hour(cycle, h, get, dec), HOURS)))
    lat, lon = corridor_axes()
    issued = cycle.strftime("%Y-%m-%dT%H:%MZ")
    header = {
        "kind": "forecast",
        "month": cycle.strftime("%Y-%m"),
        "issued": issued,
        "t0": issued,
        "step_h": HOURS.step,
        "nt": len(HOURS),
        "lat0": float(lat[0]),
        "lon0": float(lon[0]),
        "res": RES,
        "nlat": len(lat),
        "nlon": len(lon),
        "layout": "[time][field][lat][lon], lat south->north, lon west->east",
        "fields": [
            {"name": n, "grib": f"{v}:{lev}", "units": u, "scale": s}
            for n, _, v, lev, u, s, _ in FIELDS
        ],
        "wave_period": "peak period of each wave system (*_tp); no Tp/Tm01 factor",
        "notes": (
            "A FORECAST issued at 'issued' (GFS cycle time), not observations. Wind "
            "u/v blow TOWARDS east/north; wave directions are where waves come FROM, "
            "degrees true. No data (-32768) over land; at a sea point where another "
            "wave system has values, no data means that system is absent (height 0)."
        ),
        "attribution": ATTRIBUTION,
    }
    js, _ = write_grid(Path(out_dir) / "forecast_latest", header, planes)
    index = {
        "issued": issued,
        "file": "forecast_latest",
        "hours": HOURS[-1],
        "baked": datetime.now(UTC).strftime("%Y-%m-%dT%H:%MZ"),
        "attribution": ATTRIBUTION,
    }
    (Path(out_dir) / "forecast_index.json").write_text(json.dumps(index, indent=1))
    return js


def parse_issued(s: str) -> datetime | None:
    m = re.fullmatch(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)Z", (s or "").strip())
    return datetime(*map(int, m.groups())) if m else None


def main(argv: list[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Bake the latest GFS forecast for the 3D view")
    ap.add_argument("--out", default="site/forecast")
    ap.add_argument("--previous", default="", help="issue time already published; skip if same")
    ap.add_argument("--cycle", default="", help="YYYY-MM-DDTHH:00Z instead of the latest")
    a = ap.parse_args(argv)
    cycle = parse_issued(a.cycle) or latest_cycle()
    issued = cycle.strftime("%Y-%m-%dT%H:%MZ")
    if parse_issued(a.previous) == cycle:
        print(f"GFS {issued} is already published: nothing to do")
        return
    js = bake(cycle, Path(a.out))
    print(f"GFS {issued}: {js.with_suffix('.bin.gz').stat().st_size / 1e3:.0f} kB")


if __name__ == "__main__":
    main()
