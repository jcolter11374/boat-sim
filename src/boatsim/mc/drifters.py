"""Drift check (issue #19): does our simulated ocean move things the way the real one does?

Real data: the NOAA Global Drifter Program (GDP) hourly dataset, v2.01.1
(Elipot et al. 2016, doi:10.1002/2016JC011716; NCEI doi:10.25921/x46c-3620),
read straight from NOAA's public AWS bucket. No account and no bulk download:
we read the per-drifter metadata and then only the rows of the drifters we use.

A drifter is a small float (about 35 cm across) that rides the current and
reports its position by satellite. Most hang a 6 m "drogue" (an underwater
sock) centred 15 m down, so they follow the water at that depth and are
barely pushed by wind. Some have lost the drogue, or never had one: those
"undrogued" floats sit at the surface and also feel the wind and waves, which
makes them a closer stand-in for a drifting kayak.

For each drifter we start three model objects at its first good position and
time and let them drift for N days through ReanalysisEnvironment
(ERA5 + GLORYS12), with 10-minute steps like the voyage runner:

* ``water``: moves with the GLORYS surface current only. The fair model for a
  drogued drifter. Tests the currents.
* ``float``: current plus the waves' Stokes drift (the slow push waves give
  anything at the surface). The fair model for an undrogued drifter.
* ``kayak``: the real KayakVessel with no thrust and hazards switched off:
  current, Stokes drift and wind on the hull. This is what the simulator does
  with a dead boat. No drifter is a kayak, so this one is reported, not judged.

Scores:

* separation: great-circle distance between model and drifter after 1, 3, 5
  and N days.
* skill (Liu and Weisberg 2011, doi:10.1029/2010JC006837): 1 minus the summed
  daily separation divided by the summed distance the drifter has travelled
  along its path since the start, floored at 0. 1 is a perfect track; 0 means
  the gaps are as big as the whole distance travelled. Unlike plain separation
  it is fair between slow and fast water.
* "stay put": the same scores for a model that never moves (its gap is the
  drifter's own distance from the start). A model that loses to this is worse
  than useless.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from boatsim.geo import distance_m, move
from boatsim.types import Command

GDP_URL = "https://noaa-oar-hourly-gdp-pds.s3.amazonaws.com/latest/gdp-v2.01.1.zarr"


@dataclass(frozen=True)
class DrifterCase:
    drifter_id: int
    note: str  # why it was picked; written for John
    start: str | None = None  # YYYY-MM-DD: start this far into the track (None: its first fix)


# Picked from every GDP drifter whose first good fix is between 33-39.5N and
# 77-71W from 1993 on (GLORYS starts in 1993; GDP hourly ends Oct 2022): 35 in
# all. Kept: the ones that lasted at least 10 days, spread over seasons and
# years, with both drogued and undrogued floats. drogue_lost_date in the GDP
# metadata equal to the start date means "no drogue from the start". Dropped
# 114793 (Sep 2014): its hourly track has gaps of more than a day.
CASES: tuple[DrifterCase, ...] = (
    DrifterCase(75152, "Mar 2008, off Cape Hatteras, drogued"),
    DrifterCase(101722, "Aug 2013, 200 km east of Hatteras, drogued"),
    DrifterCase(300234064018110, "Feb 2017, off Cape Hatteras, drogued"),
    DrifterCase(300234067876670, "Jan 2020, off Cape Hatteras, drogued"),
    DrifterCase(300234065703970, "May 2020, south-east of Hatteras, drogued"),
    DrifterCase(28843, "Jan 2002, off the Bay mouth, undrogued"),
    DrifterCase(300234066314510, "May 2019, south of Hatteras, undrogued"),
    DrifterCase(300234065514430, "Jun 2019, off Cape Hatteras, undrogued"),
    DrifterCase(300234066312890, "Jul 2019, south of Hatteras, undrogued"),
)

# The stretch both we and the Randolph team cross (#73): 36-42N, 75-50W.
# Picked from every GDP drifter whose first fix is in that box, from 1993 on,
# with at least 12 days of track: 258 in all. Split by start longitude into
# west (75-65W), mid (65-57W) and east (57-50W), and by drogue (drogued for
# 12+ days, or undrogued from the start; mixed ones dropped), then 4 per group
# spread over the years. No undrogued drifter starts in the east band.
# All 20 have a 10-day hourly track with no gap over 1 hour.
SHARED_CASES: tuple[DrifterCase, ...] = (
    DrifterCase(54421, "Jan 2006, west band (36.7N 69.4W), drogued"),
    DrifterCase(79224, "Apr 2009, west band (36.7N 70.0W), drogued"),
    DrifterCase(114599, "Oct 2013, west band (37.0N 67.2W), drogued"),
    DrifterCase(300534061551770, "Aug 2022, west band (40.4N 68.2W), drogued"),
    DrifterCase(9624914, "Apr 1997, west band (41.2N 67.9W), undrogued"),
    DrifterCase(9624972, "Jun 1999, west band (41.9N 66.7W), undrogued"),
    DrifterCase(71096, "Aug 2007, west band (41.6N 66.6W), undrogued"),
    DrifterCase(300234066313020, "May 2019, west band (38.8N 70.6W), undrogued"),
    DrifterCase(63129, "Nov 2006, mid band (38.1N 61.9W), drogued"),
    DrifterCase(79326, "Apr 2009, mid band (36.5N 64.2W), drogued"),
    DrifterCase(114896, "Jul 2013, mid band (41.1N 61.5W), drogued"),
    DrifterCase(300234068347620, "Oct 2020, mid band (36.5N 60.4W), drogued"),
    DrifterCase(72112, "Feb 2007, mid band (37.9N 63.9W), undrogued"),
    DrifterCase(70825, "Apr 2007, mid band (37.3N 60.0W), undrogued"),
    DrifterCase(300234068346830, "Oct 2020, mid band (36.5N 60.4W), undrogued"),
    DrifterCase(300234066315370, "Oct 2020, mid band (36.5N 61.1W), undrogued"),
    DrifterCase(18388, "Apr 2001, east band (40.0N 50.0W), drogued"),
    DrifterCase(92865, "Jun 2010, east band (40.5N 55.8W), drogued"),
    DrifterCase(118426, "Jun 2012, east band (39.2N 54.8W), drogued"),
    DrifterCase(300534061650930, "Apr 2022, east band (36.8N 53.9W), drogued"),
)
# SMOC against GLORYS (#116). SMOC starts 1 Nov 2020 and the GDP hourly file ends
# Oct 2022, so only 2 of the 20 SHARED_CASES overlap it. These are 10-day segments
# from every GDP drifter in the shared box (36-42N, 75-50W) from 2 Nov 2020 on,
# starting at 00 UTC inside the box, with no gap over 1.5 h, one drogue state
# throughout, and staying inside the SMOC box (33-46N, 78-40W): 245 segments
# from 49 drifters. Kept: every drogued drifter (21, first segment each, which
# includes the two shared cases), and 19 undrogued ones spread over the bands,
# from Nov-Dec 2020 and Aug-Sep 2021 only, to keep the SMOC download small.
# 300534061392260 appears twice: drogued in Jun 2021, undrogued from Aug 2021.
SMOC_CASES: tuple[DrifterCase, ...] = (
    DrifterCase(300234065705950, "Nov 2020, east band (36.6N 52.6W), drogued", "2020-11-02"),
    DrifterCase(300234068243710, "Nov 2020, east band (41.7N 50.5W), drogued", "2020-11-16"),
    DrifterCase(300234068244450, "Jan 2021, east band (41.9N 50.1W), drogued", "2021-01-13"),
    DrifterCase(300234066292540, "Feb 2021, east band (41.9N 50.5W), drogued", "2021-02-15"),
    DrifterCase(300234068343700, "Apr 2021, east band (41.8N 50.3W), drogued", "2021-04-16"),
    DrifterCase(300234068343830, "Apr 2021, east band (42.0N 50.7W), drogued", "2021-04-28"),
    DrifterCase(300234067877470, "May 2021, east band (41.8N 50.6W), drogued", "2021-05-02"),
    DrifterCase(300534061392260, "Jun 2021, east band (36.3N 53.4W), drogued", "2021-06-15"),
    DrifterCase(300534061650930, "Apr 2022, east band (36.7N 53.9W), drogued", "2022-04-30"),
    DrifterCase(300234068347650, "Nov 2020, mid band (36.1N 61.4W), drogued", "2020-11-04"),
    DrifterCase(300234066391380, "Nov 2020, mid band (41.8N 57.4W), drogued", "2020-11-18"),
    DrifterCase(300234068347620, "Nov 2020, mid band (36.0N 64.7W), drogued", "2020-11-21"),
    DrifterCase(300534060359560, "Nov 2020, mid band (41.8N 57.2W), drogued", "2020-11-22"),
    DrifterCase(300234068763480, "Sep 2021, mid band (41.8N 60.5W), drogued", "2021-09-15"),
    DrifterCase(300234065703970, "Nov 2020, west band (36.0N 70.8W), drogued", "2020-11-07"),
    DrifterCase(300234067876760, "Dec 2020, west band (36.1N 73.1W), drogued", "2020-12-03"),
    DrifterCase(300234067876670, "Dec 2020, west band (36.0N 71.7W), drogued", "2020-12-20"),
    DrifterCase(300534060381970, "Jan 2022, west band (36.1N 73.0W), drogued", "2022-01-03"),
    DrifterCase(300534063515100, "Jul 2022, west band (36.2N 73.1W), drogued", "2022-07-21"),
    DrifterCase(300534061550990, "Aug 2022, west band (40.5N 66.4W), drogued", "2022-08-20"),
    DrifterCase(300534061551770, "Aug 2022, west band (40.4N 68.2W), drogued", "2022-08-21"),
    DrifterCase(300234067208590, "Nov 2020, east band (38.8N 54.5W), undrogued", "2020-11-02"),
    DrifterCase(300234064501790, "Nov 2020, east band (36.2N 50.5W), undrogued", "2020-11-09"),
    DrifterCase(300234063942720, "Nov 2020, east band (36.1N 51.0W), undrogued", "2020-11-29"),
    DrifterCase(300534061392260, "Aug 2021, east band (36.0N 53.5W), undrogued", "2021-08-01"),
    DrifterCase(300534061604780, "Aug 2021, east band (36.1N 53.7W), undrogued", "2021-08-05"),
    DrifterCase(300234064500600, "Aug 2021, east band (36.2N 53.6W), undrogued", "2021-08-12"),
    DrifterCase(300234063947890, "Nov 2020, mid band (38.2N 60.5W), undrogued", "2020-11-02"),
    DrifterCase(300234065382690, "Nov 2020, mid band (41.0N 57.2W), undrogued", "2020-11-02"),
    DrifterCase(300234066315040, "Nov 2020, mid band (37.0N 62.1W), undrogued", "2020-11-02"),
    DrifterCase(300234068346820, "Nov 2020, mid band (36.9N 57.8W), undrogued", "2020-11-02"),
    DrifterCase(300234068347000, "Nov 2020, mid band (37.3N 58.6W), undrogued", "2020-11-02"),
    DrifterCase(300234068347700, "Nov 2020, mid band (36.7N 60.5W), undrogued", "2020-11-02"),
    DrifterCase(300234065740710, "Nov 2020, west band (36.0N 72.0W), undrogued", "2020-11-07"),
    DrifterCase(300234066619950, "Nov 2020, west band (37.3N 73.1W), undrogued", "2020-11-12"),
    DrifterCase(300234064013010, "Nov 2020, west band (36.3N 73.7W), undrogued", "2020-11-23"),
    DrifterCase(300234064779920, "Aug 2021, west band (40.2N 66.0W), undrogued", "2021-08-10"),
    DrifterCase(300234064761620, "Aug 2021, west band (36.0N 73.0W), undrogued", "2021-08-19"),
    DrifterCase(300534061608600, "Sep 2021, west band (36.2N 70.7W), undrogued", "2021-09-03"),
    DrifterCase(300234064014420, "Sep 2021, west band (36.1N 67.0W), undrogued", "2021-09-05"),
)
CASE_SETS = {"hatteras": CASES, "shared": SHARED_CASES, "smoc": SMOC_CASES}


# --- Real tracks ------------------------------------------------------------


def open_gdp(url: str = GDP_URL):
    import xarray as xr

    return xr.open_zarr(url, consolidated=True, decode_times=False)


def load_track(
    drifter_id: int, ds=None, days: float | None = None, start: str | None = None
) -> pd.DataFrame:
    """Hourly track of one drifter: columns t, lat, lon, drogued.

    The GDP file is a "ragged array": all drifters' rows end to end, with
    `rowsize` saying how many belong to each. Only this drifter's rows are read.
    """
    ds = ds if ds is not None else open_gdp()
    ids = ds["id"].values
    hit = np.flatnonzero(ids == drifter_id)
    if hit.size == 0:
        raise KeyError(f"drifter {drifter_id} not in the GDP file")
    k = int(hit[0])
    rows = ds["rowsize"].values.astype(np.int64)
    i0 = int(rows[:k].sum())
    i1 = i0 + int(rows[k])
    sl = slice(i0, i1)
    t = pd.to_datetime(ds["time"][sl].values, unit="s")
    out = pd.DataFrame(
        {
            "t": t,
            "lat": ds["lat"][sl].values.astype(float),
            "lon": ds["lon"][sl].values.astype(float),
            "drogued": ds["drogue_status"][sl].values.astype(bool),
        }
    ).dropna(subset=["lat", "lon"])
    out["lon"] = (out["lon"] + 180.0) % 360.0 - 180.0
    if start is not None:
        out = out[out["t"] >= pd.Timestamp(start)]
    if days is not None:
        out = out[out["t"] <= out["t"].iloc[0] + pd.Timedelta(days=days)]
    return out.reset_index(drop=True)


# --- Model tracks -----------------------------------------------------------


def drift(
    env,
    start: datetime,
    lat: float,
    lon: float,
    days: float,
    model: str,
    vessel=None,
    dt: timedelta = timedelta(minutes=10),
) -> pd.DataFrame:
    """Drift one model object for `days`. Returns columns t, lat, lon.

    model: "water", "float" or "kayak" (see module doc). "kayak" needs
    `vessel`, a KayakVessel; it is stepped with zero thrust.
    """
    from boatsim.vessel import hull as H

    if model == "kayak" and vessel is None:
        raise ValueError("model 'kayak' needs a vessel")
    rng = np.random.default_rng(0)
    state = vessel.initial_state(start, lat, lon) if model == "kayak" else None
    t = start
    rows = [{"t": t, "lat": lat, "lon": lon}]
    n = int(timedelta(days=days) / dt)
    secs = dt.total_seconds()
    for _ in range(n):
        e = env.sample(t, lat, lon)
        if model == "kayak":
            state, _events = vessel.step(
                state, Command(heading=0.0, thrust_fraction=0.0), e, dt, rng
            )
            lat, lon = state.lat, state.lon
        else:
            u, v = e.current_u, e.current_v
            if model == "float":
                su, sv = H.stokes_drift(e.hs, e.tp, e.wave_dir)
                u, v = u + su, v + sv
            elif model != "water":
                raise ValueError(f"unknown model {model!r}")
            lat, lon = move(lat, lon, u * secs, v * secs)
        t = t + dt
        rows.append({"t": t, "lat": lat, "lon": lon})
    return pd.DataFrame(rows)


def kayak_for_drift(design):
    """KayakVessel from a design, with hazards off: we want the drift, not the dice."""
    from boatsim.vessel import KayakVessel

    return KayakVessel(replace(design, hazards={**design.hazards, "enabled": False}))


# --- Scores -----------------------------------------------------------------


def _interp_track(track: pd.DataFrame, times: pd.DatetimeIndex) -> tuple[np.ndarray, np.ndarray]:
    # Seconds since 1970, whatever resolution pandas stored the times in.
    x = track["t"].to_numpy().astype("datetime64[s]").astype(np.int64).astype(float)
    xi = times.to_numpy().astype("datetime64[s]").astype(np.int64).astype(float)
    lat = np.interp(xi, x, track["lat"].to_numpy(), left=np.nan, right=np.nan)
    lon = np.interp(xi, x, track["lon"].to_numpy(), left=np.nan, right=np.nan)
    return lat, lon


def marks_for(days: int) -> list[int]:
    """Days at which separation is reported."""
    return sorted({d for d in (1, 3, 5, days) if d <= days})


def score(real: pd.DataFrame, model: pd.DataFrame, days: int) -> dict:
    """Separation (km) at daily marks and the Liu-Weisberg skill over `days`."""
    t0 = real["t"].iloc[0]
    marks = pd.DatetimeIndex([t0 + pd.Timedelta(days=d) for d in range(days + 1)])
    rlat, rlon = _interp_track(real, marks)
    mlat, mlon = _interp_track(model, marks)
    sep = np.array(
        [distance_m(a, b, c, d) / 1000.0 for a, b, c, d in zip(rlat, rlon, mlat, mlon, strict=True)]
    )
    # Distance the drifter has travelled along its path, at each daily mark.
    seg = np.array(
        [
            distance_m(rlat[i], rlon[i], rlat[i + 1], rlon[i + 1]) / 1000.0
            for i in range(len(marks) - 1)
        ]
    )
    path = np.concatenate([[0.0], np.cumsum(seg)])
    stay = np.array([distance_m(rlat[0], rlon[0], a, b) / 1000.0 for a, b in zip(rlat, rlon)])
    ok = np.isfinite(sep[1:]) & np.isfinite(path[1:])
    skill = (
        max(0.0, 1.0 - sep[1:][ok].sum() / path[1:][ok].sum())
        if ok.any() and path[1:][ok].sum() > 0
        else float("nan")
    )
    # The same score for a model that never moves, as the bar to beat.
    stay_skill = (
        max(0.0, 1.0 - stay[1:][ok].sum() / path[1:][ok].sum())
        if ok.any() and path[1:][ok].sum() > 0
        else float("nan")
    )
    out = {
        "skill": skill,
        "stay_put_skill": stay_skill,
        "path_km": path[-1],
        "stay_put_km": stay[-1],
    }
    for d in marks_for(days):
        out[f"sep_d{d}_km"] = sep[d]
    return out


# --- The check --------------------------------------------------------------


def glorys_months(start: datetime, days: float) -> list[str]:
    """YYYY-MM months a drift from `start` lasting `days` touches."""
    end = start + timedelta(days=days)
    months, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        months.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return months


def run_check(
    env,
    design,
    cases=CASES,
    days: int = 10,
    gdp=None,
    log=print,
    models: tuple[str, ...] = ("water", "float", "kayak"),
    env_for=None,
) -> tuple[pd.DataFrame, dict]:
    """Run every case through every model. Returns (scores table, tracks by case).

    env_for: optional function (drogued fraction) -> environment, to pick the
    current source per drifter (SMOC: daily model current for drogued floats,
    hourly total current for undrogued ones, #116). Default: `env` for all."""
    gdp = gdp if gdp is not None else open_gdp()
    kayak = kayak_for_drift(design) if "kayak" in models else None
    rows, tracks = [], {}
    for case in cases:
        real = load_track(case.drifter_id, gdp, days=days + 0.5, start=case.start)
        t0 = real["t"].iloc[0].to_pydatetime()
        lat0, lon0 = float(real["lat"].iloc[0]), float(real["lon"].iloc[0])
        span = (real["t"].iloc[-1] - real["t"].iloc[0]).total_seconds() / 86400.0
        gap_h = real["t"].diff().max().total_seconds() / 3600.0
        if span < days or gap_h > 12.0:
            log(f"skip {case.drifter_id}: {span:.1f} days of track, longest gap {gap_h:.0f} h")
            continue
        drogued = float(
            real["drogued"][real["t"] <= real["t"].iloc[0] + pd.Timedelta(days=days)].mean()
        )
        key = case.drifter_id if case.start is None else f"{case.drifter_id}_{case.start}"
        tracks[key] = {"real": real}
        e = env if env_for is None else env_for(drogued)
        for model in models:
            m = drift(e, t0, lat0, lon0, days, model, vessel=kayak)
            tracks[key][model] = m
            s = score(real, m, days)
            rows.append(
                {
                    "drifter": key,
                    "note": case.note,
                    "start": t0,
                    "lat0": lat0,
                    "lon0": lon0,
                    "drogued_frac": drogued,
                    "model": model,
                    **s,
                }
            )
            log(
                f"{case.drifter_id} {model:5s} skill {s['skill']:.2f} "
                f"sep d{days} {s[f'sep_d{days}_km']:.0f} km (stay put {s['stay_put_km']:.0f} km)"
            )
    return pd.DataFrame(rows), tracks


def fair_model(drogued_frac: float) -> str:
    """The model a drifter should be judged against: water if mostly drogued."""
    return "water" if drogued_frac >= 0.5 else "float"


def report_markdown(table: pd.DataFrame, days: int) -> str:
    """Plain-language report for John and the team."""
    d = f"sep_d{days}_km"
    lines = [
        f"# Drift check against real ocean drifters ({days} days)",
        "",
        (
            "Each row is one real NOAA drifter. "
            "We start a model float at the same place and time and let our simulated ocean "
            "carry it. *Gap* is how far apart the model and the real drifter are. *Skill* is 1 "
            "for a perfect track and 0 when the gaps are as big as the distance the drifter "
            "travelled. *Stay put* is the score of a model that never moves, the bar to beat: "
            "how far the drifter really went from its start, and the skill of that guess."
        ),
        "",
        "| Drifter | When / type | Judged model | Skill | "
        + " | ".join(f"Gap day {m}" for m in marks_for(days))
        + f" | Stay put (gap, skill) | Kayak gap day {days} |",
        "|---" * (6 + len(marks_for(days))) + "|",
    ]
    fair_rows = []
    for drifter, g in table.groupby("drifter", sort=False):
        frac = float(g["drogued_frac"].iloc[0])
        fm = fair_model(frac)
        r = g[g["model"] == fm].iloc[0]
        k = g[g["model"] == "kayak"].iloc[0]
        fair_rows.append(r)
        gaps = " | ".join(f"{r[f'sep_d{m}_km']:.0f} km" for m in marks_for(days))
        lines.append(
            f"| {drifter} | {r['note']} | {fm} | {r['skill']:.2f} | {gaps} "
            f"| {r['stay_put_km']:.0f} km, {r['stay_put_skill']:.2f} | {k[d]:.0f} km |"
        )
    f = pd.DataFrame(fair_rows)
    beat = int((f["skill"] > f["stay_put_skill"]).sum())
    lines += [
        "",
        (
            f"**Summary over {len(f)} drifters (judged model):** median skill "
            f"{f['skill'].median():.2f}, median gap after {days} days {f[d].median():.0f} km "
            f"(drifters' median distance from start {f['stay_put_km'].median():.0f} km). "
            f"The model's skill beat 'stay put' in {beat} of {len(f)}."
        ),
        "",
        "Per model, all drifters:",
        "",
        f"| Model | Median skill | Median gap day {days} |",
        "|---|---|---|",
    ]
    for model, g in table.groupby("model", sort=False):
        lines.append(f"| {model} | {g['skill'].median():.2f} | {g[d].median():.0f} km |")
    return "\n".join(lines) + "\n"


def _band(note: str) -> str:
    for b in ("west", "mid", "east"):
        if f"{b} band" in note:
            return b
    return "?"


def compare_markdown(glorys: pd.DataFrame, smoc: pd.DataFrame, days: int) -> str:
    """SMOC against GLORYS on the same drifters, like with like (#116).

    GLORYS: the judged model (fair_model). SMOC: its "water" run, which used the
    daily model current for drogued drifters and the hourly total current
    (tides and Stokes drift included) for undrogued ones."""
    g = pd.DataFrame(
        [
            r
            for _, grp in glorys.groupby("drifter", sort=False)
            for _, r in grp[grp["model"] == fair_model(grp["drogued_frac"].iloc[0])].iterrows()
        ]
    ).set_index("drifter")
    m = smoc.set_index("drifter")
    both = g.join(m, rsuffix="_smoc", how="inner")
    both["band"] = [_band(n) for n in both["note"]]
    both["drogued"] = both["drogued_frac"] >= 0.5
    d = f"sep_d{days}_km"

    def row(label, b):
        if b.empty:
            return f"| {label} | 0 | | | | | | |"
        sw = int((b[f"{d}_smoc"] < b[d]).sum())
        return (
            f"| {label} | {len(b)} | {b['skill'].median():.2f} | {b['skill_smoc'].median():.2f} "
            f"| {b[d].median():.0f} | {b[f'{d}_smoc'].median():.0f} "
            f"| {int((b['skill'] > b['stay_put_skill']).sum())} / "
            f"{int((b['skill_smoc'] > b['stay_put_skill']).sum())} | {sw} of {len(b)} |"
        )

    marks = marks_for(days)
    lines = [
        f"# SMOC against GLORYS on real drifters ({days} days, #116)",
        "",
        (
            "Same drifters, same start, same wind and waves (ERA5). Like with like: drogued "
            "drifters are scored on the plain ocean current (GLORYS daily mean against SMOC's "
            "daily mean of its hourly model current); undrogued ones on current plus wave push "
            "(GLORYS plus ERA5 Stokes drift against SMOC's hourly total current, which has "
            "Stokes drift and tides built in)."
        ),
        "",
        (
            f"| Group | Drifters | Skill GLORYS | Skill SMOC | Gap day {days} GLORYS (km) "
            f"| Gap day {days} SMOC (km) | Beat stay put (GLORYS / SMOC) "
            f"| SMOC closer at day {days} |"
        ),
        "|---|---|---|---|---|---|---|---|",
        row("All", both),
    ]
    for b in ("west", "mid", "east"):
        lines.append(row(f"{b.capitalize()} band", both[both["band"] == b]))
    lines.append(row("Drogued", both[both["drogued"]]))
    lines.append(row("Undrogued", both[~both["drogued"]]))
    lines += [
        "",
        "Median gap (km) by day:",
        "",
        "| Source | " + " | ".join(f"Day {k}" for k in marks) + " |",
        "|---" * (1 + len(marks)) + "|",
        "| GLORYS | " + " | ".join(f"{both[f'sep_d{k}_km'].median():.0f}" for k in marks) + " |",
        "| SMOC | " + " | ".join(f"{both[f'sep_d{k}_km_smoc'].median():.0f}" for k in marks) + " |",
        "",
        "Per drifter:",
        "",
        (
            f"| Drifter | When / type | Skill GLORYS | Skill SMOC | Gap day {days} GLORYS | "
            f"Gap day {days} SMOC | Stay put |"
        ),
        "|---|---|---|---|---|---|---|",
    ]
    for k, r in both.iterrows():
        lines.append(
            f"| {k} | {r['note']} | {r['skill']:.2f} | {r['skill_smoc']:.2f} | {r[d]:.0f} km "
            f"| {r[f'{d}_smoc']:.0f} km | {r['stay_put_km']:.0f} km |"
        )
    return "\n".join(lines) + "\n"


# --- Dead-boat run (#73) -----------------------------------------------------

DEAD_BOAT_START = datetime(2023, 5, 15)  # agreed with the Randolph team (#73)


def on_land(currents, t: datetime, lat: float, lon: float) -> bool:
    """True where GLORYS has no sea point around (lat, lon): its land mask.

    Stand-in until the real coastline check (aground issue). GLORYS is on a
    1/12 degree grid (about 9 km), so narrow rivers and inlets count as land
    and a boat within a few km of a beach may still count as at sea.
    """
    import math

    c = currents.sample(t, lat, lon)
    return not math.isfinite(c["current_u"])


def dead_boat(env, currents, design, start: datetime, lat: float, lon: float, days: float = 30):
    """Drift the kayak with no thrust or steering until `days` pass or it
    first reaches land. Returns (hourly track, summary dict)."""
    kayak = kayak_for_drift(design)
    track = drift(env, start, lat, lon, days, "kayak", vessel=kayak)
    hourly = track.iloc[::6].reset_index(drop=True)  # 10-minute steps -> hourly
    landed = None
    for i, r in hourly.iterrows():
        if i > 0 and on_land(currents, r["t"].to_pydatetime(), r["lat"], r["lon"]):
            landed = i
            break
    if landed is not None:
        hourly = hourly.iloc[: landed + 1]
    path = sum(
        distance_m(a.lat, a.lon, b.lat, b.lon)
        for a, b in zip(hourly.itertuples(), hourly.iloc[1:].itertuples(), strict=False)
    )
    end = hourly.iloc[-1]
    summary = {
        "start": start,
        "lat0": lat,
        "lon0": lon,
        "aground": landed is not None,
        "days": (end["t"] - hourly["t"].iloc[0]).total_seconds() / 86400.0,
        "end_lat": float(end["lat"]),
        "end_lon": float(end["lon"]),
        "path_km": path / 1000.0,
        "km_from_start": distance_m(lat, lon, end["lat"], end["lon"]) / 1000.0,
    }
    return hourly, summary


def dead_boat_markdown(s: dict) -> str:
    where = f"{s['end_lat']:.2f}N, {-s['end_lon']:.2f}W"
    if s["aground"]:
        ending = f"first reached land (GLORYS land mask) after {s['days']:.1f} days at {where}"
    else:
        ending = f"was still at sea after {s['days']:.0f} days, at {where}"
    return (
        f"# Dead-boat run from {s['lat0']:.2f}N, {-s['lon0']:.2f}W, {s['start']:%d %b %Y}\n\n"
        "The v4 kayak with motors off and no steering, pushed only by current, waves "
        "and wind (ERA5 + GLORYS12), hazards off.\n\n"
        f"It {ending}. Path {s['path_km']:.0f} km, {s['km_from_start']:.0f} km from the "
        "start in a straight line.\n\n"
        "Land check: a point counts as land where GLORYS (about 9 km grid) has no sea "
        "point around it. That's a stand-in until the coastline check lands.\n"
    )


def main(argv: list[str] | None = None) -> None:
    from boatsim.config import load_design
    from boatsim.oceandata import ERA5Source, GlorysSource, ReanalysisEnvironment

    p = argparse.ArgumentParser(prog="python -m boatsim.mc.drifters")
    p.add_argument("--days", type=int, default=10)
    p.add_argument("--design", default="configs/v4_kayak.yaml")
    p.add_argument("--out", default="runs/drifters")
    p.add_argument("--workers", type=int, default=4, help="parallel ERA5 downloads")
    p.add_argument("--no-currents", action="store_true", help="try-out only: zero current")
    p.add_argument(
        "--months", action="store_true", help="print the GLORYS months the cases need, then exit"
    )
    p.add_argument("--set", default="hatteras", choices=list(CASE_SETS), help="which drifters")
    p.add_argument(
        "--smoc",
        action="store_true",
        help="also drift on SMOC currents and compare with GLORYS (#116; data from Nov 2020)",
    )
    p.add_argument(
        "--dead-boat",
        action="store_true",
        help="instead: drift the dead kayak from the drop point on 15 May 2023 (#73)",
    )
    a = p.parse_args(argv)

    if a.dead_boat:
        _main_dead_boat(a)
        return
    cases = CASE_SETS[a.set]
    gdp = open_gdp()
    starts = [
        load_track(c.drifter_id, gdp, days=1, start=c.start)["t"].iloc[0].to_pydatetime()
        for c in cases
    ]
    if a.months:
        need = sorted({m for t in starts for m in glorys_months(t - timedelta(days=1), a.days + 2)})
        print(" ".join(need))
        return
    # Warm the ERA5 cache in parallel first; the drift loop then reads from disk.
    from boatsim.oceandata import era5

    days = sorted({(t + timedelta(days=i)).date() for t in starts for i in range(a.days + 2)})
    era5.fetch_days(days, workers=a.workers)
    env = ReanalysisEnvironment(ERA5Source(), None if a.no_currents else GlorysSource())
    table, tracks = run_check(env, load_design(a.design), cases, days=a.days, gdp=gdp)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    table.to_csv(out / "drift_scores.csv", index=False)
    for drifter, tr in tracks.items():
        frames = [df.assign(source=name) for name, df in tr.items()]
        pd.concat(frames).to_csv(out / f"track_{drifter}.csv", index=False)
    md = report_markdown(table, a.days)
    if a.smoc:
        from boatsim.oceandata.smoc import SmocSource

        smoc = {k: ReanalysisEnvironment(ERA5Source(), SmocSource(k)) for k in ("model", "total")}
        st, _ = run_check(
            None,
            None,
            cases,
            days=a.days,
            gdp=gdp,
            models=("water",),
            env_for=lambda frac: smoc["model" if fair_model(frac) == "water" else "total"],
        )
        st.to_csv(out / "drift_scores_smoc.csv", index=False)
        md = compare_markdown(table, st, a.days) + "\n" + md
    (out / "drift_report.md").write_text(md)
    print(md)


def _main_dead_boat(a) -> None:
    from boatsim.config import load_design
    from boatsim.oceandata import ERA5Source, GlorysSource, ReanalysisEnvironment, era5

    design = load_design(a.design)
    lat, lon = design.voyage["drop_lat"], design.voyage["drop_lon"]
    start, days = DEAD_BOAT_START, a.days
    if a.months:
        print(" ".join(glorys_months(start - timedelta(days=1), days + 2)))
        return
    era5.fetch_days(
        [(start + timedelta(days=i)).date() for i in range(-1, days + 2)], workers=a.workers
    )
    currents = GlorysSource()
    env = ReanalysisEnvironment(ERA5Source(), currents)
    track, summary = dead_boat(env, currents, design, start, lat, lon, days)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    track.to_csv(out / f"dead_boat_{start:%Y-%m-%d}_track.csv", index=False)
    md = dead_boat_markdown(summary)
    (out / "dead_boat_report.md").write_text(md)
    print(md)
    print(track.iloc[::24].to_string())  # daily positions, for the log


if __name__ == "__main__":
    main()


__all__ = [
    "CASES",
    "CASE_SETS",
    "SHARED_CASES",
    "SMOC_CASES",
    "DrifterCase",
    "compare_markdown",
    "dead_boat",
    "drift",
    "fair_model",
    "glorys_months",
    "load_track",
    "on_land",
    "report_markdown",
    "run_check",
    "score",
]
