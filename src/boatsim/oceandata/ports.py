"""Ports to sail from: a public-domain port list, each with a launch point at sea.

For "sail from any port". A port sits in a harbour, often up a bay or river,
where the simulator's 2 km land mask (runner/land.py) would put the boat
aground at once. So each port gets a launch point: the nearest spot that is
open Atlantic (water joined to mid-ocean on the land mask) at least
``CLEAR_KM`` from any land, which is where a support boat would drop the kayak,
as ours does 100 km off the Bay mouth.

Source: Natural Earth 1:10m ports (public domain), the same family as the land
mask. Ports with no open water within ``SEARCH_KM`` (the Great Lakes, up the
St Lawrence) are left out.

Each port says whether its launch point is inside the browser bundles'
corridor (sandbox.forcing.CORRIDOR, 28-50N, 78-8W): only those can sail in the
in-browser game today. The rest need the corridor widened (bigger bundles).

    curl -sSLO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_ports.geojson
    python -m boatsim.oceandata.ports ne_10m_ports.geojson --out sea3d/public/ports.json
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

SOURCE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
    "ne_10m_ports.geojson"
)
CLEAR_KM = 20.0  # GUESS: far enough out that a day's drift doesn't beach the boat
SEARCH_KM = 350.0  # Baltimore is about 300 km by water from open sea
SNAP_KM = 12.0  # how far from the quay the open water may start (rivers, docks)
OCEAN_SEED = (40.0, -40.0)  # mid-Atlantic: the water joined to it is "open Atlantic"
CORRIDOR = (28.0, 50.0, -78.0, -8.0)  # lat_min, lat_max, lon_min, lon_max (= sandbox.forcing)
KM_PER_DEG = 111.2


@dataclass(frozen=True)
class Port:
    name: str
    lat: float
    lon: float
    launch_lat: float
    launch_lon: float
    launch_km: float  # port to launch point by water (roughly: 8-way steps on the mask)
    in_corridor: bool  # the launch point is inside the browser bundles


def read_ports(geojson: str | Path, box) -> list[tuple[str, float, float]]:
    """(name, lat, lon) of the source's ports inside box (lat0, lat1, lon0, lon1)."""
    lat0, lat1, lon0, lon1 = box
    out = []
    for f in json.loads(Path(geojson).read_text(encoding="utf-8"))["features"]:
        lon, lat = f["geometry"]["coordinates"][:2]
        if lat0 <= lat < lat1 and lon0 <= lon < lon1:
            out.append((str(f["properties"]["name"]).strip(), float(lat), float(lon)))
    return sorted(out)


def open_ocean(mask, seed=OCEAN_SEED) -> np.ndarray:
    """Water cells joined to mid-Atlantic (bays and sounds open to the sea count)."""
    from scipy import ndimage

    lab, _ = ndimage.label(~mask.mask)
    i = int((seed[0] - mask.lat0) / mask.res)
    j = int((seed[1] - mask.lon0) / mask.res)
    return lab == lab[i, j]


def launch_point(mask, ocean: np.ndarray, lat: float, lon: float, clear_km=CLEAR_KM):
    """The nearest open-Atlantic cell centre at least clear_km from land, by water
    (out of the harbour and down the bay, not across a peninsula), and the length
    of that water path in km; None when there is none within SEARCH_KM by water."""
    from scipy import ndimage

    r = mask.res
    dy = r * KM_PER_DEG
    dx = r * KM_PER_DEG * math.cos(math.radians(lat))
    # A window big enough to search, plus clear_km so the clearance near its edge is right.
    ri = math.ceil((SEARCH_KM + clear_km) / dy)
    rj = math.ceil((SEARCH_KM + clear_km) / dx)
    i, j = int((lat - mask.lat0) / r), int((lon - mask.lon0) / r)
    i0, i1 = max(i - ri, 0), min(i + ri + 1, mask.nlat)
    j0, j1 = max(j - rj, 0), min(j + rj + 1, mask.nlon)
    if not (i0 <= i < i1 and j0 <= j < j1):
        return None
    water = ~mask.mask[i0:i1, j0:j1]
    target = (ndimage.distance_transform_edt(water, sampling=(dy, dx)) >= clear_km) & ocean[
        i0:i1, j0:j1
    ]
    # Start on open water at the port: the mask puts coasts up to a cell seaward,
    # and a narrow river or dock is land on it, so take the sea within SNAP_KM.
    seed = np.zeros_like(water)
    seed[i - i0, j - j0] = True
    snap = max(1, round(SNAP_KM / min(dx, dy)))
    eight = np.ones((3, 3), bool)
    reached = ndimage.binary_dilation(seed, eight, iterations=snap) & ocean[i0:i1, j0:j1]
    if not reached.any():
        return None
    step_km = min(dx, dy)  # one 8-connected step covers at least this
    km = 0.0
    while not (reached & target).any():
        grown = ndimage.binary_dilation(reached, eight) & water
        if km > SEARCH_KM or (grown == reached).all():
            return None
        reached, km = grown, km + step_km
    ii, jj = np.nonzero(reached & target)
    la = mask.lat0 + (ii + i0 + 0.5) * r
    lo = mask.lon0 + (jj + j0 + 0.5) * r
    d = np.hypot((la - lat) * KM_PER_DEG, (lo - lon) * KM_PER_DEG * math.cos(math.radians(lat)))
    k = int(d.argmin())  # of the first cells reached, the one closest to the port
    # The path length: at least the straight line, and steps of a cell or more.
    return float(la[k]), float(lo[k]), float(max(km, d[k]))


def in_corridor(lat: float, lon: float) -> bool:
    a, b, c, d = CORRIDOR
    return a <= lat <= b and c <= lon <= d


def build(geojson: str | Path, mask=None, log=print) -> list[Port]:
    from boatsim.runner.land import LandMask

    mask = mask or LandMask.load()
    box = (mask.lat0, mask.lat0 + mask.nlat * mask.res, mask.lon0, mask.lon0 + mask.nlon * mask.res)
    ocean = open_ocean(mask, OCEAN_SEED)
    ports, skipped = [], []
    seen = set()
    for name, lat, lon in read_ports(geojson, box):
        if (name, round(lat, 2), round(lon, 2)) in seen:  # the source lists a few twice
            continue
        seen.add((name, round(lat, 2), round(lon, 2)))
        lp = launch_point(mask, ocean, lat, lon)
        if lp is None:
            skipped.append(name)
            continue
        la, lo, km = lp
        ports.append(
            Port(name, lat, lon, round(la, 3), round(lo, 3), round(km, 1), in_corridor(la, lo))
        )
    log(
        f"{len(ports)} ports with open Atlantic within {SEARCH_KM:.0f} km by water "
        f"({sum(p.in_corridor for p in ports)} inside the browser corridor); "
        f"left out {len(skipped)}: {', '.join(skipped)}"
    )
    return ports


def dumps(ports: list[Port]) -> str:
    return (
        json.dumps(
            {
                "ports": [asdict(p) for p in ports],
                "clear_km": CLEAR_KM,
                "source": "Natural Earth 1:10m ports (public domain), " + SOURCE_URL,
                "notes": "launch_*: nearest open-Atlantic point at least clear_km from land "
                "on the simulator's land mask; in_corridor: inside the browser bundles.",
            },
            indent=1,
            ensure_ascii=False,
        )
        + "\n"
    )


def main(argv: list[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Ports to sail from, with launch points at sea")
    ap.add_argument("geojson", help="Natural Earth ne_10m_ports.geojson")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    Path(a.out).write_text(dumps(build(a.geojson)), encoding="utf-8")


if __name__ == "__main__":
    main()
