"""Does the drop DATE matter more than the distance? Dead-boat drift by day (#163).

The Randolph team's re-run on real 2023 data (#50) found that at 100 km every
drop from 7 to 28 May ran ashore and every drop from 31 May to 15 June stayed at
sea. Our #90/#96 study only sampled the 1st and 15th of each month, too coarse
to see windows like that. This runs the same dead boat (mc/deadboat.py: motors
off, no steering, hazards off, ERA5 wind and waves, GLORYS12 currents, 2 km
land mask) for 30 days from EVERY day, 15 April to 30 June, from:

* ``100km``: today's drop point (36.65N 74.94W, #128)
* ``50km``: the fallback
* ``randolph100``: the Randolph team's 100 km point off Ocean City
  (38.02N 74.01W), for the side-by-side with their 2023 result

and with the wind's push on the hull at three strengths (the "windage"; see
deadboat.with_windage): x0.6 (about 3.3% of the wind speed, the Randolph
team's leeway), x1 (our model, about 4.1%) and x1.7 (about 5.3%).

Go/no-go from the forecast. For each drop day (base windage) it also records
what John could know on the morning of the drop: a 7-day dead-boat drift
through a forecast issued that day (ErrorForecast, #58: the truth plus error
that grows with lead time) and the forecast mean wind over the first 5 days.
The report scores simple rules ("don't drop if the forecast drift comes
within X km of land") by how many groundings they would have avoided and how
many days they turn away.

Owner: Ravi (QA).
"""

from __future__ import annotations

import argparse
import math
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from boatsim.mc import deadboat as DB

POINTS = {
    "100km": DB.start_point("100km"),
    "50km": DB.start_point("50km"),
    "randolph100": (38.02, -74.01),  # their 100 km point off Ocean City (configs/randolph_rev_b)
}
WINDAGES = {0.6: "about 3.3% of wind", 1.0: "about 4.1%, our model", 1.7: "about 5.3%"}
FIRST, LAST = (4, 15), (6, 30)
FORECAST_DAYS = 7.0
WIND_DAYS = 5.0
ONSHORE_BEARING = 250.0  # from the drop, the Outer Banks and Virginia Beach lie WSW
# The Randolph team's 2023 result at 100 km (#50, 10 Nov): 16 drops every 3 days
# from 1 May; 7-28 May all ran ashore, the rest stayed at sea.
RANDOLPH_2023 = {
    date(2023, 5, 1) + timedelta(days=3 * k): date(2023, 5, 7)
    <= date(2023, 5, 1) + timedelta(days=3 * k)
    <= date(2023, 5, 28)
    for k in range(16)
}


def drop_days(year: int, hour: int = 12) -> list[datetime]:
    t, end = datetime(year, *FIRST, hour), datetime(year, *LAST, hour)
    out = []
    while t <= end:
        out.append(t)
        t += timedelta(days=1)
    return out


def area(lat: float, lon: float) -> str:
    """Plain-words stretch of coast for a landfall."""
    if not math.isfinite(lat):
        return ""
    if lat < 35.2:
        return "south of Cape Hatteras"
    if lat < 36.55:
        return "Outer Banks (NC)"
    if lat < 37.95:
        return (
            "inside the Bay" if lon < -75.95 and lat > 36.95 else "Virginia Beach / Eastern Shore"
        )
    if lat < 38.6:
        return "Delmarva (MD/DE)"
    if lat < 40.5:
        return "Delaware Bay / New Jersey"
    return "Long Island and north"


# --- One drop day ---------------------------------------------------------------


def forecast_features(env, design, start: datetime, point, land, seed: int) -> dict:
    """What a forecast issued on the drop morning says: a 7-day dead drift and the
    mean wind at the drop point over the first 5 days."""
    from boatsim.oceandata.forecast import ErrorForecast

    fc = ErrorForecast(env, seed=seed).issue(start)
    tr: list = []
    r = DB.run_one(fc, design, start, "fc", FORECAST_DAYS, land, point=point, track_out=tr)
    h = tr[0]
    near = DB.distance_to_land_km(h["lat"].to_numpy()[1:], h["lon"].to_numpy()[1:])
    ws = [fc.sample(start + timedelta(hours=6 * i), *point) for i in range(int(WIND_DAYS * 4) + 1)]
    u = float(np.mean([w.wind_u for w in ws]))
    v = float(np.mean([w.wind_v for w in ws]))
    b = math.radians(ONSHORE_BEARING)
    return {
        "fc_aground7": bool(r["aground"]),
        "fc_min_land_km7": float(near.min()) if len(near) else math.nan,
        "fc_end_lat7": r["end_lat"],
        "fc_end_lon7": r["end_lon"],
        "fc_wind_u5": u,
        "fc_wind_v5": v,
        "fc_wind_onshore5": u * math.sin(b) + v * math.cos(b),
    }


