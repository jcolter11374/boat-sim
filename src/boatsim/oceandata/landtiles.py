"""Coast squares for the 3D views: the Chesapeake Bay as small tiles (display only).

The first real coastline (plan: Annapolis to the capes). The land-view places in
landviews.py are one fixed box each; this cuts the Bay into squares of
TILE_DEG on a side, so a page can load just the squares near the boat. This first
set is Annapolis to Thomas Point (FIRST_BOX, 12 squares); more of the Bay follows
the same way.

Per square, flat file names (the land-data release has no folders):

    bay_<key>_meta.json    grid: nx, ny, lon0/lon1/lat0/lat1 (the square's edges),
                           width and height in m, "scale" (metres per unit of
                           the heights), what each file is, attribution
    bay_<key>_height.bin   int16 little-endian, DECIMETRES (scale 0.1), row 0 =
                           north, nx per row. Real heights AND real depths: the
                           sea floor is below 0, not clamped. Neighbouring squares
                           share their edge rows and columns, so they meet
                           without a seam.
    bay_<key>_colour.jpg   true colour on the same box (COLOUR_PX square)

and bay_index.json, the list of squares with their boxes, kind (shore, sea or
land) and the files' sources and credits.

<key> is the square's south-west corner in hundredths of a degree:
"3895n7650w" is 38.95-39.00N, 76.50-76.45W.

Sources:
- Heights and depths: NOAA NCEI Continuously Updated DEM (CUDEM), 1/9 arc-second
  (about 3 m) topobathy for the Chesapeake Bay, Cloud-Optimized GeoTIFFs on the
  NOAA Open Data Dissemination bucket (public domain, U.S. Government work).
  Where CUDEM has no value (none in this first set; a guard for later squares),
  AWS Terrain Tiles fill in, as in landviews.py.
- Colour: Copernicus Sentinel-2 L2A, the same cloud-free passes as annapolisbay.

Run in GitHub Actions ("Land data", place "baytiles") or a sandbox; the buckets
are public. Only the windows needed are read, never whole files.
"""

from __future__ import annotations

import json
import math
import re
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from boatsim.oceandata import landviews as lv

TILE_DEG = 0.05
TILE_NX = 257  # heights per side: about 17 m east-west, 22 m north-south at 39N
COLOUR_PX = 512  # colour per side: about 8.5 x 11 m
FIRST_BOX = (-76.55, -76.40, 38.85, 39.05)  # lon0, lon1, lat0, lat1: Annapolis to Thomas Point

CUDEM_BUCKET = "https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com"
CUDEM_PREFIX = "dem/NCEI_ninth_Topobathy_2014_8483/chesapeake_bay/"
CUDEM_NODATA = -9999.0

CREDITS = {
    "cudem": "Heights and depths: NOAA NCEI Continuously Updated Digital Elevation Model "
    "(CUDEM), 1/9 arc-second topobathy, Chesapeake Bay (public domain, via the NOAA Open "
    "Data Dissemination program)",
    "terrain": lv.CREDITS["terrain"],
    "sentinel": lv.CREDITS["sentinel"],
}


@dataclass(frozen=True)
class Square:
    """One coast square: its south-west corner in hundredths of a degree."""

    lat100: int
    lon100: int  # negative west

    @property
    def key(self) -> str:
        ns = "n" if self.lat100 >= 0 else "s"
        ew = "w" if self.lon100 < 0 else "e"
        return f"{abs(self.lat100):04d}{ns}{abs(self.lon100):04d}{ew}"

    @property
    def box(self) -> tuple[float, float, float, float]:
        d = round(TILE_DEG * 100)
        return (
            self.lon100 / 100,
            (self.lon100 + d) / 100,
            self.lat100 / 100,
            (self.lat100 + d) / 100,
        )


def squares(box: tuple[float, float, float, float]) -> list[Square]:
    """The squares that tile box (lon0, lon1, lat0, lat1), north-west first."""
    d = round(TILE_DEG * 100)
    lon0, lon1, lat0, lat1 = (round(v * 100) for v in box)
    if any(v % d for v in (lon0, lon1, lat0, lat1)):
        raise ValueError(f"box {box} is not on the {TILE_DEG} degree grid")
    return [Square(la, lo) for la in range(lat1 - d, lat0 - 1, -d) for lo in range(lon0, lon1, d)]


