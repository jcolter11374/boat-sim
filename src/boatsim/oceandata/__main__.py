"""Data commands, run in a cloud sandbox or GitHub Actions:

python -m boatsim.oceandata fetch-era5 2020-10-01 2020-12-31 [--workers 4]
python -m boatsim.oceandata fetch-glorys 2020-10 2020-12      (needs Copernicus login)
python -m boatsim.oceandata fetch-smoc 2022-04 2022-05 --kind total  (Copernicus login)
python -m boatsim.oceandata sample 2020-10-15T12:00 37.0 -70.0 [--no-currents]
python -m boatsim.oceandata check-storms ibtracs.NA.list.v04r01.csv 2012 2021  (Actions)
python -m boatsim.oceandata build-ships shipdensity_global.tif   (GitHub Actions; see traffic.py)
"""

from __future__ import annotations

import argparse
import time
from datetime import date, datetime

from boatsim.oceandata import era5, glorys
from boatsim.oceandata.reanalysis import ReanalysisEnvironment


def _months(a: str, b: str) -> list[tuple[int, int]]:
    y, m = map(int, a.split("-"))
    y2, m2 = map(int, b.split("-"))
    out = []
    while (y, m) <= (y2, m2):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def check_glorys(month: str) -> None:
    """Report file size and the fastest surface current off Cape Hatteras.

    The Gulf Stream there typically runs at roughly 1 to 2 m/s; a value far
    outside that means a units, depth or grid problem, not a fast ocean."""
    import numpy as np
    import xarray as xr

    y, m = map(int, month.split("-"))
    path = glorys.tile_path(y, m)
    with xr.open_dataset(path) as ds:
        days = ds.sizes["time"]
        box = ds.sel(lat=slice(33, 40), lon=slice(-77, -65))
        speed = np.hypot(box.current_u, box.current_v).max("time")
        i = np.unravel_index(int(np.nanargmax(speed.values)), speed.shape)
        lat, lon = float(box.lat[i[0]]), float(box.lon[i[1]])
        print(f"{path}: {path.stat().st_size / 1e6:.1f} MB for {days} days")
        print(
            f"fastest current off Hatteras: {float(speed.values[i]):.2f} m/s at {lat:.2f}N {lon:.2f}E"
        )
        print(f"ocean grid points with data: {int(np.isfinite(ds.current_u[0]).sum())}")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m boatsim.oceandata")
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch-era5", help="cache ERA5 days for the route box")
    f.add_argument("start", type=date.fromisoformat)
    f.add_argument("end", type=date.fromisoformat)
    f.add_argument("--workers", type=int, default=4)
    f.add_argument("--measure", action="store_true", help="also count bytes pulled")
    g = sub.add_parser("fetch-glorys", help="cache GLORYS12 surface-current months")
    g.add_argument("start", help="YYYY-MM")
    g.add_argument("end", help="YYYY-MM")
    sm = sub.add_parser("fetch-smoc", help="cache SMOC surface-current months (#73)")
    sm.add_argument("start", help="YYYY-MM")
    sm.add_argument("end", help="YYYY-MM")
    sm.add_argument("--kind", choices=["model", "total"], default="model")
    c = sub.add_parser("check-glorys", help="print size and Gulf Stream speed for a cached month")
    c.add_argument("month", help="YYYY-MM")
    s = sub.add_parser("sample", help="print the environment at one point")
    s.add_argument("t", type=datetime.fromisoformat)
    s.add_argument("lat", type=float)
    s.add_argument("lon", type=float)
    s.add_argument("--no-currents", action="store_true")
    b = sub.add_parser("build-ships", help="build the ship-density grid (needs EMODnet access)")
    b.add_argument("world_bank_tif", help="shipdensity_global.tif from the World Bank zip")
    b.add_argument("--out", default=None)
    h = sub.add_parser("check-storms", help="compare ERA5 storm winds with IBTrACS")
    h.add_argument("ibtracs_csv")
    h.add_argument("first_year", type=int)
    h.add_argument("last_year", type=int)
    h.add_argument("--workers", type=int, default=4)
    h.add_argument("--out", default="runs/storms/era5_vs_ibtracs.csv")
    sub.add_parser(
        "compare-currents", help="GLORYS vs SMOC on the shared Gulf Stream stretch (#73)"
    )
    bq = sub.add_parser("check-buoys", help="ERA5 waves and wind vs NDBC buoys for a year (#10)")
    bq.add_argument("year", type=int)
    bq.add_argument("--workers", type=int, default=4)
    a = p.parse_args(argv)

    if a.cmd == "fetch-era5":
        days = era5.days_between(a.start, a.end)
        t0 = time.monotonic()
        stats = era5.fetch_days(days, workers=a.workers, measure=a.measure)
        disk = sum(x.bytes_on_disk for x in stats)
        pulled = sum(x.bytes_transferred for x in stats if x.bytes_transferred > 0)
        print(f"{len(days)} days in {time.monotonic() - t0:.0f} s; on disk {disk / 1e6:.0f} MB")
        if a.measure:
            print(f"pulled from cloud: {pulled / 1e9:.2f} GB")
    elif a.cmd == "fetch-glorys":
        for y, m in _months(a.start, a.end):
            path = glorys.fetch_month(y, m)
            print(f"{path} {path.stat().st_size / 1e6:.1f} MB")
    elif a.cmd == "fetch-smoc":
        import numpy as np
        import xarray as xr

        from boatsim.oceandata import smoc

        for y, m in _months(a.start, a.end):
            path = smoc.fetch_month(y, m, a.kind)
            with xr.open_dataset(path) as ds:
                speed = np.hypot(ds.current_u, ds.current_v)
                print(
                    f"{path} {path.stat().st_size / 1e6:.1f} MB, {ds.sizes['time']} times "
                    f"{str(ds.time.values[0])[:16]} to {str(ds.time.values[-1])[:16]}, "
                    f"grid {ds.sizes['lat']}x{ds.sizes['lon']}, "
                    f"mean speed {float(speed.mean()):.2f} m/s, "
                    f"99th percentile {float(speed.quantile(0.99)):.2f} m/s"
                )
    elif a.cmd == "check-glorys":
        check_glorys(a.month)
    elif a.cmd == "compare-currents":
        from pathlib import Path

        import pandas as pd

        from boatsim.oceandata import currents_check as cc

        rows = cc.run()
        Path("runs/currents").mkdir(parents=True, exist_ok=True)
        pd.DataFrame(rows).to_csv("runs/currents/glorys_vs_smoc.csv", index=False)
        cc.summarise(rows)
        print(f"\nOpen-Meteo vs SMOC total, {cc.DATES[2]} daily means:")
        cc.open_meteo_check(cc.DATES[2])
    elif a.cmd == "check-buoys":
        from pathlib import Path

        from boatsim.oceandata import buoys

        pairs, table, bands = buoys.run(a.year, workers=a.workers)
        out = Path("runs/buoys")
        out.mkdir(parents=True, exist_ok=True)
        pairs.to_csv(out / f"pairs_{a.year}.csv")
        table.to_csv(out / f"stats_{a.year}.csv", index=False)
        bands.to_csv(out / f"by_height_{a.year}.csv", index=False)
        buoys.report(table, bands)
    elif a.cmd == "check-storms":
        from pathlib import Path

        from boatsim.oceandata import storms

        res, _ = storms.run(a.ibtracs_csv, a.first_year, a.last_year, a.workers)
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        res.to_csv(a.out, index=False)
        print(f"wrote {a.out}")
    elif a.cmd == "build-ships":
        from pathlib import Path

        from boatsim.oceandata import traffic

        out = traffic.build(Path(a.out) if a.out else traffic.DEFAULT_PATH, a.world_bank_tif)
        print(f"{out} {out.stat().st_size / 1e6:.1f} MB")
    elif a.cmd == "sample":
        env = ReanalysisEnvironment(currents=None if a.no_currents else glorys.GlorysSource())
        print(env.sample(a.t, a.lat, a.lon))


if __name__ == "__main__":
    main()