def run_task(env, design, land, start: datetime, name: str, windage: float, forecast: bool):
    point = POINTS[name]
    tr: list = []
    r = DB.run_one(
        env, DB.with_windage(design, windage), start, name, 30.0, land, point=point, track_out=tr
    )
    r = {
        "start": start,
        "year": start.year,
        "point": name,
        "windage": windage,
        "aground": r["aground"],
        "aground_day": r["aground_day"],
        "aground_lat": r["aground_lat"],
        "aground_lon": r["aground_lon"],
        "area": area(r["aground_lat"], r["aground_lon"]) if r["aground"] else "",
        "gulf_stream": r["gulf_stream"],
        "days_near_land": r["days_near_land"],
        "end_lat": r["end_lat"],
        "end_lon": r["end_lon"],
    }
    if forecast:
        h = tr[0]
        first = h[(h["t"] - h["t"].iloc[0]) <= pd.Timedelta(days=FORECAST_DAYS)]
        near = DB.distance_to_land_km(first["lat"].to_numpy()[1:], first["lon"].to_numpy()[1:])
        r["tr_min_land_km7"] = float(near.min()) if len(near) else math.nan
        seed = start.toordinal() * 10 + list(POINTS).index(name)
        r.update(forecast_features(env, design, start, point, land, seed))
    return r


_W: dict = {}


def _init(design_path: str, constant: bool):
    from boatsim.config import load_design
    from boatsim.runner.land import default_land

    if constant:
        from boatsim.oceandata import ConstantEnvironment

        env = ConstantEnvironment()
    else:
        from boatsim.oceandata import ERA5Source, GlorysSource, ReanalysisEnvironment

        env = ReanalysisEnvironment(ERA5Source(), GlorysSource())
    _W.update(env=env, design=load_design(design_path), land=default_land())


def _call(task):
    r = run_task(_W["env"], _W["design"], _W["land"], *task)
    print(
        f"{r['start']:%Y-%m-%d} {r['point']:11s} x{r['windage']:.1f} "
        f"aground={r['aground']} day={r['aground_day']:.1f} {r['area']}",
        flush=True,
    )
    return r


def tasks_for(year: int, points, windages, hour: int = 12, days: list | None = None):
    out = []
    for t in days or drop_days(year, hour):
        for name in points:
            for w in windages:
                out.append((t, name, w, w == 1.0))
    return out


def run_year(year, points, windages, design_path, workers=4, hour=12, constant=False, days=None):
    tasks = tasks_for(year, points, windages, hour, days)
    if workers <= 1:
        _init(design_path, constant)
        rows = [_call(t) for t in tasks]
    else:
        from concurrent.futures import ProcessPoolExecutor

        with ProcessPoolExecutor(workers, initializer=_init, initargs=(design_path, constant)) as p:
            rows = list(p.map(_call, tasks, chunksize=4))
    return pd.DataFrame(rows)


# --- Report ---------------------------------------------------------------------


def runs_of_bad_days(g: pd.DataFrame, min_len: int = 3) -> list[tuple[date, date, int]]:
    """Consecutive drop days that all ran ashore (g: one point/windage/year, daily)."""
    g = g.sort_values("start")
    out, run = [], []
    for t, a in zip(g["start"], g["aground"], strict=True):
        if a:
            run.append(t)
        else:
            if len(run) >= min_len:
                out.append((run[0].date(), run[-1].date(), len(run)))
            run = []
    if len(run) >= min_len:
        out.append((run[0].date(), run[-1].date(), len(run)))
    return out


def strip(g: pd.DataFrame) -> str:
    """One character per drop day: X ran ashore, . stayed at sea, | at each new month."""
    g = g.sort_values("start")
    s, last = "", None
    for t, a in zip(g["start"], g["aground"], strict=True):
        if last is not None and t.month != last:
            s += "|"
        s += "X" if a else "."
        last = t.month
    return s


def _pct(n, d):
    return f"{n}/{d} ({n / d:.0%})" if d else "-"


def month_label(t) -> str:
    return "15-30 Apr" if t.month == 4 else t.strftime("%b")


