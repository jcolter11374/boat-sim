"""Make sea3d/public/ships.bin, where the 3D pages put other ships.

From the simulator's own ship-traffic map (data/traffic/ship_density_v1.nc,
ships per km^2 at any moment on a 0.1 degree grid, built from EMODnet vessel
density and the World Bank / IMF global shipping density; both CC BY 4.0, see
THIRD_PARTY_NOTICES.md), so the ships you see are the traffic the ship-strike
hazard counts. Cells that are almost all land (90% or more of the Natural
Earth land mask) are marked 0, so ships never sail inland.

    python sea3d/scripts/ships.py   # from the repo root

ships.bin (little-endian): float32 lat0, lon0, res (degrees, south-west corner
of the grid); uint16 nlat, nlon; then nlat x nlon bytes, row 0 the south edge:
0 for land or no ships, otherwise b with ships per km^2 = 10^((b - 1) / 32 - 7).
"""

import struct
from pathlib import Path

import numpy as np
import xarray as xr

from boatsim.runner.land import LandMask

SRC = Path("data/traffic/ship_density_v1.nc")
OUT = Path("sea3d/public/ships.bin")


def encode(d: np.ndarray) -> np.ndarray:
    """Ships per km^2 to a byte, 32 steps a decade from 1e-7 (0 for none)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        b = np.round((np.log10(d) + 7) * 32) + 1
    b = np.where(np.isfinite(b) & (d >= 1e-7), np.clip(b, 1, 255), 0)
    return b.astype(np.uint8)


def main() -> None:
    ds = xr.open_dataset(SRC)
    lat = ds["lat"].values
    lon = ds["lon"].values
    d = ds["ship_density"].values.astype(np.float64)
    res = float(round(lat[1] - lat[0], 6))
    lat0 = float(round(lat[0] - res / 2, 6))
    lon0 = float(round(lon[0] - res / 2, 6))
    # Land share of each cell from the fine mask.
    m = LandMask.load()
    step = round(res / m.res)
    land = np.zeros_like(d)
    i0 = round((lat0 - m.lat0) / m.res)
    j0 = round((lon0 - m.lon0) / m.res)
    for i in range(d.shape[0]):
        a = i0 + i * step
        if a < 0 or a + step > m.nlat:
            continue
        rows = m.mask[a : a + step]
        for j in range(d.shape[1]):
            b = j0 + j * step
            if 0 <= b and b + step <= m.nlon:
                land[i, j] = rows[:, b : b + step].mean()
    d[land >= 0.9] = 0
    b = encode(d)
    out = struct.pack("<fffHH", lat0, lon0, res, *b.shape) + b.tobytes()
    OUT.write_bytes(out)
    print(
        f"{b.shape} cells, {(land >= 0.9).mean():.0%} land, max {np.nanmax(d):.3g} ships/km2, {len(out)} bytes -> {OUT}"
    )


if __name__ == "__main__":
    main()
