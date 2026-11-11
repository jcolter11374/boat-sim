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
import math
import time
from dataclasses import dataclass, replace
from datetime import UTC, datetime
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


# ----------------------------------------------------------------- prediction

# Doodson numbers (tau, s, h, p, N', p1) and the extra phase in degrees, for the
# constituents NOAA publishes (Schureman 1958, Table 2; Foreman 1977).
DOODSON = {
    "M2": ((2, 0, 0, 0, 0, 0), 0),
    "S2": ((2, 2, -2, 0, 0, 0), 0),
    "N2": ((2, -1, 0, 1, 0, 0), 0),
    "K1": ((1, 1, 0, 0, 0, 0), 90),
    "M4": ((4, 0, 0, 0, 0, 0), 0),
    "O1": ((1, -1, 0, 0, 0, 0), -90),
    "M6": ((6, 0, 0, 0, 0, 0), 0),
    "MK3": ((3, 1, 0, 0, 0, 0), 90),
    "S4": ((4, 4, -4, 0, 0, 0), 0),
    "MN4": ((4, -1, 0, 1, 0, 0), 0),
    "NU2": ((2, -1, 2, -1, 0, 0), 0),
    "S6": ((6, 6, -6, 0, 0, 0), 0),
    "MU2": ((2, -2, 2, 0, 0, 0), 0),
    "2N2": ((2, -2, 0, 2, 0, 0), 0),
    "OO1": ((1, 3, 0, 0, 0, 0), 90),
    "LAM2": ((2, 1, -2, 1, 0, 0), 180),
    "S1": ((1, 1, -1, 0, 0, 0), 180),
    "M1": ((1, 0, 0, 0, 0, 0), 90),  # GUESS: NOAA's M1 is a blend; small everywhere here
    "J1": ((1, 2, 0, -1, 0, 0), 90),
    "MM": ((0, 1, 0, -1, 0, 0), 0),
    "SSA": ((0, 0, 2, 0, 0, 0), 0),
    "SA": ((0, 0, 1, 0, 0, 0), 0),
    "MSF": ((0, 2, -2, 0, 0, 0), 0),
    "MF": ((0, 2, 0, 0, 0, 0), 0),
    "RHO": ((1, -2, 2, -1, 0, 0), -90),
    "Q1": ((1, -2, 0, 1, 0, 0), -90),
    "T2": ((2, 2, -3, 0, 0, 1), 0),
    "R2": ((2, 2, -1, 0, 0, -1), 180),
    "2Q1": ((1, -3, 0, 2, 0, 0), -90),
    "P1": ((1, 1, -2, 0, 0, 0), -90),
    "2SM2": ((2, 4, -4, 0, 0, 0), 0),
    "M3": ((3, 0, 0, 0, 0, 0), 180),
    "L2": ((2, 1, 0, -1, 0, 0), 180),
    "2MK3": ((3, -1, 0, 0, 0, 0), -90),
    "K2": ((2, 2, 0, 0, 0, 0), 0),
    "M8": ((8, 0, 0, 0, 0, 0), 0),
    "MS4": ((4, 2, -2, 0, 0, 0), 0),
}


def astro(t: datetime) -> dict:
    """Mean longitudes in degrees at t (UTC): the moon s, sun h, lunar perigee p,
    the moon's node N, solar perigee p1, and tau, mean lunar time."""
    t = t if t.tzinfo else t.replace(tzinfo=UTC)
    days = (t - datetime(2000, 1, 1, 12, tzinfo=UTC)).total_seconds() / 86400.0
    c = days / 36525.0
    s = 218.3165 + 481267.8813 * c
    h = 280.4661 + 36000.7698 * c
    p = 83.3535 + 4069.0137 * c
    n = 125.0445 - 1934.1363 * c
    p1 = 282.9384 + 1.7195 * c
    hours = (days % 1.0) * 24.0  # hours since noon UTC
    tau = 15.0 * hours + h - s  # 180 + 15 x (hours since midnight) = 15 x hours since noon
    return {"tau": tau, "s": s, "h": h, "p": p, "N": n, "p1": p1}


