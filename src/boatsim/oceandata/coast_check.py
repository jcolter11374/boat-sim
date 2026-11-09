"""Is the 2 km land map right near the Bay mouth? (issue #11)

The first days after the drop are when a dead or weak boat is most likely to
go ashore, and the lower Chesapeake is where a 2 km grid is coarsest compared
with what matters: the Hampton Roads passage is only about 3 km wide.

The map under test is data/land/land_mask_v1.npz (runner/land.py, #75). It
is built from Natural Earth 1:10m land. A 0.02 degree cell is land when its
centre is on land OR it holds a coastline vertex, so coasts move up to one
cell (about 2 km) seaward.

Three checks on 36.5-37.6N, 76.6-75.4W:
1. Named points: water where a boat can go (the channels, Hampton Roads, the
   lower James and York rivers, the drop point) and land at the capes.
2. Connected water: starting from the drop point, can a boat drifting cell by
   cell (8 neighbours) reach each named water point? A channel the mask
   closes shows up here even if the point itself is water.
3. A finer coastline: each cell's land fraction from a reference coastline,
   sampled 5 x 5 per cell. Cells the mask calls land but are mostly water
   (and the other way round) are counted and listed. References: Natural
   Earth 1:10m itself (shows what the coastline-vertex rule adds), and GSHHG
   full resolution (Wessel and Smith 1996, doi:10.1029/96JB00104; LGPL),
   whose eastern US shore comes from NOAA's World Vector Shoreline. GSHHG
   is reachable from GitHub Actions, not from thread sandboxes.
"""

from __future__ import annotations

from collections import deque

import numpy as np

REGION = (36.5, 37.6, -76.6, -75.4)  # lat_min, lat_max, lon_min, lon_max
DROP = (36.85, -75.70)
SUB = 5  # reference samples per cell side

# (lat, lon, should be land, name). Positions from NOAA chart 12221 (GUESS
# to about 0.01 degree, read off the chart by eye).
POINTS = [
    (36.85, -75.70, False, "drop point"),
    (36.96, -76.05, False, "Thimble Shoal Channel"),
    (37.03, -76.03, False, "Chesapeake Channel"),
    (36.99, -76.32, False, "Hampton Roads, between Old Point Comfort and Willoughby Spit"),
    (36.93, -76.42, False, "lower James River, off Newport News"),
    (37.24, -76.48, False, "lower York River, off Yorktown"),
    (37.30, -76.10, False, "lower Chesapeake Bay"),
    (36.92, -76.01, True, "Cape Henry"),
    (37.12, -75.96, True, "Cape Charles"),
    (37.09, -75.97, True, "Fisherman Island"),
    (36.85, -75.98, True, "Virginia Beach shore"),
]