def rule_table(base: pd.DataFrame, rules: list[tuple[str, pd.Series]]) -> list[str]:
    """Score no-go rules on one point at base windage, all years."""
    n, bad = len(base), int(base["aground"].sum())
    months = ["15-30 Apr", "May", "Jun"]
    mlab = base["start"].map(month_label)
    lines = [
        "| Rule: don't drop if... | Groundings avoided | Days turned away "
        + "".join(f"| Turned away, {m} " for m in months)
        + "| Ran ashore on days it allows |",
        "|---|---|---" + "|---" * len(months) + "|---|",
        f"| (no rule) | 0/{bad} | 0/{n} " + "| 0% " * len(months) + f"| {_pct(bad, n)} |",
    ]
    for label, nogo in rules:
        nogo = nogo.fillna(False).astype(bool)
        go = ~nogo
        avoided = int((nogo & base["aground"]).sum())
        cells = "".join(
            f"| {nogo[mlab == m].mean():.0%} " if (mlab == m).any() else "| - " for m in months
        )
        lines.append(
            f"| {label} | {_pct(avoided, bad)} | {_pct(int(nogo.sum()), n)} {cells}"
            f"| {_pct(int(base.loc[go, 'aground'].sum()), int(go.sum()))} |"
        )
    return lines


def candidate_rules(b: pd.DataFrame) -> list[tuple[str, pd.Series]]:
    rules = []
    for km in (25, 50, 75):
        rules.append(
            (f"forecast 7-day dead drift comes within {km} km of land", b["fc_min_land_km7"] < km)
        )
    rules.append(("forecast 7-day dead drift runs ashore", b["fc_aground7"]))
    for ms in (0.0, 2.0, 4.0):
        rules.append(
            (
                f"forecast 5-day mean wind blows toward the coast (WSW) at over {ms:g} m/s",
                b["fc_wind_onshore5"] > ms,
            )
        )
    for km in (25, 50):
        rules.append(
            (
                f"(perfect forecast, upper bound) 7-day drift comes within {km} km of land",
                b["tr_min_land_km7"] < km,
            )
        )
    return rules


def report_markdown(df: pd.DataFrame) -> str:
    df = df.copy()
    df["start"] = pd.to_datetime(df["start"])
    years = sorted(df["year"].unique())
    L = [
        "# Does the drop date matter more than the distance? (#163)",
        "",
        (
            "A dead boat (motors off, no steering) drifts for 30 days from every day, 15 April "
            f"to 30 June, {years[0]}-{years[-1]} (ERA5 wind and waves, GLORYS12 currents, 2 km "
            "land mask). 'Ran ashore' means it touched land within the 30 days. This is the "
            "worst case where the boat dies at the drop; a working boat motors away (#128)."
        ),
        "",
        "## Share that runs ashore",
        "",
        "| Start | Wind push | " + " | ".join(str(y) for y in years) + " | All years |",
        "|---|---|" + "---|" * (len(years) + 1),
    ]
    for name in POINTS:
        for w in sorted(WINDAGES):
            g = df[(df["point"] == name) & (df["windage"] == w)]
            if g.empty:
                continue
            cells = []
            for y in years:
                gy = g[g["year"] == y]
                cells.append(f"{gy['aground'].mean():.0%}" if len(gy) else "-")
            L.append(
                f"| {name} | x{w:g} ({WINDAGES[w]}) | "
                + " | ".join(cells)
                + f" | {_pct(int(g['aground'].sum()), len(g))} |"
            )
    L += [
        "",
        "## Day by day (our 100 km point, our wind push)",
        "",
        (
            "One character per drop day from 15 April: `X` ran ashore within 30 days, `.` stayed "
            "at sea, `|` marks the start of May and June."
        ),
        "",
        "```",
    ]
    base = df[(df["point"] == "100km") & (df["windage"] == 1.0)]
    for y in years:
        L.append(f"{y}  {strip(base[base['year'] == y])}")
    L += ["```", "", "By half-month, all years (share of drop days that ran ashore):", ""]
    half = base["start"].map(lambda t: (t.month, t.day > 15))
    names = {
        (4, True): "15-30 Apr",
        (5, False): "1-15 May",
        (5, True): "16-31 May",
        (6, False): "1-15 Jun",
        (6, True): "16-30 Jun",
    }
    L.append("| " + " | ".join(names.values()) + " |")
    L.append("|" + "---|" * len(names))
    L.append(
        "| "
        + " | ".join(
            _pct(int(base.loc[half == k, "aground"].sum()), int((half == k).sum())) for k in names
        )
        + " |"
    )
    L += ["", "Runs of 3 or more bad days in a row (100 km, our wind push):", ""]
    for y in years:
        runs = runs_of_bad_days(base[base["year"] == y])
        txt = ", ".join(f"{a:%d %b}-{b:%d %b} ({n} days)" for a, b, n in runs) or "none"
        L.append(f"- {y}: {txt}")
    L += ["", "## Where they come ashore", ""]
    a = df[df["aground"] & (df["windage"] == 1.0)]
    if len(a):
        tab = a.groupby(["point", "area"]).agg(n=("aground", "size"), day=("aground_day", "median"))
        L += ["| Start | Coast | Boats | Median days to ashore |", "|---|---|---|---|"]
        for (p, ar), r in tab.iterrows():
            L.append(f"| {p} | {ar} | {r.n} | {r.day:.0f} |")
    # 2023 side by side
    L += [
        "",
        "## 2023 next to the Randolph team's run",
        "",
        (
            "Their 16 drops every 3 days from 1 May, 100 km off Ocean City, 30 days, SMOC "
            "currents, MFWAM waves, ERA5 wind, leeway 3.3% (#50). Ours on the same dates."
        ),
        "",
        (
            "| Drop | Theirs | Ours, their point, x0.6 | Ours, their point, x1 "
            "| Ours, our 100 km, x0.6 | Ours, our 100 km, x1 |"
        ),
        "|---|---|---|---|---|---|",
    ]

    def cell(name, w, d):
        g = df[(df["point"] == name) & (df["windage"] == w) & (df["start"].dt.date == d)]
        if g.empty:
            return "-"
        r = g.iloc[0]
        return f"ashore day {r.aground_day:.0f}, {r.area}" if r.aground else "at sea"

    agree = {}
    for d, theirs in RANDOLPH_2023.items():
        row = [cell(n, w, d) for n, w in (("randolph100", 0.6), ("randolph100", 1.0))]
        row += [cell(n, w, d) for n, w in (("100km", 0.6), ("100km", 1.0))]
        L.append(f"| {d:%d %b} | {'ashore' if theirs else 'at sea'} | " + " | ".join(row) + " |")
        for k, c in zip(("rp0.6", "rp1", "us0.6", "us1"), row, strict=True):
            if c != "-":
                agree.setdefault(k, []).append(c.startswith("ashore") == theirs)
    if agree:
        L += [
            "",
            "Agreement with theirs: "
            + ", ".join(f"{k} {sum(v)}/{len(v)}" for k, v in agree.items() if v),
        ]
    # Go/no-go
    L += [
        "",
        "## A go/no-go rule from the forecast",
        "",
        (
            "Each rule uses only what a forecast issued on the drop morning says (ErrorForecast, "
            "#58: the truth plus error growing with lead time; its error sizes are still "
            "guesses). The perfect-forecast rows are an upper bound, not something John can have."
        ),
        "",
    ]
    for name in ("100km", "50km"):
        b = df[(df["point"] == name) & (df["windage"] == 1.0)].reset_index(drop=True)
        if b.empty or "fc_min_land_km7" not in b:
            continue
        L += [f"### {name}, all years", ""]
        L += rule_table(b, candidate_rules(b))
        L.append("")
    return "\n".join(L) + "\n"


