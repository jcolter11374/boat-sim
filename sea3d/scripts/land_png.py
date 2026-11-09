"""Make sea3d/public/land.png, the coastline picture for the voyage chart.

Built from the simulator's own land mask (data/land/land_mask_v1.npz, from
Natural Earth 1:10m, public domain), so the chart's coast is the coast the
boat can run aground on. Downsampled to 0.1 degree (about 10 km): a pixel is
land if any of its 5 x 5 mask cells is. Row 0 is the north edge.

    python sea3d/scripts/land_png.py   # from the repo root

Writes a small greyscale PNG plus land.json with its bounds.
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image

from boatsim.runner.land import LandMask

STEP = 5
m = LandMask.load()
n0 = (m.nlat // STEP) * STEP
n1 = (m.nlon // STEP) * STEP
mask = m.mask[:n0, :n1].reshape(n0 // STEP, STEP, n1 // STEP, STEP).any(axis=(1, 3))
img = Image.fromarray((np.flipud(mask) * 255).astype(np.uint8), mode="L")
out = Path("sea3d/public")
out.mkdir(parents=True, exist_ok=True)
img.save(out / "land.png", optimize=True)
res = m.res * STEP
bounds = {
    "lat_min": m.lat0,
    "lat_max": m.lat0 + mask.shape[0] * res,
    "lon_min": m.lon0,
    "lon_max": m.lon0 + mask.shape[1] * res,
    "res_deg": res,
    "source": "data/land/land_mask_v1.npz (Natural Earth 1:10m land, public domain)",
}
(out / "land.json").write_text(json.dumps(bounds, indent=1) + "\n")
print(img.size, bounds)
