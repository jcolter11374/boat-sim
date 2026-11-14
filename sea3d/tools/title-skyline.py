"""The title's shore (Hana, 13 Nov 2026; John: "Maybe the boat is in a marina?").

The title shows the boat off Annapolis at sunset. The helm page's real land there is about
7 MB and 40,000 objects, too much for the first screen every visitor sees, so the title gets
only the skyline: for each compass bearing from one fixed spot on the water, how far off the
shore is and how high the land, trees and roofs behind it stand above the horizon. This tool
works that out from the same land files the helm page draws (the land-data release) and
writes it as one small file, public/title-skyline.bin (titleShore.ts draws it).

    python3 tools/title-skyline.py <folder to keep the downloaded land files in>

The file: for each of N bearings clockwise from north (N = bytes / 4), two little-endian
uint16: the distance to the first land (m; 0 = none within range) and the height of the
skyline there (decimetres above the sea, as seen from EYE_M: a far hill is brought forward
to the shore's distance at the height it appears to have).

Sources (credited on the title and in THIRD_PARTY_NOTICES.md): heights from AWS Terrain
Tiles; trees and buildings from OpenStreetMap and Overture Maps (ODbL); the State House dome
is our own model (land/town.ts).
"""

import json
import math
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

RELEASE = "https://github.com/jcolter11374/boat-sim/releases/download/land-data"
FILES = [
    "annapolisbay_meta.json",
    "annapolisbay_height.bin",
    "annapolisbay_cover.png",
    "annapolis.json",
]
# Where the title's boat floats: in Annapolis Roads off Greenbury Point, the Severn's mouth
# to the west (the town and the State House about 3.4 km off), Bay Ridge 3 km to the south.
# Keep in step with SHORE in src/titleShore.ts.
LAT, LON = 38.97403, -76.45254
EYE_M = 1.5  # the title's camera height
N = 7200  # bearings: every 0.05 degrees (about 2 m at the shore's distance)
STEP_M = 5.0
FAR_M = 9000.0
R_EARTH = 6371000 * 1.15  # with ordinary refraction
UP = 2  # the surface is worked at half the land grid's 10.6 m cells


def fetch(folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for f in FILES:
        if not (folder / f).exists():
            urllib.request.urlretrieve(f"{RELEASE}/{f}", folder / f)


def surface(folder: Path):
    """The top of everything (ground, tree tops, roofs), m above the sea; 0 on water."""
    m = json.loads((folder / "annapolisbay_meta.json").read_text())
    nx, ny = m["nx"], m["ny"]
    h = (
        np.fromfile(folder / "annapolisbay_height.bin", dtype="<i2")
        .reshape(ny, nx)
        .astype(np.float32)
    )
    cover = np.array(Image.open(folder / "annapolisbay_cover.png"))
    cw, ch = m["w"] / nx / UP, m["h"] / ny / UP
    big = (nx * UP, ny * UP)
    ground = np.array(Image.fromarray(h).resize(big, Image.BILINEAR))
    land = np.kron(h, np.ones((UP, UP), np.float32)) > 0
    trees = np.kron(cover, np.ones((UP, UP), np.uint8)) == 1
    # Tree tops 8 to 15 m, rolling (two sizes of soft bumps), not a flat hedge.
    rng = np.random.default_rng(7)
    canopy = np.zeros((ny * UP, nx * UP), np.float32)
    for cells, amp in ((48, 4.5), (14, 2.5)):
        low = rng.random((ny * UP // cells + 2, nx * UP // cells + 2)).astype(np.float32)
        canopy += amp * np.array(Image.fromarray(low).resize(big, Image.BICUBIC))
    top = np.where(land, np.maximum(ground, 0.4), 0) + np.where(trees & land, 8 + canopy, 0)
    town = json.loads((folder / "annapolis.json").read_text())
    mx, my = m["w"] / (m["lon1"] - m["lon0"]), m["h"] / (m["lat1"] - m["lat0"])
    ox, oz = (town["origin"][1] - m["lon0"]) * mx, (m["lat1"] - town["origin"][0]) * my
    roofs = Image.new("F", big, 0)
    draw = ImageDraw.Draw(roofs)
    for b in sorted(town["buildings"], key=lambda b: b["b"] + b["h"]):
        ridge = 1.5 if b["r"] == "gable" else 0
        draw.polygon(
            [((ox + x) / cw, (oz + z) / ch) for x, z in b["p"]], fill=float(b["b"] + b["h"] + ridge)
        )
    top = np.maximum(top, np.array(roofs))
    sh = town.get("stateHouse")
    dome = (ox + sh["x"], oz + sh["z"], sh["base"]) if sh else None
    here = ((LON - m["lon0"]) * mx, (m["lat1"] - LAT) * my)
    return top, cw, ch, here, dome


# The State House dome (land/town.ts stateHouse): [radius m, top above its base m].
DOME = [(0.1, 36.5), (1.2, 30.7), (2.6, 25.4), (4.0, 15.5), (5.6, 13.5), (6.2, 10.6)]


def skyline(top, cw, ch, here, dome):
    vx, vz = here
    if top[int(vz / ch), int(vx / cw)] > 0:
        raise SystemExit("the spot is on land")
    d = np.arange(60.0, FAR_M, STEP_M)
    drop = d**2 / (2 * R_EARTH)
    dist = np.zeros(N)
    tan = np.full(N, -1.0)
    for i0 in range(0, N, 360):
        b = np.arange(i0, min(N, i0 + 360)) * 2 * math.pi / N
        x = ((vx + np.outer(np.sin(b), d)) / cw).astype(int)
        z = ((vz - np.outer(np.cos(b), d)) / ch).astype(int)
        ok = (x >= 0) & (x < top.shape[1]) & (z >= 0) & (z < top.shape[0])
        t = np.where(ok, top[np.clip(z, 0, top.shape[0] - 1), np.clip(x, 0, top.shape[1] - 1)], 0)
        isl = t > 0
        dist[i0 : i0 + len(b)] = np.where(isl.any(1), d[isl.argmax(1)], 0)
        tan[i0 : i0 + len(b)] = np.where(isl, (t - EYE_M - drop) / d, -1).max(1)
    if dome:
        dx, dz, base = dome[0] - vx, dome[1] - vz, dome[2]
        far = math.hypot(dx, dz)
        at = math.atan2(dx, -dz)
        for i in range(N):
            off = abs(far * math.sin(i * 2 * math.pi / N - at))
            if math.cos(i * 2 * math.pi / N - at) <= 0 or dist[i] == 0:
                continue
            for r, y in DOME:
                if off <= r:
                    tan[i] = max(tan[i], (base + y - EYE_M - far**2 / (2 * R_EARTH)) / far)
                    break
    height = np.where(dist > 0, np.maximum(EYE_M + tan * dist, 0.5), 0)
    return dist, height


def main() -> None:
    folder = Path(sys.argv[1])
    fetch(folder)
    dist, height = skyline(*surface(folder))
    out = np.zeros((N, 2), "<u2")
    out[:, 0] = np.clip(np.round(dist), 0, 65535)
    out[:, 1] = np.clip(np.round(height * 10), 0, 65535)
    path = Path(__file__).resolve().parent.parent / "public" / "title-skyline.bin"
    path.write_bytes(out.tobytes())
    seen = dist > 0
    print(
        f"{path.name}: {path.stat().st_size} bytes; land on {seen.mean():.0%} of bearings, {dist[seen].min():.0f} to {dist[seen].max():.0f} m off, skyline up to {height.max():.1f} m"
    )


if __name__ == "__main__":
    main()
