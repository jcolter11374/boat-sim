"""Ports to sail from: a public-domain port list, each with a launch point at sea.

For "sail from any port". A port sits in a harbour, often up a bay or river,
where the simulator's 2 km land mask (runner/land.py) would put the boat
aground at once. So each port gets a launch point: the nearest spot that is
open Atlantic (water joined to mid-ocean on the land mask) at least
``CLEAR_KM`` from any land, from which the launch route (straight, great
circle, to the finish target: runner/simulate.default_mission) stays
``ROUTE_CLEAR_KM`` clear of land. That is where a support boat would drop the
kayak, as ours does 100 km off the Bay mouth. Without the route check, a launch
point inside Placentia Bay or off New York had its route run straight over a
headland or Nantucket, and the boats ran aground on day 0 (Ravi, #246).

Source: Natural Earth 1:10m ports (public domain), the same family as the land
mask. Ports with no such point within ``SEARCH_KM`` by water (the Great Lakes, the
St Lawrence and most of its Gulf) are left out.

Each port says whether its launch point is inside the browser bundles'
corridor (sandbox.forcing.CORRIDOR, 28-50N, 78-8W), at least ``EDGE_DEG``
inside its edge (a weather cell, so the boat never starts on the grid's
border): only those can sail in the in-browser game today. The rest need the corridor widened (bigger bundles).

    curl -sSLO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_ports.geojson
    python -m boatsim.oceandata.ports ne_10m_ports.geojson --out sea3d/public/ports.json
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, replace
from functools import lru_cache
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
ROUTE_CLEAR_KM = 10.0  # GUESS: the launch route's closest allowed approach to land
ROUTE_STEP_KM = 2.0  # the route is checked at points this far apart (the mask's cell size)
CORRIDOR = (28.0, 50.0, -78.0, -8.0)  # lat_min, lat_max, lon_min, lon_max (= sandbox.forcing)
EDGE_DEG = 1.0  # a launch point at least one weather cell inside the corridor
FINISH = (39.5, -13.5)  # = runner.arrival.DEFAULT_TARGET (checked in the tests)
KM_PER_DEG = 111.2


@dataclass(frozen=True)
class Port:
    id: str  # the name as a slug; "-37n-76w" added where two ports share a name
    name: str
    lat: float
    lon: float
    launch_lat: float
    launch_lon: float
    launch_km: float  # port to launch point by water (roughly: 8-way steps on the mask)
    in_corridor: bool  # the launch point is inside the browser bundles
    # The straight line from the launch point to the finish target crosses the
    # race's western start line (runner/arrival.py), so a voyage from here can
    # start under the Microtransat rules. False for the Azores, Iberia and Bermuda.
    crosses_start: bool


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


def great_circle(a, b, step_km=ROUTE_STEP_KM) -> tuple[np.ndarray, np.ndarray]:
    """(lats, lons) of points every step_km or less along the great circle a to b."""
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    v1 = np.array([math.cos(la1) * math.cos(lo1), math.cos(la1) * math.sin(lo1), math.sin(la1)])
    v2 = np.array([math.cos(la2) * math.cos(lo2), math.cos(la2) * math.sin(lo2), math.sin(la2)])
    om = math.acos(float(np.clip(v1 @ v2, -1.0, 1.0)))
    if om < 1e-9:
        return np.array([a[0]]), np.array([a[1]])
    t = np.linspace(0.0, 1.0, int(om * 6371.0 / step_km) + 2)[:, None]
    v = (np.sin((1 - t) * om) * v1 + np.sin(t * om) * v2) / math.sin(om)
    return np.degrees(np.arcsin(v[:, 2])), np.degrees(np.arctan2(v[:, 1], v[:, 0]))


def land_km(mask) -> np.ndarray:
    """Each cell's distance to the nearest land cell, km (cells east-west sized at
    45N: about 20% long at 28N and short at 50N, inside ROUTE_CLEAR_KM's guess)."""
    from scipy import ndimage

    dy = mask.res * KM_PER_DEG
    dx = dy * math.cos(math.radians(45.0))
    return ndimage.distance_transform_edt(~mask.mask, sampling=(dy, dx))


