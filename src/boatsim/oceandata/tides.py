"""Tidal currents near the shore, from NOAA's published harmonic constants.

The reanalysis currents (GLORYS, SMOC) are daily means, so they leave out the
tide. In the open ocean that hardly matters, but in the Chesapeake Bay mouth
and up the Bay the tide runs at up to about a metre a second and turns every
six hours. This module predicts it at NOAA CO-OPS tidal current stations from
their harmonic constants (public domain, US Government work) and offers it as
an optional layer added to an Environment's currents near those stations.

Fetching needs NOAA's API, which the thread sandboxes can't reach: run the
"Tide currents" workflow. It saves the raw station list, each station's
constants and three days of NOAA's own predictions (to check ours against).

    python -m boatsim.oceandata.tides fetch --out runs/tides
"""

from __future__ import annotations

import json
import time
from pathlib import Path

MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi"
DATAGETTER = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
APP = "boatsim"  # NOAA asks API users to name their application

# lat0, lat1, lon0, lon1: where near-shore starts and the Bay trial sail.
AREAS = {
    "baymouth": (36.75, 37.35, -76.45, -75.6),  # the Bay mouth and Hampton Roads
    "annapolis": (38.75, 39.2, -76.65, -76.25),  # Annapolis, the Severn, the Bay Bridge
    "gulf_of_maine": (42.0, 45.2, -71.2, -66.5),  # the US side of the Fundy group's water
}
CHECK_DAYS = ("20240501", "20240503")  # NOAA's predictions to compare ours with


def _get(url: str, params: dict | None = None, tries: int = 4) -> dict:
    import requests

    for k in range(tries):
        try:
            r = requests.get(url, params=params, timeout=60)
            r.raise_for_status()
            return r.json()
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(2 ** (k + 1))
    raise AssertionError


def in_area(lat: float, lon: float) -> str | None:
    for name, (a, b, c, d) in AREAS.items():
        if a <= lat <= b and c <= lon <= d:
            return name
    return None


def fetch(out: Path, log=print) -> dict:
    """Save NOAA's raw JSON for every current-prediction station in AREAS."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    listing = _get(f"{MDAPI}/stations.json", {"type": "currentpredictions", "units": "metric"})
    (out / "stations_all.json").write_text(json.dumps(listing))
    found = []
    for s in listing.get("stations", []):
        lat, lon = float(s.get("lat", 0)), float(s.get("lng", 0))
        area = in_area(lat, lon)
        if area:
            found.append({**s, "area": area})
    log(f"{len(found)} current stations in {', '.join(AREAS)}")
    summary = []
    for s in found:
        sid, b = s["id"], s.get("currbin")
        tag = f"{sid}_{b}" if b is not None else sid
        row = {"id": sid, "bin": b, "name": s.get("name"), "lat": s.get("lat"), "lng": s.get("lng")}
        row |= {"type": s.get("type"), "area": s["area"]}
        try:
            q = {"units": "metric"} | ({"bin": b} if b is not None else {})
            h = _get(f"{MDAPI}/stations/{sid}/harcon.json", q)
            (out / f"harcon_{tag}.json").write_text(json.dumps(h))
            row["constituents"] = len(h.get("HarmonicConstituents", []) or [])
        except Exception as e:  # noqa: BLE001  subordinate stations have no constants
            row["harcon_error"] = repr(e)[:120]
        try:
            q = {"product": "currents_predictions", "station": sid, "units": "metric"}
            q |= {"time_zone": "gmt", "format": "json", "application": APP, "interval": "30"}
            q |= {"begin_date": CHECK_DAYS[0], "end_date": CHECK_DAYS[1]}
            if b is not None:
                q["bin"] = b
            p = _get(DATAGETTER, q)
            (out / f"pred_{tag}.json").write_text(json.dumps(p))
            row["predictions"] = len((p.get("current_predictions") or {}).get("cp", []))
        except Exception as e:  # noqa: BLE001
            row["pred_error"] = repr(e)[:120]
        summary.append(row)
        log(json.dumps(row))
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    return {"stations": summary}


def main(argv: list[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="NOAA tidal current constants near shore")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--out", default="runs/tides")
    a = ap.parse_args(argv)
    if a.cmd == "fetch":
        fetch(Path(a.out))


if __name__ == "__main__":
    main()
