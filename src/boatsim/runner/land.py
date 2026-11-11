"""Is this point on land? For ending a voyage that runs ashore (issue #70).

A boat that drifts onto the Outer Banks, Bermuda or Nova Scotia, or back into
the Chesapeake, must stop there: in the real world it is aground, not still at
sea. Under the Microtransat rules we follow (runner/arrival.py) a landfall is
never a finish, in Europe or anywhere else: only the 25 km target circle is.

The land map is a bit mask on a 0.02 degree grid (about 2 km) over the route
box, 25-62N, 82W-5E, built from Natural Earth 1:10m land (public domain) by
the "Build land mask" workflow and kept in git at data/land/land_mask_v1.npz.
A grid cell counts as land when its centre is on land or it holds a piece of
coastline, so a coast is placed up to one cell (2 km) seaward and small
islands such as Bermuda aren't missed. Points outside the box count as water.

Owner: Maya (runner). Priya's real coastline for the arrival rule (#11) is a
separate piece.
"""

from __future__ import annotations

import math
import os
from functools import lru_cache
from pathlib import Path

import numpy as np

from boatsim.geo import EARTH_RADIUS_M

DEFAULT_PATH = Path("data/land/land_mask_v1.npz")
BOX = (25.0, 62.0, -82.0, 5.0)  # lat_min, lat_max, lon_min, lon_max
RES_DEG = 0.02


