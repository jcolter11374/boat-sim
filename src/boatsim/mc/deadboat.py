"""How far offshore must the drop be? Dead-boat drift by start distance (issue #90).

A "dead boat" is the v4 kayak with motors off and no steering, pushed only
by current, waves and wind (mc/drifters.py drift model "kayak", hazards
off). We start it at four points on one line east-south-east from Cape Henry
(the south side of the Bay mouth), through today's drop point:

* ``drop``: today's drop point, 36.85N 75.70W, about 29 km (15.6 nm) out
* ``50km``, ``100km``: 50 and 100 km out on the same line
* ``shelf``: about 120 km out, near the edge of the continental shelf

From each, on the 1st and 15th of April, May and June of every year asked
for (2019-2023 in #90), it drifts for 30 days through ERA5 + GLORYS12 and
stops if it runs ashore (the shared land mask, runner/land.py, about 2 km).

Per voyage we record: aground or not, and when and where; whether and when it
was carried into the Gulf Stream (east of 72W, the issue's test); the days
spent within 150 km of land (where the crossing record's mission-ending
events run at about 0.12 a day against 0.013 offshore, #89); and where it was
after 30 days.

The drop distance is John's call (how far his sailboat can safely take the
kayak). This only produces the numbers for that decision.

Owner: Ravi.
"""

from __future__ import annotations

import argparse
import math
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

from boatsim.autonomy.sphere import destination
from boatsim.geo import distance_m

CAPE_HENRY = (36.93, -76.01)
BEARING_DEG = 107.8  # Cape Henry to today's drop point
STARTS_KM = {"drop": 29.0, "50km": 50.0, "100km": 100.0, "shelf": 120.0}
GULF_STREAM_LON = -72.0  # "carried into the Gulf Stream" = east of this (#90)
NEAR_LAND_KM = 150.0  # the crossing record's near-land phase (#89)
LAUNCH_MONTHS = (4, 5, 6)
LAUNCH_DAYS = (1, 15)


def start_point(name: str) -> tuple[float, float]:
    lat, lon = destination(*CAPE_HENRY, BEARING_DEG, STARTS_KM[name] * 1000.0)
    return round(lat, 4), round(lon, 4)


def launches(years) -> list[datetime]:
    return [datetime(y, m, d, 12) for y in years for m in LAUNCH_MONTHS for d in LAUNCH_DAYS]


# --- Distance to land -------------------------------------------------------