def square_grid(sq: Square, n: int = TILE_NX):
    """lons west->east and lats north->south, n each, ON the square's edges (so
    neighbours share their edge rows and columns); width and height in m."""
    lon0, lon1, lat0, lat1 = sq.box
    mx = 111320.0 * math.cos(math.radians((lat0 + lat1) / 2))
    lons = np.linspace(lon0, lon1, n)
    lats = np.linspace(lat1, lat0, n)
    return lons, lats, (lon1 - lon0) * mx, (lat1 - lat0) * lv.M_PER_DEG_LAT


# ----------------------------------------------------------------- CUDEM

_CUDEM_NAME = re.compile(r"ncei19_n(\d+)x(\d+)_w(\d+)x(\d+)_\w+\.tif$")


def cudem_files(listing: str) -> dict[tuple[float, float], str]:
    """{(north edge, west edge): key} from an S3 list of the CUDEM folder. Each
    file is a quarter degree; its name gives its north-west corner."""
    out = {}
    for key in re.findall(r"<Key>([^<]+)</Key>", listing):
        m = _CUDEM_NAME.search(key)
        if m:
            north = int(m[1]) + int(m[2]) / 100
            west = -(int(m[3]) + int(m[4]) / 100)
            prev = out.get((north, west))
            if prev is None or key > prev:  # the newest version when there are two
                out[(north, west)] = key
    return out


def list_cudem(fetch=None) -> dict[tuple[float, float], str]:
    fetch = fetch or (lambda u: urllib.request.urlopen(u, timeout=60).read())
    keys: dict[tuple[float, float], str] = {}
    token = ""
    while True:
        url = f"{CUDEM_BUCKET}/?list-type=2&prefix={CUDEM_PREFIX}"
        if token:
            url += "&continuation-token=" + urllib.request.quote(token, safe="")
        text = fetch(url).decode()
        keys.update(cudem_files(text))
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", text)
        if not m:
            return keys
        token = m[1]


def cudem_heights(lons, lats, files: dict, read=None) -> np.ndarray:
    """Heights (m, sea floor below 0) on the lon x lat grid; nan where no CUDEM.

    read(key, lons, lats) -> heights on that grid with nan for no data; by
    default the file is read over HTTP, only the window the grid needs."""
    read = read or _read_cudem
    out = np.full((len(lats), len(lons)), np.nan, np.float32)
    q = 0.25
    for (north, west), key in sorted(files.items()):
        if (
            west > lons.max()
            or west + q < lons.min()
            or north - q > lats.max()
            or north < lats.min()
        ):
            continue
        h = read(key, lons, lats)
        fill = np.isnan(out) & ~np.isnan(h)
        out[fill] = h[fill]
    return out