def route_clear(mask, near: np.ndarray, lat, lon, target=FINISH, margin_km=ROUTE_CLEAR_KM):
    """True when the great circle from (lat, lon) to target keeps margin_km from
    land everywhere on the mask (near = land_km(mask)); off the mask counts as sea."""
    la, lo = great_circle((lat, lon), target)
    i = ((la - mask.lat0) // mask.res).astype(int)
    j = ((lo - mask.lon0) // mask.res).astype(int)
    on = (i >= 0) & (i < mask.nlat) & (j >= 0) & (j < mask.nlon)
    return bool((near[i[on], j[on]] >= margin_km).all())


def launch_point(mask, ocean: np.ndarray, lat: float, lon: float, clear_km=CLEAR_KM, route_ok=None):
    """The nearest open-Atlantic cell centre at least clear_km from land, by water
    (out of the harbour and down the bay, not across a peninsula), and the length
    of that water path in km; None when there is none within SEARCH_KM by water.
    route_ok(lat, lon), when given, must also hold there (the launch route clears land)."""
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
    tried = np.zeros_like(water)  # cells whose route was checked and crosses land
    while True:
        ii, jj = np.nonzero(reached & target & ~tried)
        la = mask.lat0 + (ii + i0 + 0.5) * r
        lo = mask.lon0 + (jj + j0 + 0.5) * r
        d = np.hypot((la - lat) * KM_PER_DEG, (lo - lon) * KM_PER_DEG * math.cos(math.radians(lat)))
        # Of the first cells reached, the one closest to the port whose route is clear.
        for k in np.argsort(d, kind="stable"):
            if d[k] > SEARCH_KM:  # by water is never shorter than the straight line
                break
            if route_ok is None or route_ok(float(la[k]), float(lo[k])):
                # The path length: at least the straight line, and steps of a cell or more.
                return float(la[k]), float(lo[k]), float(max(km, d[k]))
            tried[ii[k], jj[k]] = True
        grown = ndimage.binary_dilation(reached, eight) & water
        if km > SEARCH_KM or (grown == reached).all():
            return None
        reached, km = grown, km + step_km


def crosses_start(lat: float, lon: float) -> bool:
    from boatsim.runner.arrival import DEFAULT_TARGET, WEST_LINE, crosses

    return crosses(WEST_LINE, (lat, lon), DEFAULT_TARGET)


def slug(name: str) -> str:
    import re
    import unicodedata

    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")


def in_corridor(lat: float, lon: float, edge=EDGE_DEG) -> bool:
    a, b, c, d = CORRIDOR
    return a + edge <= lat <= b - edge and c + edge <= lon <= d - edge


def build(geojson: str | Path, mask=None, log=print) -> list[Port]:
    from boatsim.runner.land import LandMask

    mask = mask or LandMask.load()
    box = (mask.lat0, mask.lat0 + mask.nlat * mask.res, mask.lon0, mask.lon0 + mask.nlon * mask.res)
    ocean = open_ocean(mask, OCEAN_SEED)
    near = land_km(mask)

    def route_ok(la, lo):
        return route_clear(mask, near, la, lo)

    ports, skipped = [], []
    seen = set()
    for name, lat, lon in read_ports(geojson, box):
        if (name, round(lat, 2), round(lon, 2)) in seen:  # the source lists a few twice
            continue
        seen.add((name, round(lat, 2), round(lon, 2)))
        lp = launch_point(mask, ocean, lat, lon, route_ok=route_ok)
        if lp is None:
            skipped.append(name)
            continue
        la, lo, km = lp
        la, lo = round(la, 3), round(lo, 3)
        ports.append(
            Port(
                slug(name),
                name,
                lat,
                lon,
                la,
                lo,
                round(km, 1),
                in_corridor(la, lo),
                crosses_start(la, lo),
            )
        )
    # Unique ids: a shared name gets its whole-degree position.
    names = [p.id for p in ports]
    ports = [
        replace(p, id=f"{p.id}-{abs(p.lat):.0f}{'ns'[p.lat < 0]}-{abs(p.lon):.0f}{'ew'[p.lon < 0]}")
        if names.count(p.id) > 1
        else p
        for p in ports
    ]
    log(
        f"{len(ports)} ports with open Atlantic and a clear launch route within "
        f"{SEARCH_KM:.0f} km by water "
        f"({sum(p.in_corridor for p in ports)} inside the browser corridor, "
        f"{sum(p.in_corridor and p.crosses_start for p in ports)} of them west of the start line); "
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
                "route_clear_km": ROUTE_CLEAR_KM,
                "notes": "launch_*: nearest open-Atlantic point at least clear_km from land "
                "on the simulator's land mask whose straight route to the finish stays "
                "route_clear_km from land; in_corridor: inside the browser bundles, a "
                "weather cell clear of their edge; "
                "crosses_start: the line from the launch point to the finish crosses the "
                "race start line.",
            },
            indent=1,
            ensure_ascii=False,
        )
        + "\n"
    )


PORTS_JSON = "sea3d/public/ports.json"  # also in the browser pack (sandbox PACK_FILES)


def load(path: str | Path | None = None) -> dict[str, dict]:
    """The published ports by id. Looked for from the working directory (the
    browser pack's root, or the repo) and then from the repo this file is in.
    Read once (each new or shared game asks) and shared: callers must not change it."""
    return _load(str(path) if path else None)


@lru_cache(maxsize=4)
def _load(path: str | None) -> dict[str, dict]:
    tries = (
        [Path(path)]
        if path
        else [Path(PORTS_JSON), Path(__file__).resolve().parents[3] / PORTS_JSON]
    )
    for f in tries:
        if f.exists():
            return {p["id"]: p for p in json.loads(f.read_text(encoding="utf-8"))["ports"]}
    raise FileNotFoundError(PORTS_JSON)


def main(argv: list[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Ports to sail from, with launch points at sea")
    ap.add_argument("geojson", help="Natural Earth ne_10m_ports.geojson")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    Path(a.out).write_text(dumps(build(a.geojson)), encoding="utf-8")


if __name__ == "__main__":
    main()