def region_slice(mask, region=REGION):
    """Rows/cols of a runner.land.LandMask that cover the region, with the
    lat/lon of each cell centre."""
    lat0, lat1, lon0, lon1 = region
    i0, i1 = int((lat0 - mask.lat0) // mask.res), int((lat1 - mask.lat0) // mask.res)
    j0, j1 = int((lon0 - mask.lon0) // mask.res), int((lon1 - mask.lon0) // mask.res)
    lats = mask.lat0 + (np.arange(i0, i1) + 0.5) * mask.res
    lons = mask.lon0 + (np.arange(j0, j1) + 0.5) * mask.res
    return mask.mask[i0:i1, j0:j1], lats, lons


def reachable(water: np.ndarray, start: tuple[int, int]) -> np.ndarray:
    """Water cells reachable from start, moving to any of 8 neighbours."""
    seen = np.zeros_like(water, dtype=bool)
    if not water[start]:
        return seen
    q = deque([start])
    seen[start] = True
    n, m = water.shape
    while q:
        i, j = q.popleft()
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                a, b = i + di, j + dj
                if 0 <= a < n and 0 <= b < m and water[a, b] and not seen[a, b]:
                    seen[a, b] = True
                    q.append((a, b))
    return seen


def _cell(lats, lons, lat, lon):
    return int(np.argmin(np.abs(lats - lat))), int(np.argmin(np.abs(lons - lon)))


def check_points(sub, lats, lons, points=POINTS) -> list[dict]:
    """Named points: on land in the mask? Water ones: reachable from the drop?"""
    water = ~sub
    reach = reachable(water, _cell(lats, lons, *DROP))
    rows = []
    for lat, lon, want_land, name in points:
        c = _cell(lats, lons, lat, lon)
        land = bool(sub[c])
        rows.append(
            {
                "name": name,
                "lat": lat,
                "lon": lon,
                "want": "land" if want_land else "water",
                "mask": "land" if land else "water",
                "ok": land == want_land,
                "reachable_from_drop": bool(reach[c]),
            }
        )
    return rows


def land_fraction(geom, lats, lons, res: float, sub: int = SUB) -> np.ndarray:
    """Share of each cell inside geom (a shapely geometry), sampled sub x sub."""
    import shapely

    shapely.prepare(geom)
    off = (np.arange(sub) + 0.5) / sub - 0.5
    ys = (lats[:, None] + off[None, :] * res).ravel()
    xs = (lons[:, None] + off[None, :] * res).ravel()
    yy, xx = np.meshgrid(ys, xs, indexing="ij")
    inside = shapely.contains_xy(geom, xx.ravel(), yy.ravel()).reshape(len(ys), len(xs))
    return inside.reshape(len(lats), sub, len(lons), sub).mean(axis=(1, 3))


def compare(sub, frac, lats, lons) -> dict:
    """Mask vs reference land fraction: cells that disagree, and where."""
    too_much = sub & (frac < 0.5)  # mask land, reference mostly water
    too_little = ~sub & (frac >= 0.5)  # mask water, reference mostly land
    wet_land = sub & (frac == 0.0)  # mask land, no land at all in the reference

    def where(m):
        i, j = np.nonzero(m)
        return [(round(float(lats[a]), 2), round(float(lons[b]), 2)) for a, b in zip(i, j)]

    return {
        "cells": int(sub.size),
        "mask_land": int(sub.sum()),
        "ref_land": int((frac >= 0.5).sum()),
        "mask_land_ref_mostly_water": int(too_much.sum()),
        "mask_land_ref_all_water": int(wet_land.sum()),
        "mask_water_ref_mostly_land": int(too_little.sum()),
        "all_water_cells": where(wet_land),
        "mostly_land_cells": where(too_little),
    }


def reference_mask(frac: np.ndarray) -> np.ndarray:
    """A cell is land in the reference when at least half of it is land."""
    return frac >= 0.5


def ascii_map(sub, lats, lons, ref=None) -> str:
    """Rows north to south. '#' land in both, '.' water in both; with a
    reference: '+' mask land / reference water, '-' mask water / reference land."""
    out = []
    for r in range(len(lats) - 1, -1, -1):
        row = []
        for c in range(len(lons)):
            m = sub[r, c]
            if ref is None or m == ref[r, c]:
                row.append("#" if m else ".")
            else:
                row.append("+" if m else "-")
        out.append(f"{lats[r]:6.2f} " + "".join(row))
    out.append(f"       west edge {lons[0]:.2f}, east edge {lons[-1]:.2f}, one column per 0.02 deg")
    return "\n".join(out)


# ------------------------------------------------------------- references


def natural_earth(path, region=REGION):
    """Land polygons from ne_10m_land.geojson, clipped to the region."""
    import json

    import shapely
    from shapely.geometry import box, shape

    lat0, lat1, lon0, lon1 = region
    clip = box(lon0 - 0.1, lat0 - 0.1, lon1 + 0.1, lat1 + 0.1)
    with open(path, encoding="utf-8") as f:
        feats = json.load(f)["features"]
    parts = [shape(ft["geometry"]).intersection(clip) for ft in feats]
    return shapely.union_all([g for g in parts if not g.is_empty])


def gshhg(shp_path, region=REGION):
    """GSHHG land (level 1) from its shapefile, clipped to the region (needs pyshp)."""
    import shapefile
    import shapely
    from shapely.geometry import box, shape

    lat0, lat1, lon0, lon1 = region
    bb = (lon0 - 0.1, lat0 - 0.1, lon1 + 0.1, lat1 + 0.1)
    clip = box(*bb)
    with shapefile.Reader(str(shp_path)) as r:
        parts = [shape(s.__geo_interface__).intersection(clip) for s in r.iterShapes(bbox=bb)]
    return shapely.union_all([g for g in parts if not g.is_empty])


def run(mask, references: dict, log=print) -> dict:
    sub, lats, lons = region_slice(mask)
    out = {"points": check_points(sub, lats, lons)}
    log("Named points (mask under test):")
    for p in out["points"]:
        flag = "ok " if p["ok"] else "BAD"
        reach = "" if p["want"] == "land" else f", reachable from drop: {p['reachable_from_drop']}"
        log(f"  {flag} {p['name']} ({p['lat']}, {p['lon']}): {p['mask']}{reach}")
    for name, geom in references.items():
        frac = land_fraction(geom, lats, lons, mask.res)
        ref = reference_mask(frac)
        c = compare(sub, frac, lats, lons)
        ref_points = check_points(ref, lats, lons)
        out[name] = {**c, "points": ref_points}
        log(f"\nAgainst {name} ({c['cells']} cells in the region):")
        log(f"  land cells: mask {c['mask_land']}, {name} {c['ref_land']}")
        log(f"  mask land, {name} mostly water: {c['mask_land_ref_mostly_water']}")
        log(f"  mask land, {name} no land at all: {c['mask_land_ref_all_water']}")
        log(f"  mask water, {name} mostly land: {c['mask_water_ref_mostly_land']}")
        if c["mostly_land_cells"]:
            log(f"    at {c['mostly_land_cells'][:20]}")
        bad = [p["name"] for p in ref_points if not p["ok"]]
        cut = [
            p["name"] for p in ref_points if p["want"] == "water" and not p["reachable_from_drop"]
        ]
        log(
            f"  {name} as a 2 km half-land grid: wrong points {bad or 'none'}, cut off {cut or 'none'}"
        )
        log(ascii_map(sub, lats, lons, ref))
    return out


def main(argv: list[str] | None = None) -> None:
    import argparse

    from boatsim.runner.land import LandMask

    ap = argparse.ArgumentParser(description="Check the land mask near the Bay mouth (#11)")
    ap.add_argument("--mask", default="data/land/land_mask_v1.npz")
    ap.add_argument("--natural-earth", help="ne_10m_land.geojson")
    ap.add_argument("--gshhg", help="GSHHS_f_L1.shp")
    a = ap.parse_args(argv)
    refs = {}
    if a.natural_earth:
        refs["Natural Earth 1:10m"] = natural_earth(a.natural_earth)
    if a.gshhg:
        refs["GSHHG full"] = gshhg(a.gshhg)
    m = LandMask.load(a.mask)
    if not refs:
        sub, lats, lons = region_slice(m)
        print(ascii_map(sub, lats, lons))
    run(m, refs)


if __name__ == "__main__":
    main()