def _read_cudem(key: str, lons, lats) -> np.ndarray:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import Window, from_bounds

    with (
        rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"),
        rasterio.open(f"/vsicurl/{CUDEM_BUCKET}/{key}") as ds,
    ):
        b = ds.bounds
        lo0, lo1 = max(lons.min(), b.left), min(lons.max(), b.right)
        la0, la1 = max(lats.min(), b.bottom), min(lats.max(), b.top)
        out = np.full((len(lats), len(lons)), np.nan, np.float32)
        if lo0 >= lo1 or la0 >= la1:
            return out
        pad = 2 * ds.res[0]
        win = from_bounds(lo0 - pad, la0 - pad, lo1 + pad, la1 + pad, ds.transform)
        win = win.round_offsets().round_lengths().intersection(Window(0, 0, ds.width, ds.height))
        # A grid point every ~17 m over 3 m pixels: read at a quarter of the
        # resolution, averaged, so each point is a local mean, not one pixel.
        shape = (max(2, int(win.height) // 4), max(2, int(win.width) // 4))
        a = ds.read(1, window=win, out_shape=shape, resampling=Resampling.average)
        a = np.where(a <= CUDEM_NODATA + 1, np.nan, a).astype(np.float32)
        t = ds.window_transform(win)
        sx, sy = win.width / shape[1], win.height / shape[0]
        lon_g, lat_g = np.meshgrid(lons, lats)
        px = (lon_g - t.c) / (t.a * sx) - 0.5
        py = (lat_g - t.f) / (t.e * sy) - 0.5
        inside = (lon_g >= b.left) & (lon_g <= b.right) & (lat_g >= b.bottom) & (lat_g <= b.top)
        v = lv.bilinear(a, px, py)
        out[inside] = v[inside]
        return out


# ----------------------------------------------------------------- baking


def fill_gaps(col: np.ndarray) -> np.ndarray:
    """Black pixels (no pass saw them; a pixel or two along a scene's edge) take
    the colour of the nearest seen pixel."""
    from scipy.ndimage import distance_transform_edt

    col = np.asarray(col, np.uint8)
    gap = col.astype(np.int32).sum(-1) < 15
    if not gap.any() or gap.all():
        return col
    _, (iy, ix) = distance_transform_edt(gap, return_indices=True)
    return col[iy, ix]


def kind(hgt: np.ndarray) -> str:
    """ "sea" (almost all water), "land" (almost none) or "shore"."""
    wet = float((hgt <= 0).mean())
    return "sea" if wet > 0.98 else "land" if wet < 0.02 else "shore"


def bake_square(sq: Square, out: Path, heights, colour) -> dict:
    """Write one square's files; heights(lons, lats) and colour(lon_g, lat_g) give
    metres (nan for none) and uint8 RGB. Returns its index entry."""
    from PIL import Image

    lons, lats, w, h = square_grid(sq)
    hgt = heights(lons, lats)
    if np.isnan(hgt).any():
        raise ValueError(f"square {sq.key}: heights missing")
    cl, ca, _, _ = square_grid(sq, COLOUR_PX)
    col = fill_gaps(colour(*np.meshgrid(cl, ca)))
    lon0, lon1, lat0, lat1 = sq.box
    name = f"bay_{sq.key}"
    meta = {
        "nx": len(lons),
        "ny": len(lats),
        "w": w,
        "h": h,
        "lon0": lon0,
        "lon1": lon1,
        "lat0": lat0,
        "lat1": lat1,
        "scale": 0.1,
        "depths": True,
        "height": f"{name}_height.bin: int16 little-endian decimetres, row 0 north; "
        "sea floor below 0; edges shared with the next square",
        "colour": f"{name}_colour.jpg: {COLOUR_PX} x {COLOUR_PX}, the same box, row 0 north",
        "attribution": [CREDITS["cudem"], CREDITS["terrain"], CREDITS["sentinel"]],
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{name}_meta.json").write_text(json.dumps(meta, indent=1))
    np.clip(np.round(hgt * 10), -32768, 32767).astype("<i2").tofile(out / f"{name}_height.bin")
    Image.fromarray(np.asarray(col, np.uint8)).save(out / f"{name}_colour.jpg", quality=85)
    return {"key": sq.key, "box": [lon0, lon1, lat0, lat1], "kind": kind(hgt)}


def bake(out: Path, box=FIRST_BOX, cache: Path | None = None, log=print) -> list[Path]:
    """Bake every square of box and bay_index.json into out."""
    out = Path(out)
    files = list_cudem()
    log(f"CUDEM: {len(files)} Chesapeake files listed")

    def heights(lons, lats):
        hgt = cudem_heights(lons, lats, files)
        gap = np.isnan(hgt)
        if gap.any():
            box_ = (lons.min(), lons.max(), lats.min(), lats.max())
            t = lv.terrain(box_, 15, lons, lats, cache)
            hgt[gap] = np.where(t[gap] < 0, np.maximum(t[gap], -60.0), t[gap])
            log(f"  {int(gap.sum())} points from Terrain Tiles (no CUDEM)")
        return hgt

    def colour(lon_g, lat_g):
        return lv.sentinel_median(lon_g, lat_g, lv.ANNAPOLISBAY_SCENES, 32618, log, step=1)

    entries = []
    for sq in squares(box):
        e = bake_square(sq, out, heights, colour)
        log(f"bay_{sq.key}: {e['kind']}")
        entries.append(e)
    index = {
        "tile_deg": TILE_DEG,
        "tiles": entries,
        "files": "bay_<key>_meta.json, bay_<key>_height.bin, bay_<key>_colour.jpg",
        "attribution": [CREDITS["cudem"], CREDITS["terrain"], CREDITS["sentinel"]],
    }
    (out / "bay_index.json").write_text(json.dumps(index, indent=1))
    names = ["bay_index.json"] + [
        f"bay_{e['key']}_{f}" for e in entries for f in ("meta.json", "height.bin", "colour.jpg")
    ]
    return [out / n for n in names]