class LandMask:
    """on_land(lat, lon) from a packed bit grid. Cheap: one array lookup."""

    def __init__(self, mask: np.ndarray, lat0: float, lon0: float, res: float):
        self.mask = mask.astype(bool)
        self.lat0, self.lon0, self.res = float(lat0), float(lon0), float(res)
        self.nlat, self.nlon = self.mask.shape

    @classmethod
    def load(cls, path: str | Path = DEFAULT_PATH) -> LandMask:
        with np.load(path) as z:
            nlat, nlon = int(z["nlat"]), int(z["nlon"])
            bits = np.unpackbits(z["bits"])[: nlat * nlon].reshape(nlat, nlon)
            return cls(bits, float(z["lat0"]), float(z["lon0"]), float(z["res"]))

    def save(self, path: str | Path) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            path,
            bits=np.packbits(self.mask.ravel()),
            nlat=self.nlat,
            nlon=self.nlon,
            lat0=self.lat0,
            lon0=self.lon0,
            res=self.res,
        )

    # --- A coarse precheck: "no land anywhere near" without probing (Maya, speed) ---
    # Blocks of BLOCK x BLOCK cells; for each, the Chebyshev distance in blocks to
    # the nearest block holding any land cell (capped at FAR). A point whose block
    # is more than (reach in blocks + 1) from any land block can't have land within
    # that reach, so clear_of() answers exactly what probing would: no land.
    BLOCK = 10
    FAR = 40

    def _blocks(self) -> np.ndarray:
        d = getattr(self, "_block_dist", None)
        if d is not None:
            return d
        b = self.BLOCK
        nb_i, nb_j = -(-self.nlat // b), -(-self.nlon // b)
        pad = np.zeros((nb_i * b, nb_j * b), dtype=bool)
        pad[: self.nlat, : self.nlon] = self.mask
        land = pad.reshape(nb_i, b, nb_j, b).any(axis=(1, 3))
        d = np.full(land.shape, self.FAR, dtype=np.int16)
        cur = land
        for k in range(self.FAR):
            d[cur & (d > k)] = k
            grown = np.pad(cur, 1)
            cur = np.zeros_like(cur)
            for di in (0, 1, 2):
                for dj in (0, 1, 2):
                    cur |= grown[di : di + land.shape[0], dj : dj + land.shape[1]]
        self._block_dist = d
        return d

    def clear_of(self, lat: float, lon: float, reach_m: float) -> bool:
        """True only if no land cell lies within reach_m (great circle) of the
        point, so on_land is False at it and everywhere within reach_m. False
        means "can't tell cheaply", not "land is near"."""
        i = int((lat - self.lat0) // self.res)
        j = int((lon - self.lon0) // self.res)
        if not (0 <= i < self.nlat and 0 <= j < self.nlon):
            return False
        reach_blocks = self._reach_blocks(math.ceil(abs(lat)), reach_m)
        if reach_blocks is None:
            return False
        return int(self._blocks()[i // self.BLOCK, j // self.BLOCK]) > reach_blocks

    @lru_cache(maxsize=4096)  # noqa: B019 - one mask per process; keys are few
    def _reach_blocks(self, lat_ceil: int, reach_m: float) -> int | None:
        """Blocks a great circle of length reach_m can stray from a point at any
        latitude up to lat_ceil degrees (None: too far to tell cheaply)."""
        d = reach_m / EARTH_RADIUS_M  # angular reach (rad)
        phi = math.radians(lat_ceil)
        if d >= math.pi / 2 - phi - 1e-3:
            return None
        # Widest the great circle strays in latitude and longitude, with slack.
        dlat = math.degrees(d) * 1.05 + 1e-6
        dlon = math.degrees(math.asin(min(1.0, math.sin(d) / math.cos(phi)))) * 1.05 + 1e-6
        # fine cells the reach spans (+1 for where in its cell the point sits), in blocks
        n = math.ceil((max(dlat, dlon) / self.res + 1) / self.BLOCK) + 1
        return n if n < self.FAR else None

    def on_land(self, lat: float, lon: float) -> bool:
        i = int((lat - self.lat0) // self.res)
        j = int((lon - self.lon0) // self.res)
        if 0 <= i < self.nlat and 0 <= j < self.nlon:
            return bool(self.mask[i, j])
        return False


@lru_cache(maxsize=1)
def default_land(path: str | Path = DEFAULT_PATH) -> LandMask | None:
    """The committed land mask, or None (no aground check) with a warning.

    With BOATSIM_REQUIRE_LAND=1 (set in the batch workflows) a missing mask is
    an error, so a batch can't silently sail through continents."""
    if Path(path).exists():
        return LandMask.load(path)
    if os.environ.get("BOATSIM_REQUIRE_LAND") == "1":
        raise FileNotFoundError(f"{path} is missing and BOATSIM_REQUIRE_LAND=1")
    import warnings

    warnings.warn(f"{path} not found: voyages can't run aground", stacklevel=2)
    return None


def build(geojson: str | Path, out: str | Path = DEFAULT_PATH) -> LandMask:
    """Rasterise Natural Earth land polygons onto the route-box grid (needs shapely)."""
    import json

    import shapely
    from shapely.geometry import box, shape

    lat_min, lat_max, lon_min, lon_max = BOX
    clip = box(lon_min, lat_min, lon_max, lat_max)
    with open(geojson, encoding="utf-8") as f:
        feats = json.load(f)["features"]
    land = shapely.union_all(
        [g for g in (shape(ft["geometry"]).intersection(clip) for ft in feats) if not g.is_empty]
    )
    shapely.prepare(land)
    nlat = round((lat_max - lat_min) / RES_DEG)
    nlon = round((lon_max - lon_min) / RES_DEG)
    lons = lon_min + (np.arange(nlon) + 0.5) * RES_DEG
    mask = np.zeros((nlat, nlon), dtype=bool)
    for i in range(nlat):
        lat = lat_min + (i + 0.5) * RES_DEG
        mask[i] = shapely.contains_xy(land, lons, np.full(nlon, lat))
    # Small islands (Bermuda is ~1 km wide) can miss every cell centre, so also
    # mark each cell that holds a coastline vertex. Natural Earth 1:10m has a
    # vertex every few hundred metres, so this puts coasts up to one cell (2 km)
    # seaward: a boat counts as aground slightly early, reefs included.
    xy = shapely.get_coordinates(shapely.boundary(land))
    i = ((xy[:, 1] - lat_min) // RES_DEG).astype(int)
    j = ((xy[:, 0] - lon_min) // RES_DEG).astype(int)
    ok = (i >= 0) & (i < nlat) & (j >= 0) & (j < nlon)
    mask[i[ok], j[ok]] = True
    m = LandMask(mask, lat_min, lon_min, RES_DEG)
    m.save(out)
    return m


# Spot checks the build prints and the tests assert (lat, lon, expected on land).
SPOT_CHECKS = [
    (36.85, -75.70, False, "drop point, off the Bay mouth"),
    (37.50, -76.10, False, "middle of the Chesapeake Bay"),
    (36.85, -76.29, True, "Norfolk, Virginia"),
    (35.00, -75.30, False, "off Cape Hatteras"),
    (35.78, -78.64, True, "Raleigh, North Carolina"),
    (40.00, -50.00, False, "mid Atlantic"),
    (38.70, -27.20, True, "Terceira, Azores"),
    (38.72, -9.14, True, "Lisbon"),
    (52.00, -8.50, True, "Ireland"),
]

# Small islands: each box must hold at least one land cell (lat0, lat1, lon0, lon1).
ISLAND_CHECKS = [
    ((32.20, 32.45, -64.95, -64.60), "Bermuda"),
    ((36.90, 37.05, -25.25, -24.95), "Santa Maria, Azores"),
]


def land_cells(m: LandMask, bbox) -> int:
    lat0, lat1, lon0, lon1 = bbox
    i0, i1 = int((lat0 - m.lat0) // m.res), int((lat1 - m.lat0) // m.res) + 1
    j0, j1 = int((lon0 - m.lon0) // m.res), int((lon1 - m.lon0) // m.res) + 1
    return int(m.mask[max(i0, 0) : i1, max(j0, 0) : j1].sum())


def main(argv: list[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Build the land mask from Natural Earth")
    ap.add_argument("geojson", help="ne_10m_land.geojson")
    ap.add_argument("--out", default=str(DEFAULT_PATH))
    a = ap.parse_args(argv)
    m = build(a.geojson, a.out)
    print(f"{m.nlat} x {m.nlon} cells, {m.mask.mean():.1%} land -> {a.out}")
    bad = 0
    for lat, lon, want, name in SPOT_CHECKS:
        got = m.on_land(lat, lon)
        bad += got != want
        print(f"{'ok ' if got == want else 'BAD'} {name}: on_land={got}")
    for bbox, name in ISLAND_CHECKS:
        n = land_cells(m, bbox)
        bad += n == 0
        print(f"{'ok ' if n else 'BAD'} {name}: {n} land cells")
    if bad:
        raise SystemExit(f"{bad} spot checks failed")


if __name__ == "__main__":
    main()
