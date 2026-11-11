"""Make sea3d/public/wildlife.json: how often you meet dolphins, whales and seabirds.

Where: the Ocean Biodiversity Information System (OBIS, https://obis.org),
records since 1990 of dolphins and porpoises (Delphinidae, Phocoenidae),
whales (baleen whales, Mysticeti, and sperm whales, Physeteroidea) and birds
(Aves; OBIS holds marine records only), counted on OBIS's own geohash grid
(the /v3/occurrence/grid API) and binned to RES degree cells over the route
box. Records follow survey effort as well as animals (busy coasts are well
watched), so we smooth over the neighbouring cells and keep only the shape.

How many: one cited survey fixes the scale. NOAA's AMAPPS northeast shipboard
survey, summer 2016 (NEFSC; GBIF/OBIS dataset 5d89b3ba-fad9-4481-9a4e-
d1303f776a65), logged over 1,200 cetacean groups and 1,977 seabird groups on
about 5,354 km of track between 36 and 42N, 65 and 74W, offshore of the 100 m
depth contour. With an effective search half-width of HALF_WIDTH_KM either
side of the track (GUESS: an observer low on a small boat, without the
survey's big binoculars), that's groups per km^2 there; elsewhere scales with
OBIS records against that box, between FLOOR and CEILING times it (GUESS).

Thread sandboxes can't reach OBIS; the "Build wildlife map" workflow runs this
on GitHub's runners and commits the result.

    python sea3d/scripts/wildlife.py   # from the repo root

wildlife.json: {lat0, lon0, res, nlat, nlon, source, groups: {dolphins, whales,
birds: [nlat * nlon groups per km^2, row 0 the south edge]}}.
"""

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

API = "https://api.obis.org/v3"
OUT = Path("sea3d/public/wildlife.json")
LAT0, LAT1, LON0, LON1 = 25.0, 60.0, -82.0, 5.0  # the route box (oceandata.grid.ROUTE_BOX)
RES = 0.5  # degrees
PRECISION = 4  # geohash cells about 0.35 x 0.18 degrees
SINCE = "1990-01-01"  # leaves out the old whaling logbooks
GROUPS = {
    "dolphins": ["Delphinidae", "Phocoenidae"],
    "whales": ["Mysticeti", "Physeteroidea"],
    "birds": ["Aves"],
}
# AMAPPS northeast shipboard, 27 June - 25 August 2016 (see module doc).
SURVEY_BOX = (36.0, 42.0, -74.0, -65.0)
SURVEY_KM = 5354.0
SURVEY_GROUPS = {"cetaceans": 1200.0, "birds": 1977.0}
HALF_WIDTH_KM = 1.5  # GUESS
FLOOR = 0.02  # GUESS: even the least-watched open ocean has some life
CEILING = 3.0  # GUESS


def get(url: str) -> dict:
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                return json.load(r)
        except Exception as e:
            if attempt == 3:
                raise
            print(f"retry after {e}")
            time.sleep(2 ** (attempt + 2))
    raise AssertionError


def taxon_id(name: str) -> int:
    r = get(f"{API}/taxon/{urllib.parse.quote(name)}")["results"]
    hit = next((x for x in r if x.get("scientificName") == name), r[0])
    return int(hit["taxonID"])


def records(taxa: list[str], shape: tuple[int, int]) -> np.ndarray:
    """OBIS records per RES cell for these taxa since SINCE."""
    grid = np.zeros(shape)
    wkt = f"POLYGON(({LON0} {LAT0},{LON1} {LAT0},{LON1} {LAT1},{LON0} {LAT1},{LON0} {LAT0}))"
    for name in taxa:
        q = urllib.parse.urlencode({"taxonid": taxon_id(name), "geometry": wkt, "startdate": SINCE})
        fc = get(f"{API}/occurrence/grid/{PRECISION}?{q}")
        feats = fc.get("features", [])
        total = 0
        for f in feats:
            ring = np.array(f["geometry"]["coordinates"][0], dtype=float)
            lon, lat = ring[:, 0].mean(), ring[:, 1].mean()
            n = float(f["properties"].get("n", 0))
            i = int((lat - LAT0) // RES)
            j = int((lon - LON0) // RES)
            if 0 <= i < shape[0] and 0 <= j < shape[1]:
                grid[i, j] += n
                total += n
        print(f"{name}: {len(feats)} grid cells, {total:.0f} records in the box")
    return grid


def smooth(g: np.ndarray, k: int = 2) -> np.ndarray:
    """Mean over the (2k+1)^2 cells round each (edges padded)."""
    p = np.pad(g, k, mode="edge")
    out = np.zeros_like(g)
    for a in range(2 * k + 1):
        for b in range(2 * k + 1):
            out += p[a : a + g.shape[0], b : b + g.shape[1]]
    return out / (2 * k + 1) ** 2


def main() -> None:
    nlat = round((LAT1 - LAT0) / RES)
    nlon = round((LON1 - LON0) / RES)
    raw = {k: smooth(records(v, (nlat, nlon))) for k, v in GROUPS.items()}
    lat = LAT0 + (np.arange(nlat) + 0.5) * RES
    lon = LON0 + (np.arange(nlon) + 0.5) * RES
    box = (
        (lat[:, None] >= SURVEY_BOX[0])
        & (lat[:, None] <= SURVEY_BOX[1])
        & (lon[None, :] >= SURVEY_BOX[2])
        & (lon[None, :] <= SURVEY_BOX[3])
    )
    strip = 2 * HALF_WIDTH_KM
    cet = raw["dolphins"][box].mean() + raw["whales"][box].mean()
    # Groups per km^2 in the survey box, cetaceans split by their share of OBIS records there.
    there = {
        "dolphins": SURVEY_GROUPS["cetaceans"]
        / SURVEY_KM
        / strip
        * raw["dolphins"][box].mean()
        / cet,
        "whales": SURVEY_GROUPS["cetaceans"] / SURVEY_KM / strip * raw["whales"][box].mean() / cet,
        "birds": SURVEY_GROUPS["birds"] / SURVEY_KM / strip,
    }
    out = {
        "lat0": LAT0,
        "lon0": LON0,
        "res": RES,
        "nlat": nlat,
        "nlon": nlon,
        "source": "OBIS records since 1990 (shape), scaled to NOAA AMAPPS NE shipboard survey 2016 (see sea3d/scripts/wildlife.py)",
        "groups": {},
    }
    for k, g in raw.items():
        rel = np.clip(g / g[box].mean(), FLOOR, CEILING)
        out["groups"][k] = [float(f"{v:.3g}") for v in (there[k] * rel).ravel()]
        print(
            f"{k}: {there[k]:.4f} groups/km2 in the survey box; range {rel.min():.2f}..{rel.max():.2f} of it"
        )
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"-> {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