@lru_cache(maxsize=1)
def _coast_cells(box=(28.0, 48.0, -82.0, -55.0)) -> np.ndarray:
    """(lat, lon) of land-mask cells on the coast (land with a water neighbour)
    inside a box around the US east coast. Enough for 'within 150 km of land'
    near our drop; the open ocean beyond is far from everything."""
    from boatsim.runner.land import default_land

    land = default_land()
    if land is None:
        return np.empty((0, 2))
    i0 = max(0, int((box[0] - land.lat0) // land.res))
    i1 = min(land.nlat, int((box[1] - land.lat0) // land.res))
    j0 = max(0, int((box[2] - land.lon0) // land.res))
    j1 = min(land.nlon, int((box[3] - land.lon0) // land.res))
    m = land.mask[i0:i1, j0:j1]
    water_near = np.zeros_like(m)
    water_near[1:, :] |= ~m[:-1, :]
    water_near[:-1, :] |= ~m[1:, :]
    water_near[:, 1:] |= ~m[:, :-1]
    water_near[:, :-1] |= ~m[:, 1:]
    ii, jj = np.nonzero(m & water_near)
    lat = land.lat0 + (ii + i0 + 0.5) * land.res
    lon = land.lon0 + (jj + j0 + 0.5) * land.res
    return np.column_stack([lat, lon])


def distance_to_land_km(lats, lons, coast: np.ndarray | None = None) -> np.ndarray:
    """Approximate distance (km) from each point to the nearest coast cell.
    Flat-earth per point (fine to ~1% within a few hundred km)."""
    coast = _coast_cells() if coast is None else coast
    lats, lons = np.asarray(lats, float), np.asarray(lons, float)
    if len(coast) == 0:
        return np.full(lats.shape, np.inf)
    out = np.empty(lats.shape)
    for k, (la, lo) in enumerate(zip(lats, lons, strict=True)):
        dy = (coast[:, 0] - la) * 111.2
        dx = (coast[:, 1] - lo) * 111.2 * math.cos(math.radians(la))
        out[k] = float(np.sqrt(dx * dx + dy * dy).min())
    return out


# --- One dead-boat voyage ---------------------------------------------------


def run_one(env, design, start: datetime, name: str, days: float = 30.0, land=None) -> dict:
    from boatsim.mc.drifters import drift, kayak_for_drift

    lat0, lon0 = start_point(name)
    track = drift(env, start, lat0, lon0, days, "kayak", vessel=kayak_for_drift(design))
    hourly = track.iloc[::6].reset_index(drop=True)  # 10-minute steps -> hourly
    aground_at = None
    if land is not None:
        for i, r in hourly.iterrows():
            if i > 0 and land.on_land(r["lat"], r["lon"]):
                aground_at = i
                break
    if aground_at is not None:
        hourly = hourly.iloc[: aground_at + 1]
    days_from = (hourly["t"] - hourly["t"].iloc[0]).dt.total_seconds() / 86400.0
    east = hourly["lon"] > GULF_STREAM_LON
    near = distance_to_land_km(hourly["lat"], hourly["lon"]) <= NEAR_LAND_KM
    step_days = 1.0 / 24.0
    end = hourly.iloc[-1]
    return {
        "start_point": name,
        "start_km": STARTS_KM[name],
        "start": start,
        "year": start.year,
        "lat0": lat0,
        "lon0": lon0,
        "aground": aground_at is not None,
        "aground_day": float(days_from.iloc[-1]) if aground_at is not None else math.nan,
        "aground_lat": float(end["lat"]) if aground_at is not None else math.nan,
        "aground_lon": float(end["lon"]) if aground_at is not None else math.nan,
        "gulf_stream": bool(east.any()),
        "gulf_stream_day": float(days_from[east].iloc[0]) if east.any() else math.nan,
        "days_near_land": float(near[:-1].sum() * step_days) if len(near) > 1 else 0.0,
        "end_lat": float(end["lat"]),
        "end_lon": float(end["lon"]),
        "km_from_start": distance_m(lat0, lon0, end["lat"], end["lon"]) / 1000.0,
    }


def run_year(env, design, year: int, days: float = 30.0, land=None, log=print) -> pd.DataFrame:
    rows = []
    for start in launches([year]):
        for name in STARTS_KM:
            r = run_one(env, design, start, name, days, land)
            rows.append(r)
            log(
                f"{start:%Y-%m-%d} {name:6s} aground={r['aground']} "
                f"day={r['aground_day']:.1f} gulf={r['gulf_stream']} "
                f"near_land_days={r['days_near_land']:.1f}"
            )
    return pd.DataFrame(rows)


# --- Report -----------------------------------------------------------------


def summary(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for name, km in STARTS_KM.items():
        g = df[df["start_point"] == name]
        if g.empty:
            continue
        rows.append(
            {
                "start_point": name,
                "km_out": km,
                "voyages": len(g),
                "aground": int(g["aground"].sum()),
                "median_days_to_aground": g.loc[g["aground"], "aground_day"].median(),
                "gulf_stream": int(g["gulf_stream"].sum()),
                "median_days_to_gulf_stream": g.loc[g["gulf_stream"], "gulf_stream_day"].median(),
                "median_days_near_land": g["days_near_land"].median(),
            }
        )
    return pd.DataFrame(rows)


LABELS = {
    "drop": "Today's drop (29 km, 15.6 nm)",
    "50km": "50 km out",
    "100km": "100 km out",
    "shelf": "Shelf edge (about 120 km)",
}


def _f(x, fmt="{:.1f}"):
    return "" if x is None or (isinstance(x, float) and math.isnan(x)) else fmt.format(x)


def report_markdown(df: pd.DataFrame) -> str:
    s = summary(df)
    years = sorted(df["year"].unique())
    lines = [
        "# Dead-boat drift by drop distance (#90)",
        "",
        (
            "A dead boat (motors off, no steering) drifts for 30 days from four points on a "
            "line east-south-east of Cape Henry, launched on the 1st and 15th of April, May "
            f"and June, {years[0]} to {years[-1]} (ERA5 weather, GLORYS12 currents, the "
            "shared 2 km land mask). 'Gulf Stream' means it was carried east of 72W. "
            "'Days near land' is time within 150 km of a coast, where the crossing record's "
            "mission-ending events run about nine times faster than offshore (#89)."
        ),
        "",
        (
            "| Start | Voyages | Ran ashore | Median days to ashore | Into the Gulf Stream "
            "| Median days to Gulf Stream | Median days near land |"
        ),
        "|---|---|---|---|---|---|---|",
    ]
    for r in s.itertuples():
        lines.append(
            f"| {LABELS[r.start_point]} | {r.voyages} | {r.aground} ({r.aground / r.voyages:.0%}) "
            f"| {_f(r.median_days_to_aground)} | {r.gulf_stream} ({r.gulf_stream / r.voyages:.0%}) "
            f"| {_f(r.median_days_to_gulf_stream)} | {_f(r.median_days_near_land)} |"
        )
    lines += ["", "Where the ones that ran ashore ended up:", ""]
    a = df[df["aground"]]
    for name in STARTS_KM:
        g = a[a["start_point"] == name]
        if len(g):
            spots = ", ".join(
                f"{r.aground_lat:.2f}N {-r.aground_lon:.2f}W (day {r.aground_day:.0f})"
                for r in g.itertuples()
            )
            lines.append(f"- {LABELS[name]}: {spots}")
    return "\n".join(lines) + "\n"


# --- CLI --------------------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m boatsim.mc.deadboat")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="every start point and launch date of one year")
    r.add_argument("year", type=int)
    r.add_argument("--days", type=float, default=30.0)
    r.add_argument("--design", default="configs/v4_kayak.yaml")
    r.add_argument("--out", default="runs/deadboat")
    r.add_argument("--workers", type=int, default=4, help="parallel ERA5 downloads")
    r.add_argument("--constant", action="store_true", help="test only: constant made-up weather")
    s = sub.add_parser("report", help="combine per-year CSVs")
    s.add_argument("csvs", nargs="+")
    s.add_argument("--out", default="runs/deadboat")
    a = p.parse_args(argv)

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.cmd == "run":
        from boatsim.config import load_design
        from boatsim.runner.land import default_land

        design = load_design(a.design)
        if a.constant:
            from boatsim.oceandata import ConstantEnvironment

            env = ConstantEnvironment()
        else:
            from boatsim.oceandata import ERA5Source, GlorysSource, ReanalysisEnvironment, era5

            days = sorted(
                {
                    (t + timedelta(days=i)).date()
                    for t in launches([a.year])
                    for i in range(-1, int(a.days) + 2)
                }
            )
            era5.fetch_days(days, workers=a.workers)
            env = ReanalysisEnvironment(ERA5Source(), GlorysSource())
        df = run_year(env, design, a.year, a.days, default_land())
        df.to_csv(out / f"deadboat_{a.year}.csv", index=False)
    else:
        df = pd.concat([pd.read_csv(x, parse_dates=["start"]) for x in a.csvs], ignore_index=True)
        df.to_csv(out / "deadboat_all.csv", index=False)
        summary(df).to_csv(out / "deadboat_summary.csv", index=False)
        md = report_markdown(df)
        (out / "deadboat_report.md").write_text(md)
        print(md)


if __name__ == "__main__":
    main()