# --- CLI ------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m boatsim.mc.dropday")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="every drop day of one year")
    r.add_argument("year", type=int)
    r.add_argument("--points", nargs="+", default=["100km", "50km"], choices=list(POINTS))
    r.add_argument("--windage", nargs="+", type=float, default=sorted(WINDAGES))
    r.add_argument("--hour", type=int, default=12)
    r.add_argument("--design", default="configs/v4_kayak.yaml")
    r.add_argument("--workers", type=int, default=4)
    r.add_argument("--out", default="runs/dropday")
    r.add_argument("--constant", action="store_true", help="test only: constant made-up weather")
    r.add_argument("--max-days", type=int, default=None, help="test only: first N drop days")
    s = sub.add_parser("report", help="combine per-year CSVs")
    s.add_argument("csvs", nargs="+")
    s.add_argument("--out", default="runs/dropday")
    a = p.parse_args(argv)

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.cmd == "run":
        days = drop_days(a.year, a.hour)[: a.max_days] if a.max_days else None
        if not a.constant:
            from boatsim.oceandata import era5

            need = sorted(
                {
                    (t + timedelta(days=i)).date()
                    for t in (days or drop_days(a.year, a.hour))
                    for i in range(-1, 33)
                }
            )
            era5.fetch_days(need, workers=a.workers)
        df = run_year(
            a.year, a.points, a.windage, a.design, a.workers, a.hour, a.constant, days=days
        )
        df.to_csv(out / f"dropday_{a.year}_{'_'.join(a.points)}.csv", index=False)
    else:
        df = pd.concat([pd.read_csv(x, parse_dates=["start"]) for x in a.csvs], ignore_index=True)
        df.to_csv(out / "dropday_all.csv", index=False)
        md = report_markdown(df)
        (out / "dropday_report.md").write_text(md)
        print(md)


if __name__ == "__main__":
    main()