def nodal(name: str, n_deg: float) -> tuple[float, float]:
    """Nodal factor f and angle u (degrees) for the moon's node at N (Schureman's
    approximations); compound tides from their parts."""
    n = math.radians(n_deg)
    c1, c2, s1, s2 = math.cos(n), math.cos(2 * n), math.sin(n), math.sin(2 * n)
    m2 = (1 - 0.037 * c1, -2.1 * s1)
    k1 = (1.006 + 0.115 * c1 - 0.009 * c2, -8.9 * s1 + 0.7 * s2)
    o1 = (1.009 + 0.187 * c1 - 0.015 * c2, 10.8 * s1 - 1.3 * s2)
    table = {
        "M2": m2, "N2": m2, "2N2": m2, "NU2": m2, "MU2": m2, "LAM2": m2, "L2": m2,
        "K2": (1.024 + 0.286 * c1 + 0.008 * c2, -17.7 * s1 + 0.7 * s2),
        "K1": k1,
        "O1": o1, "Q1": o1, "2Q1": o1, "RHO": o1,
        "J1": (1.013 + 0.168 * c1 - 0.017 * c2, -12.9 * s1 + 1.3 * s2),
        "OO1": (1.160 + 0.664 * c1 + 0.087 * c2, -36.7 * s1 + 4.0 * s2),
        "M1": o1,
        "MF": (1.043 + 0.414 * c1, -23.7 * s1 + 2.7 * s2),
        "MM": (1 - 0.130 * c1, 0.0),
        "M4": (m2[0] ** 2, 2 * m2[1]), "MN4": (m2[0] ** 2, 2 * m2[1]),
        "M6": (m2[0] ** 3, 3 * m2[1]), "M8": (m2[0] ** 4, 4 * m2[1]),
        "MS4": m2, "2SM2": (m2[0], -m2[1]), "MSF": (m2[0], -m2[1]),
        "M3": (m2[0] ** 1.5, 1.5 * m2[1]),
        "MK3": (m2[0] * k1[0], m2[1] + k1[1]),
        "2MK3": (m2[0] ** 2 * k1[0], 2 * m2[1] - k1[1]),
    }  # fmt: skip
    return table.get(name, (1.0, 0.0))


@dataclass(frozen=True)
class Station:
    """A tidal current station: the current along its flood direction is
    mean + sum of f A cos(V + u - phase) over its constituents."""

    id: str
    name: str
    lat: float
    lon: float
    flood_dir: float  # degrees true the flood runs toward
    mean: float  # m/s along flood (a river's outflow shows as a negative mean)
    constituents: tuple[tuple[str, float, float], ...]  # (name, amplitude m/s, phase GMT deg)

    def speed(self, t: datetime) -> float:
        """Current along the flood direction, m/s (negative: ebb)."""
        a = astro(t)
        args = (a["tau"], a["s"], a["h"], a["p"], -a["N"], a["p1"])
        v = self.mean
        for name, amp, phase in self.constituents:
            d = DOODSON.get(name.upper())
            if d is None:
                continue
            f, u = nodal(name.upper(), a["N"])
            arg = sum(k * x for k, x in zip(d[0], args, strict=True)) + d[1] + u - phase
            v += f * amp * math.cos(math.radians(arg))
        return v

    def uv(self, t: datetime) -> tuple[float, float]:
        sp, r = self.speed(t), math.radians(self.flood_dir)
        return sp * math.sin(r), sp * math.cos(r)


RADIUS_KM = 12.0  # GUESS: how far a station's current is taken to reach


def _km(lat1, lon1, lat2, lon2) -> float:
    dy = (lat1 - lat2) * 111.2
    dx = (lon1 - lon2) * 111.2 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dx, dy)


class TidalCurrents:
    """An Environment with the tide added to its currents near the stations.

    At a point within RADIUS_KM of stations: their currents weighted by inverse
    distance, faded to nothing at RADIUS_KM from the nearest. Anywhere else the
    inner Environment's sample comes back unchanged, the same object."""

    def __init__(self, env, stations, radius_km: float = RADIUS_KM):
        self.env, self.stations, self.radius_km = env, list(stations), radius_km

    def __getattr__(self, name):  # weather grids, storms, meta: the inner env's
        return getattr(self.env, name)

    def tide(self, t: datetime, lat: float, lon: float) -> tuple[float, float]:
        near = [(_km(lat, lon, s.lat, s.lon), s) for s in self.stations]
        near = [(d, s) for d, s in near if d < self.radius_km]
        if not near:
            return 0.0, 0.0
        w = [1.0 / max(d, 0.5) for d, _ in near]
        fade = 1.0 - min(d for d, _ in near) / self.radius_km
        u = v = 0.0
        for wi, (_, s) in zip(w, near, strict=True):
            su, sv = s.uv(t)
            u, v = u + wi * su, v + wi * sv
        return fade * u / sum(w), fade * v / sum(w)

    def sample(self, t: datetime, lat: float, lon: float):
        e = self.env.sample(t, lat, lon)
        u, v = self.tide(t, lat, lon)
        if u == 0.0 and v == 0.0:
            return e
        return replace(e, current_u=e.current_u + u, current_v=e.current_v + v)


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
