"""Data commands, run in a cloud sandbox or GitHub Actions:

python -m boatsim.oceandata fetch-era5 2020-10-01 2020-12-31 [--workers 4]
python -m boatsim.oceandata fetch-glorys 2020-10 2020-12      (needs Copernicus login)
python -m boatsim.oceandata sample 2020-10-15T12:00 37.0 -70.0 [--no-currents]
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
    s = sub.add_parser("sample", help="print the environment at one point")
    s.add_argument("t", type=datetime.fromisoformat)
    s.add_argument("lat", type=float)
    s.add_argument("lon", type=float)
    s.add_argument("--no-currents", action="store_true")
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
    elif a.cmd == "sample":
        env = ReanalysisEnvironment(currents=None if a.no_currents else glorys.GlorysSource())
        print(env.sample(a.t, a.lat, a.lon))


if __name__ == "__main__":
    main()
