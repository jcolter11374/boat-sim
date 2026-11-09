"""Our currents (GLORYS12) against the Randolph team's (SMOC), issue #73.

Both teams' routes now cross the same stretch of Gulf Stream (about 36-42N,
75-50W). The Randolph team gets currents from Open-Meteo's marine API, which
serves Mercator's SMOC: Copernicus Marine product
GLOBAL_ANALYSISFORECAST_PHY_001_024, dataset
cmems_mod_glo_phy_anfc_merged-uv_PT1H-i (hourly, 1/12 degree,
doi:10.48670/moi-00016). We use GLORYS12 daily means (glorys.py).

Like with like. SMOC gives three parts of the surface current:
    uo, vo         ocean-model current (the same kind of thing GLORYS gives)
    utide, vtide   tidal current
    vsdx, vsdy     Stokes drift (the push of the waves)
and utotal, vtotal = the sum. Tides reverse twice a day, so a daily mean
removes most of them; Stokes drift does not cancel. So we compare:
    "model":  GLORYS daily mean   vs  SMOC uo/vo daily mean     (model difference)
    "total":  GLORYS daily mean   vs  SMOC utotal/vtotal daily mean
              (what each simulator effectively drifts with, tides averaged out)

Both are block-averaged onto the same 0.25 degree grid, then summarised by
5 degree longitude band, so we can see whether disagreement builds up west
of 40W as the Randolph team's grid test suggested.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import numpy as np

from boatsim.oceandata.grid import Box

STRETCH = Box(36.0, 42.0, -75.0, -50.0)
SMOC_DATASET = "cmems_mod_glo_phy_anfc_merged-uv_PT1H-i"
RES = 0.25
DATES = [date(2023, m, 15) for m in (1, 3, 5, 7, 9, 11)]  # one mid-month day every 2 months
BANDS = [(-75, -70), (-70, -65), (-65, -60), (-60, -55), (-55, -50)]
MIN_SPEED = 0.2  # m/s: directions are compared only where both currents are this fast


def block_mean(a: np.ndarray, lats, lons, box: Box = STRETCH, res: float = RES):
    """Average a 2-D field (lat, lon) into res-degree cells over box (NaN-aware)."""
    nlat = round((box.lat_max - box.lat_min) / res)
    nlon = round((box.lon_max - box.lon_min) / res)
    i = np.floor((np.asarray(lats) - box.lat_min) / res).astype(int)
    j = np.floor((np.asarray(lons) - box.lon_min) / res).astype(int)
    ii, jj = np.meshgrid(i, j, indexing="ij")
    ok = (ii >= 0) & (ii < nlat) & (jj >= 0) & (jj < nlon) & np.isfinite(a)
    total = np.zeros((nlat, nlon))
    count = np.zeros((nlat, nlon))
    np.add.at(total, (ii[ok], jj[ok]), a[ok])
    np.add.at(count, (ii[ok], jj[ok]), 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(count > 0, total / count, np.nan)
    clats = box.lat_min + res * (np.arange(nlat) + 0.5)
    clons = box.lon_min + res * (np.arange(nlon) + 0.5)
    return out, clats, clons


def compare(u1, v1, u2, v2, lons, bands=BANDS) -> list[dict]:
    """Per longitude band: mean speeds, mean eastward current, RMS vector
    difference, and median direction difference where both are fast."""
    rows = []
    for w, e in [*bands, (bands[0][0], bands[-1][1])]:
        m = ((lons >= w) & (lons < e))[None, :] & np.isfinite(u1 + v1 + u2 + v2)
        if not m.any():
            continue
        s1, s2 = np.hypot(u1, v1), np.hypot(u2, v2)
        dvec = np.hypot(u1 - u2, v1 - v2)
        fast = m & (s1 >= MIN_SPEED) & (s2 >= MIN_SPEED)
        ddir = np.degrees(np.abs(np.angle(np.exp(1j * (np.arctan2(v1, u1) - np.arctan2(v2, u2))))))
        rows.append(
            {
                "band": "all" if (w, e) == (bands[0][0], bands[-1][1]) else f"{-w}W-{-e}W",
                "cells": int(m.sum()),
                "speed_glorys": float(np.mean(s1[m])),
                "speed_smoc": float(np.mean(s2[m])),
                "east_glorys": float(np.mean(u1[m])),
                "east_smoc": float(np.mean(u2[m])),
                "rms_vector_diff": float(np.sqrt(np.mean(dvec[m] ** 2))),
                "speed_corr": float(np.corrcoef(s1[m], s2[m])[0, 1]) if m.sum() > 2 else np.nan,
                "dir_diff_median_deg": float(np.median(ddir[fast])) if fast.any() else np.nan,
                "fast_cells": int(fast.sum()),
            }
        )
    return rows


# ------------------------------------------------------------- fetching


def _open(dataset_id: str, variables, start: datetime, end: datetime, box: Box = STRETCH):
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


def _surface(da):
    if "depth" in da.dims:
        da = da.isel(depth=0)
    return da


def glorys_day(day: date, opener=_open):
    """GLORYS daily-mean uo, vo for one day (stamped 00:00 of that day)."""
    from boatsim.oceandata.glorys import DATASETS

    t = datetime.combine(day, datetime.min.time())
    last = None
    for ds_id in DATASETS:
        try:
            ds = opener(ds_id, ["uo", "vo"], t, t)
        except Exception as e:  # noqa: BLE001  toolbox errors vary; try the next dataset
            last = e
            continue
        if ds.sizes.get("time", 0):
            ds = ds.isel(time=0)
            return (
                _surface(ds.uo).values,
                _surface(ds.vo).values,
                ds.latitude.values,
                ds.longitude.values,
            )
    raise ValueError(f"no GLORYS for {day}: {last!r}")


def smoc_day(day: date, opener=_open):
    """SMOC daily means over the 24 hourly fields of the day: model (uo, vo)
    and total (utotal, vtotal)."""
    t0 = datetime.combine(day, datetime.min.time())
    ds = opener(SMOC_DATASET, ["uo", "vo", "utotal", "vtotal"], t0, t0 + timedelta(hours=23))
    m = ds.mean("time")
    return {k: _surface(m[k]).values for k in ("uo", "vo", "utotal", "vtotal")}, (
        ds.latitude.values,
        ds.longitude.values,
        int(ds.sizes["time"]),
    )


def run(dates=DATES, opener=_open, log=print) -> list[dict]:
    out = []
    for day in dates:
        gu, gv, glat, glon = glorys_day(day, opener)
        s, (slat, slon, nh) = smoc_day(day, opener)
        g_u, _, clons = block_mean(gu, glat, glon)
        g_v, _, _ = block_mean(gv, glat, glon)
        log(f"{day}: GLORYS {gu.shape}, SMOC {s['uo'].shape} x {nh} hours -> 0.25 deg")
        for kind, (ku, kv) in {"model": ("uo", "vo"), "total": ("utotal", "vtotal")}.items():
            s_u, _, _ = block_mean(s[ku], slat, slon)
            s_v, _, _ = block_mean(s[kv], slat, slon)
            for r in compare(g_u, g_v, s_u, s_v, clons):
                out.append({"date": str(day), "kind": kind, **r})
    return out


def summarise(rows, log=print) -> None:
    import pandas as pd

    df = pd.DataFrame(rows)
    cols = [
        "speed_glorys",
        "speed_smoc",
        "east_glorys",
        "east_smoc",
        "rms_vector_diff",
        "speed_corr",
        "dir_diff_median_deg",
    ]
    for kind in ("model", "total"):
        t = df[df.kind == kind].groupby("band", sort=False)[cols].mean()
        log(f"\nGLORYS vs SMOC {kind} (m/s, mean over {df.date.nunique()} dates):")
        log(t.round(3).to_string())


OPEN_METEO = "https://marine-api.open-meteo.com/v1/marine"
POINTS = [(37.5, -72.0), (38.5, -68.0), (39.5, -62.0), (40.5, -55.0), (41.0, -51.0)]


def open_meteo_check(day: date, points=POINTS, opener=_open, log=print) -> list[dict]:
    """Is Open-Meteo's current SMOC's total current? Daily means at a few points."""
    import requests

    t0 = datetime.combine(day, datetime.min.time())
    ds = opener(SMOC_DATASET, ["utotal", "vtotal"], t0, t0 + timedelta(hours=23)).mean("time")
    rows = []
    for lat, lon in points:
        r = None
        for attempt in range(3):
            try:
                r = requests.get(
                    OPEN_METEO,
                    params={
                        "latitude": lat,
                        "longitude": lon,
                        "hourly": "ocean_current_velocity,ocean_current_direction",
                        "start_date": str(day),
                        "end_date": str(day),
                        "timezone": "GMT",
                    },
                    timeout=120,
                )
                break
            except requests.RequestException as e:
                log(f"Open-Meteo {lat},{lon}: attempt {attempt + 1} failed: {e!r}"[:200])
        if r is None:
            continue  # a side check only: the comparison above stands without it
        if r.status_code != 200:
            log(f"Open-Meteo {lat},{lon}: HTTP {r.status_code} {r.text[:200]}")
            continue
        h = r.json()["hourly"]
        spd = np.array(h["ocean_current_velocity"], dtype=float) / 3.6  # km/h -> m/s
        # Open-Meteo gives the direction the current flows TOWARDS, degrees true.
        rad = np.radians(np.array(h["ocean_current_direction"], dtype=float))
        om_u, om_v = np.nanmean(spd * np.sin(rad)), np.nanmean(spd * np.cos(rad))
        p = ds.sel(latitude=lat, longitude=lon, method="nearest")
        su, sv = float(_surface(p.utotal)), float(_surface(p.vtotal))
        rows.append(
            {"lat": lat, "lon": lon, "om_u": om_u, "om_v": om_v, "smoc_u": su, "smoc_v": sv}
        )
        log(
            f"  {lat:.1f}N {-lon:.1f}W  Open-Meteo u,v {om_u:+.2f} {om_v:+.2f}"
            f"   SMOC total u,v {su:+.2f} {sv:+.2f} m/s"
        )
    return rows
