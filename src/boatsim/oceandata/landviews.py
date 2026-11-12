"""Land for the 3D views: coasts along the route and the Annapolis waterfront (display only).

Places the 3D pages can show from the water, built from free, open data.

Coasts (REGIONS), each as <key>_meta.json, <key>_height.bin, <key>_colour.jpg:

    pico       Pico and Faial, Azores, Horta included (38.36-38.66N, 28.86-28.00W)
    baymouth   the Chesapeake Bay mouth: Cape Henry, Cape Charles and the water
               between, where the bridge-tunnel crosses (36.88-37.12N, 76.12-75.88W)
    lisbon     Cabo da Roca, Cascais and the Tagus mouth to Lisbon
               (38.62-38.82N, 9.52-9.08W)
    annapolisbay  Annapolis and around it: the harbour, Spa and Back Creeks, the
               Severn mouth, Greenbury Point and the Bay off them
               (38.92-39.02N, 76.56-76.40W), about 11 m, with two more files:
      annapolisbay_cover.png   8-bit classes on the same grid (meta "cover" has
                               the legend): trees, grass, wetland, sand, built
      annapolisbay_trees.json  OpenStreetMap single trees (points) and tree rows
                               (lines), lon/lat

      <key>_meta.json    grid: nx, ny, lon0/lon1/lat0/lat1, width and height in m
      <key>_height.bin   int16 little-endian, metres, row 0 = north, nx per row;
                         sea is clamped at -60 m
      <key>_colour.jpg   true colour, the same grid: Sentinel-2 median of clear
                         summer passes, clouds filled from their surroundings

    Annapolis waterfront (38.968-38.990N, 76.505-76.472W)
      annapolis.json         local frame: metres from ORIGIN (the harbour mouth),
                             x east, z south; terrain grid size, buildings
                             (footprint, base, height, roof, class, name) and piers
      annapolis_height.bin   int16 little-endian, DECIMETRES, row 0 = north

The formats are the ones Iris's land spikes read (sea3d land-spike-azores and
land-spike-annapolis). Every JSON carries its own attribution and licence.

Sources:
- Heights: AWS Terrain Tiles (Terrarium PNG, Mapzen/Tilezen; SRTM, GMTED2010,
  ETOPO1, USGS 3DEP and others; see their attribution list). Free to use with
  credit.
- Colour: Copernicus Sentinel-2 L2A, Cloud-Optimized GeoTIFFs on AWS (Element 84).
  "Contains modified Copernicus Sentinel data 2023-2024."
- Land cover (annapolisbay_cover.png): Sentinel-2 greenness (NDVI) for trees,
  grass and built-up land, with OpenStreetMap areas (woods, wetland, beaches,
  golf, pitches; Overture base theme land and land_use) over it. ODbL, as are
  the trees.
- Buildings and piers: Overture Maps Foundation (buildings and transportation/base
  themes, which include OpenStreetMap). The derived file is a database under the
  Open Database License (ODbL 1.0): "Contains information from OpenStreetMap and
  Overture Maps, available under ODbL." Any public copy of annapolis.json must
  keep that notice.

Fetching needs the network: run it in GitHub Actions ("Land data") or a sandbox
(all three buckets are public and reachable from both).
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np

TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
S2_COG = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs"
OVERTURE_RELEASE = "2026-10-21.0"
M_PER_DEG_LAT = 110950.0  # same constants the 3D pages use

PICO_BOX = (-28.86, -28.0, 38.36, 38.66)  # lon0, lon1, lat0, lat1
PICO_NX = 2400  # about 30 m spacing
# Summer passes over UTM tiles 26SLH (Pico, Faial) and 26SMH (Pico's east end),
# chosen by Iris for low cloud. The median per pixel, clouds masked by SCL, so a
# cloud in one pass is filled by the others.
PICO_SCENES = {
    "LH": [
        "S2B_26SLH_20240626",
        "S2A_26SLH_20240701",
        "S2B_26SLH_20240815",
        "S2A_26SLH_20240621",
        "S2A_26SLH_20240919",
        "S2A_26SLH_20240731",
        "S2B_26SLH_20230801",
        "S2A_26SLH_20240611",
    ],
    "MH": ["S2B_26SMH_20240626", "S2A_26SMH_20240701", "S2B_26SMH_20240815", "S2A_26SMH_20240621"],
}
SCL_BAD = [0, 1, 3, 8, 9, 10]  # no data, saturated, cloud shadow, cloud (med, high), cirrus

# The other coasts: summer passes with under 15% cloud over the tile (each
# scene's eo:cloud_cover, listed from the bucket on 11 Nov 2026) that cover the
# whole box (the Bay mouth sits at the edge of two orbits' swaths, so most passes
# only see its eastern third), median as for Pico.
BAYMOUTH_BOX = (-76.12, -75.88, 36.88, 37.12)  # tiles 18SVF and, north of 37.0N, 18SVG
_BAY_DAYS = ("S2B_{}_20230629", "S2A_{}_20230813", "S2A_{}_20230823", "S2B_{}_20240623")
_BAY_DAYS += ("S2B_{}_20240723", "S2A_{}_20240728")
BAYMOUTH_SCENES = {t[3:]: [d.format(t) for d in _BAY_DAYS] for t in ("18SVF", "18SVG")}
# Lisbon: passes under 0.2% cloud.
LISBON_BOX = (-9.52, -9.08, 38.62, 38.82)  # inside tile 29SMC
LISBON_SCENES = {
    "MC": [
        "S2A_29SMC_20240816",
        "S2B_29SMC_20230807",
        "S2A_29SMC_20230713",
        "S2B_29SMC_20240722",
        "S2B_29SMC_20240702",
        "S2B_29SMC_20230817",
    ]
}

# Annapolis and around it: tile 18SUJ, the passes that see the whole tile with
# under 5% cloud (eo:cloud_cover, listed from the bucket on 11 Nov 2026).
ANNAPOLISBAY_BOX = (-76.56, -76.40, 38.92, 39.02)
ANNAPOLISBAY_SCENES = {
    "UJ": [
        "S2B_18SUJ_20240911",
        "S2A_18SUJ_20240827",
        "S2B_18SUJ_20230629",
        "S2B_18SUJ_20240703",
        "S2A_18SUJ_20230902",
        "S2A_18SUJ_20240728",
    ]
}

ANNAPOLIS_BOX = (-76.505, -76.472, 38.968, 38.990)  # lon0, lon1, lat0, lat1
ANNAPOLIS_ORIGIN = (38.9725, -76.4800)  # lat, lon: the boat, in the harbour mouth
ANNAPOLIS_NX = 900  # about 3 m spacing

CREDITS = {
    "terrain": "Terrain: AWS Terrain Tiles (Mapzen/Tilezen; SRTM, GMTED2010, ETOPO1, USGS 3DEP "
    "and others, https://github.com/tilezen/joerd/blob/master/docs/attribution.md)",
    "sentinel": "Colour: contains modified Copernicus Sentinel data 2023-2024 (Sentinel-2 L2A, "
    "via the Registry of Open Data on AWS)",
    "cover": "Land cover and trees: contains information from OpenStreetMap and Overture Maps "
    "Foundation (https://overturemaps.org), available under the Open Database License "
    "(ODbL 1.0); greenness from modified Copernicus Sentinel data 2023-2024",
    "overture": "Buildings and piers: contains information from OpenStreetMap and Overture Maps "
    "Foundation (https://overturemaps.org), available under the Open Database License "
    "(ODbL 1.0, https://opendatacommons.org/licenses/odbl/1-0/)",
}


# ----------------------------------------------------------------- terrain


def tile_xy(lon, lat, z: int):
    """Fractional Web Mercator tile coordinates (x east, y south)."""
    n = 2**z
    x = (np.asarray(lon) + 180.0) / 360.0 * n
    y = (1.0 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2.0 * n
    return x, y


def terrarium_decode(rgb: np.ndarray) -> np.ndarray:
    """Terrarium PNG pixels -> metres: R*256 + G + B/256 - 32768."""
    a = rgb.astype(np.float32)
    return a[..., 0] * 256.0 + a[..., 1] + a[..., 2] / 256.0 - 32768.0


def bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Sample img at fractional pixel positions (x along columns)."""
    x = np.clip(x, 0, img.shape[1] - 1.001)
    y = np.clip(y, 0, img.shape[0] - 1.001)
    i, j = x.astype(int), y.astype(int)
    u, v = x - i, y - j
    return (
        img[j, i] * (1 - u) * (1 - v)
        + img[j, i + 1] * u * (1 - v)
        + img[j + 1, i] * (1 - u) * v
        + img[j + 1, i + 1] * u * v
    )


def _get(url: str, cache: Path | None) -> bytes:
    if cache is not None:
        f = cache / url.split("://", 1)[1].replace("/", "_")
        if f.exists():
            return f.read_bytes()
    with urllib.request.urlopen(url, timeout=60) as r:
        data = r.read()
    if cache is not None:
        cache.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
    return data


def terrain(box, z: int, lons: np.ndarray, lats: np.ndarray, cache: Path | None = None, fetch=None):
    """Heights (m) on the lon x lat grid (lats north first) from Terrarium tiles at zoom z."""
    from PIL import Image

    fetch = fetch or (lambda url: _get(url, cache))
    lon0, lon1, lat0, lat1 = box
    x0, y0 = tile_xy(lon0, lat1, z)
    x1, y1 = tile_xy(lon1, lat0, z)
    tx0, ty0, tx1, ty1 = int(x0), int(y0), int(x1), int(y1)
    mos = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            png = fetch(TERRARIUM.format(z=z, x=tx, y=ty))
            rgb = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))
            r, c = (ty - ty0) * 256, (tx - tx0) * 256
            mos[r : r + 256, c : c + 256] = terrarium_decode(rgb)
    lon_g, lat_g = np.meshgrid(lons, lats)
    tx, ty = tile_xy(lon_g, lat_g, z)
    return bilinear(mos, (tx - tx0) * 256 - 0.5, (ty - ty0) * 256 - 0.5)


def grid(box, nx: int):
    """lons west->east and lats north->south for nx columns of square-ish cells."""
    lon0, lon1, lat0, lat1 = box
    mx = 111320.0 * math.cos(math.radians((lat0 + lat1) / 2))
    w, h = (lon1 - lon0) * mx, (lat1 - lat0) * M_PER_DEG_LAT
    ny = round(nx * h / w)
    return np.linspace(lon0, lon1, nx), np.linspace(lat1, lat0, ny), w, h


# ----------------------------------------------------------------- colour


def fill_clouds(col: np.ndarray, h: np.ndarray) -> np.ndarray:
    """Replace leftover cloud (bright grey or black on land) with the average of
    clear land around it, widening the search until filled (Iris's fix.py)."""
    from scipy.ndimage import binary_dilation, uniform_filter

    c = col.astype(np.float32)
    mx, mn = c.max(-1), c.min(-1)
    bad = (((mn > 120) & (mx - mn < 40)) | (c.sum(-1) < 25)) & (h > 2)
    bad = binary_dilation(bad, iterations=3)
    good = ~bad
    out = c.copy()
    for r in (5, 11, 21, 41, 81):
        w = uniform_filter(good.astype(np.float32), r)
        s = np.stack([uniform_filter(c[..., k] * good, r) for k in range(3)], -1)
        fill = s / np.maximum(w[..., None], 1e-6)
        ok = bad & (w > 0.05)
        out[ok] = fill[ok]
        bad &= ~ok
    return np.clip(out, 0, 255).astype(np.uint8)


def _scene_url(scene: str, band: str) -> str:
    _, tile, day = scene.split("_")
    utm, lat_band, sq = tile[:2], tile[2], tile[3:]
    return f"{S2_COG}/{utm}/{lat_band}/{sq}/{day[:4]}/{int(day[4:6])}/{scene}_0_L2A/{band}.tif"


def s2_median(lon_g, lat_g, scenes: dict, epsg: int, bands=("TCI",), step=2, log=print):
    """The median of the cloud-free pixels of each tile's passes, sampled on the
    lon/lat grid: float32 (..., channels), the bands' channels in order (TCI has
    three); 0 where no pass sees the cell. step: read every step-th 10 m pixel."""
    import rasterio
    from pyproj import Transformer
    from rasterio.windows import from_bounds

    east, north = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True).transform(
        lon_g, lat_g
    )
    out, have = None, np.zeros(lon_g.shape, bool)
    for tile, names in scenes.items():
        stack, wt, shp, win = [], None, None, None
        for sc in names:
            try:
                chans = []
                for band in bands:
                    with rasterio.open(_scene_url(sc, band)) as ds:
                        if win is None or wt is None:
                            b = ds.bounds
                            e0, e1 = max(east.min(), b.left), min(east.max(), b.right)
                            n0, n1 = max(north.min(), b.bottom), min(north.max(), b.top)
                            if e0 >= e1 or n0 >= n1:
                                raise LookupError("outside the tile")
                            win = from_bounds(e0, n0, e1, n1, ds.transform)
                            win = win.round_offsets().round_lengths()
                            shp = (int(win.height // step), int(win.width // step))
                            wt = ds.window_transform(win)
                            box = (e0, n0, e1, n1)
                        w = from_bounds(*box, ds.transform).round_offsets().round_lengths()
                        a = ds.read(window=w, out_shape=(ds.count, *shp)).astype(np.float32)
                        chans += list(a)
                with rasterio.open(_scene_url(sc, "SCL")) as ds2:
                    w2 = from_bounds(*box, ds2.transform).round_offsets().round_lengths()
                    scl = ds2.read(1, window=w2, out_shape=shp)
            except LookupError:
                break
            except Exception as e:  # noqa: BLE001  a missing pass is fine; the median uses the rest
                log(f"  {sc}: skipped ({e!r})"[:200])
                continue
            a = np.stack(chans, -1)
            bad = np.isin(scl, SCL_BAD) | (a.sum(-1) == 0)
            a[bad] = np.nan
            stack.append(a)
            log(f"  {sc}: cloudy share {bad.mean():.3f}")
        if not stack:
            continue
        med = np.nanmedian(np.stack(stack), 0)
        med = np.nan_to_num(np.where(np.isnan(med), np.nan_to_num(stack[0]), med))
        px = (east - wt.c) / wt.a * (shp[1] / win.width)
        py = (north - wt.f) / wt.e * (shp[0] / win.height)
        ok = (px >= 0) & (px < shp[1] - 1) & (py >= 0) & (py < shp[0] - 1) & ~have
        c = np.stack([bilinear(med[..., k], px, py) for k in range(med.shape[-1])], -1)
        ok &= c.sum(-1) > 0
        if out is None:
            out = np.zeros(lon_g.shape + (med.shape[-1],), np.float32)
        out[ok] = c[ok]
        have |= ok
        log(f"  tile {tile}: {int(ok.sum())} pixels")
    return out if out is not None else np.zeros(lon_g.shape + (3,), np.float32)


def sentinel_median(lon_g, lat_g, scenes: dict, epsg: int, log=print, step=2) -> np.ndarray:
    """True colour (uint8 RGB) on the lon/lat grid: per UTM tile, the median of
    the cloud-free pixels of its scenes, at 10 m x step."""
    col = s2_median(lon_g, lat_g, scenes, epsg, ("TCI",), step, log)
    return np.clip(col, 0, 255).astype(np.uint8)


def sentinel_ndvi(lon_g, lat_g, scenes: dict, epsg: int, log=print, step=1) -> np.ndarray:
    """Greenness, (NIR - red) / (NIR + red), from the cloud-free median of bands
    B08 and B04 (10 m); nan where no pass sees the cell."""
    rn = s2_median(lon_g, lat_g, scenes, epsg, ("B04", "B08"), step, log)
    r, n = rn[..., 0], rn[..., 1]
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(r + n > 0, (n - r) / (r + n), np.nan)


# ----------------------------------------------------------------- Pico


@dataclass(frozen=True)
class Region:
    """A coast baked as heights plus true colour on one lon/lat grid."""

    box: tuple[float, float, float, float]  # lon0, lon1, lat0, lat1
    nx: int  # columns; rows follow from the box's shape
    zoom: int  # terrain tile zoom
    scenes: dict  # Sentinel-2 passes per UTM tile (see PICO_SCENES)
    epsg: int  # the tiles' UTM zone
    step: int = 2  # colour from every step-th 10 m Sentinel pixel (2: 20 m)
    cover: bool = False  # also bake <key>_cover.png and <key>_trees.json
    # Fill leftover cloud from around it. Off where the passes are clear: the fill
    # also takes bright grey roofs for cloud (downtown Annapolis, the Academy).
    fill: bool = True


REGIONS = {
    "pico": Region(PICO_BOX, PICO_NX, 12, PICO_SCENES, 32626),  # about 30 m
    "baymouth": Region(BAYMOUTH_BOX, 1200, 13, BAYMOUTH_SCENES, 32618),  # about 18 m
    "lisbon": Region(LISBON_BOX, 2000, 13, LISBON_SCENES, 32629),  # about 19 m
    "annapolisbay": Region(
        ANNAPOLISBAY_BOX, 1300, 14, ANNAPOLISBAY_SCENES, 32618, step=1, cover=True, fill=False
    ),  # about 11 m
}


def bake_region(
    key: str,
    out: Path,
    cache: Path | None = None,
    nx: int | None = None,
    log=print,
    release: str = OVERTURE_RELEASE,
) -> list[Path]:
    from PIL import Image

    reg = REGIONS[key]
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    lons, lats, w, h = grid(reg.box, nx or reg.nx)
    hgt = terrain(reg.box, reg.zoom, lons, lats, cache)
    hgt = np.where(hgt < 0, np.maximum(hgt, -60.0), hgt)
    log(f"{key}: {len(lons)} x {len(lats)} heights, highest {hgt.max():.0f} m")
    lon_g, lat_g = np.meshgrid(lons, lats)
    col = sentinel_median(lon_g, lat_g, reg.scenes, reg.epsg, log, reg.step)
    if reg.fill:
        col = fill_clouds(col, hgt)
    lon0, lon1, lat0, lat1 = reg.box
    meta = {
        "nx": len(lons),
        "ny": len(lats),
        "w": w,
        "h": h,
        "lon0": lon0,
        "lon1": lon1,
        "lat0": lat0,
        "lat1": lat1,
        "height": f"{key}_height.bin: int16 little-endian metres, row 0 north; sea clamped at -60",
        "colour": f"{key}_colour.jpg: the same grid, row 0 north",
        "attribution": [CREDITS["terrain"], CREDITS["sentinel"]],
    }
    paths = [out / f"{key}_meta.json", out / f"{key}_height.bin", out / f"{key}_colour.jpg"]
    if reg.cover:
        ndvi = sentinel_ndvi(lon_g, lat_g, reg.scenes, reg.epsg, log)
        cover, trees = land_cover(reg.box, lons, lats, hgt, ndvi, release, log)
        meta["cover"] = {
            "file": f"{key}_cover.png: 8-bit classes on the same grid, row 0 north",
            "classes": COVER_NAMES,
            "trees": f"{key}_trees.json: OpenStreetMap single trees (points: lon, lat, "
            "height in m or null) and tree rows (rows: lists of lon, lat)",
            "overture_release": release,
            "license": "ODbL-1.0 (cover and trees)",
        }
        meta["attribution"].append(CREDITS["cover"])
        paths += [out / f"{key}_cover.png", out / f"{key}_trees.json"]
        Image.fromarray(cover).save(paths[3], optimize=True)
        trees = {"license": "ODbL-1.0", "attribution": [CREDITS["cover"]], **trees}
        paths[4].write_text(json.dumps(trees, separators=(",", ":")))
    paths[0].write_text(json.dumps(meta, indent=1))
    np.round(hgt).astype("<i2").tofile(paths[1])
    Image.fromarray(col).save(paths[2], quality=90)
    return paths


# Classes: greenness (Sentinel-2 NDVI at 10 m) sorts land into trees, grass
# and built; OpenStreetMap areas from Overture's base theme then paint over it,
# in this order (later wins). Overture's land_cover (ESA WorldCover, generalised
# polygons) is left out: it calls whole leafy suburbs "forest" or "urban".
COVER_NAMES = {0: "water or nothing known", 1: "trees", 2: "grass, fields, golf, pitches"}
COVER_NAMES |= {3: "wetland, marsh", 4: "sand, beach", 5: "built, paved (little greenery)"}
COVER_RULES = [
    ("land_use", "subtype", {"golf": 2, "recreation": 2, "agriculture": 2, "managed": 2}),
    ("land_use", "class", {"grass": 2, "meadow": 2, "cemetery": 2}),
    ("land", "subtype", {"forest": 1, "wetland": 3, "sand": 4, "grass": 2, "shrub": 2}),
]
# GUESS, from the summer median over Annapolis (land NDVI: 10% below 0.28,
# median 0.73): canopy is the greenest, lawns a step below, roofs and roads low.
TREE_NDVI = 0.6
BUILT_NDVI = 0.3


def _raster_transform(lons, lats):
    from rasterio.transform import from_origin

    dlon, dlat = lons[1] - lons[0], lats[0] - lats[1]
    return from_origin(lons[0] - dlon / 2, lats[0] + dlat / 2, dlon, dlat)


def land_cover(box, lons, lats, hgt, ndvi, release=OVERTURE_RELEASE, log=print, rows=None):
    """Classes on the grid (COVER_NAMES) and the OSM trees. rows(type) gives the
    Overture rows of a base-theme type (default: read the release)."""
    from rasterio.features import rasterize
    from shapely import wkb

    rows = rows or (lambda typ: overture("base", typ, box, release).to_pylist())
    shape = (len(lats), len(lons))
    tf = _raster_transform(lons, lats)
    cover = np.zeros(shape, np.uint8)
    land = (hgt > 0.5) | (ndvi > 0.1)  # GUESS: low shores count by greenness
    green = np.nan_to_num(ndvi, nan=0.0)
    cover[land] = 2
    cover[land & (green >= TREE_NDVI)] = 1
    cover[land & (green < BUILT_NDVI)] = 5
    cache: dict = {}
    for typ, key, table in COVER_RULES:
        if typ not in cache:
            cache[typ] = rows(typ)
        shapes = [
            (wkb.loads(r["geometry"]), table[r.get(key)]) for r in cache[typ] if r.get(key) in table
        ]
        shapes = [(g, v) for g, v in shapes if g.geom_type in ("Polygon", "MultiPolygon")]
        if not shapes:
            continue
        painted = rasterize(shapes, out_shape=shape, transform=tf, fill=0, dtype="uint8")
        cover = np.where(painted > 0, painted, cover)
    cover[~land] = 0
    pts, lines = [], []
    for r in cache.get("land") or rows("land"):
        if r.get("subtype") != "tree":
            continue
        g = wkb.loads(r["geometry"])
        if g.geom_type == "Point":
            pts.append([round(g.x, 6), round(g.y, 6), tag_height(r.get("source_tags"))])
        elif g.geom_type == "LineString":
            lines.append([[round(x, 6), round(y, 6)] for x, y in g.coords])
    n = {COVER_NAMES[k]: int((cover == k).sum()) for k in COVER_NAMES}
    log(f"  cover: {n}; {len(pts)} trees, {len(lines)} tree rows")
    return cover, {"points": pts, "rows": lines}


def tag_height(tags) -> float | None:
    """An OSM height tag ("12", "12 m", "40'") in metres, or None."""
    import re

    v = dict(tags or {}).get("height")
    m = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*(m|ft|')?\s*", str(v or ""))
    if not m:
        return None
    return round(float(m[1]) * (0.3048 if m[2] in ("ft", "'") else 1.0), 1)


def bake_pico(out: Path, cache: Path | None = None, nx: int = PICO_NX, log=print) -> list[Path]:
    return bake_region("pico", out, cache, nx, log)


# ----------------------------------------------------------------- Annapolis


def local_xz(lon, lat, origin=ANNAPOLIS_ORIGIN):
    """Metres from origin: x east, z south (the 3D pages' frame)."""
    mx = 111320.0 * math.cos(math.radians(origin[0]))
    return round((lon - origin[1]) * mx, 2), round(-(lat - origin[0]) * M_PER_DEG_LAT, 2)


def overture(theme: str, typ: str, box, release: str = OVERTURE_RELEASE):
    """Rows of one Overture theme/type whose bbox meets the box (pyarrow table)."""
    import pyarrow.compute as pc
    import pyarrow.dataset as ds
    from pyarrow import fs

    w, e, s, n = box
    s3 = fs.S3FileSystem(anonymous=True, region="us-west-2")
    d = ds.dataset(
        f"overturemaps-us-west-2/release/{release}/theme={theme}/type={typ}/",
        filesystem=s3,
        format="parquet",
    )
    f = (
        (pc.field("bbox", "xmin") < e)
        & (pc.field("bbox", "xmax") > w)
        & (pc.field("bbox", "ymin") < n)
        & (pc.field("bbox", "ymax") > s)
    )
    want = [
        "id",
        "geometry",
        "height",
        "num_floors",
        "class",
        "subtype",
        "roof_shape",
        "names",
        "is_underground",
        "source_tags",
    ]
    return d.to_table(filter=f, columns=[c for c in d.schema.names if c in want])


def _num(x):
    return None if x is None or math.isnan(float(x)) else float(x)


def building_record(geom, row: dict, ground) -> list[dict]:
    """Footprints in the local frame with a height (GUESS by footprint when
    Overture has none) and a roof type. ground(lon, lat) gives terrain height."""
    from shapely.geometry import MultiPolygon, Polygon

    parts = [geom] if isinstance(geom, Polygon) else list(getattr(geom, "geoms", []))
    names = row.get("names") or {}
    name = names.get("primary") if isinstance(names, dict) else None
    cls = row.get("class") if isinstance(row.get("class"), str) else ""
    out = []
    for p in parts:
        if not isinstance(p, Polygon) or isinstance(p, MultiPolygon) or p.area < 1e-10:
            continue
        ext = [local_xz(x, y) for x, y in p.exterior.coords[:-1]]
        area = Polygon(ext).area
        if area < 12:  # sheds and slivers
            continue
        hgt = _num(row.get("height"))
        floors = _num(row.get("num_floors"))
        est = not hgt
        if est and floors:
            hgt, est = floors * 3.2, False
        if est:
            hgt = 7.0 if area < 250 else 10.0 if area < 1200 else 13.0  # GUESS by footprint
        roof = "flat"
        if (
            area < 260
            and (est or hgt < 12)
            and cls not in ("commercial", "retail", "parking", "industrial")
        ):
            roof = "gable"
        if isinstance(row.get("roof_shape"), str) and row["roof_shape"]:
            roof = "gable" if row["roof_shape"] in ("gabled", "hipped") else "flat"
        if name == "Maryland State House":
            hgt, roof = 17.0, "flat"  # the dome is the page's own model on top
        coords = list(p.exterior.coords)
        base = min(ground(x, y) for x, y in coords[:: max(1, len(coords) // 6)])
        seed = int(hashlib.md5(str(row.get("id", "")).encode()).hexdigest()[:6], 16)
        out.append(
            {
                "p": ext,
                "b": round(max(base, 0.0), 2),
                "h": round(float(hgt), 1),
                "r": roof,
                "c": cls,
                "s": seed,
                "n": name if isinstance(name, str) else None,
            }
        )
    return out


def pier_polygons(geom) -> list[list[list[float]]]:
    """Pier lines become 2.4 m wide strips; pier areas stay as drawn (local frame)."""
    from shapely.geometry import LineString, Polygon

    if isinstance(geom, LineString):
        g = LineString([local_xz(x, y) for x, y in geom.coords]).buffer(1.2, cap_style=2)
    elif isinstance(geom, Polygon):
        g = Polygon([local_xz(x, y) for x, y in geom.exterior.coords])
    else:
        return []
    parts = [g] if isinstance(g, Polygon) else list(g.geoms)
    return [[[round(x, 2), round(y, 2)] for x, y in p.exterior.coords[:-1]] for p in parts]


def bake_annapolis(
    out: Path, cache: Path | None = None, release: str = OVERTURE_RELEASE, log=print
) -> list[Path]:
    from shapely import wkb

    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    lons, lats, w, h = grid(ANNAPOLIS_BOX, ANNAPOLIS_NX)
    hgt = terrain(ANNAPOLIS_BOX, 15, lons, lats, cache)
    log(f"annapolis: {len(lons)} x {len(lats)} heights, {hgt.min():.1f} to {hgt.max():.1f} m")
    lon0, lon1, lat0, lat1 = ANNAPOLIS_BOX

    # Ground under a building: nearest terrain cell.
    def ground(lon: float, lat: float) -> float:
        i = round((lon - lon0) / (lon1 - lon0) * (len(lons) - 1))
        j = round((lat1 - lat) / (lat1 - lat0) * (len(lats) - 1))
        return float(hgt[min(max(j, 0), len(lats) - 1), min(max(i, 0), len(lons) - 1)])

    box = (lon0, lon1, lat0, lat1)
    blds = []
    for row in overture("buildings", "building", box, release).to_pylist():
        if row.get("is_underground"):
            continue
        blds += building_record(wkb.loads(row["geometry"]), row, ground)
    piers = []
    for row in overture("base", "infrastructure", box, release).to_pylist():
        if row.get("class") == "pier":
            piers += pier_polygons(wkb.loads(row["geometry"]))
    log(f"annapolis: {len(blds)} buildings, {len(piers)} piers (Overture {release})")
    x0, z0 = local_xz(lon0, lat1)
    doc = {
        "origin": list(ANNAPOLIS_ORIGIN),
        "nx": len(lons),
        "ny": len(lats),
        "x0": x0,
        "z0": z0,
        "w": w,
        "h": h,
        "height": "annapolis_height.bin: int16 little-endian DECIMETRES, row 0 north",
        "frame": "metres from origin, x east, z south",
        "buildings": blds,
        "piers": piers,
        "overture_release": release,
        "license": "ODbL-1.0 (buildings and piers); terrain as credited",
        "attribution": [CREDITS["terrain"], CREDITS["overture"]],
    }
    sh = [b for b in blds if b["n"] == "Maryland State House"]
    if sh:
        p = sh[0]["p"]
        doc["stateHouse"] = {
            "x": sum(q[0] for q in p) / len(p),
            "z": sum(q[1] for q in p) / len(p),
            "base": sh[0]["b"] + sh[0]["h"],
        }
    paths = [out / "annapolis.json", out / "annapolis_height.bin"]
    paths[0].write_text(json.dumps(doc, separators=(",", ":")))
    np.round(hgt * 10).astype("<i2").tofile(paths[1])
    return paths


def main(argv: list[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Bake land for the 3D views (coasts, Annapolis)")
    ap.add_argument("places", nargs="*", default=[*REGIONS, "annapolis"])  # annapolis: #203's
    ap.add_argument("--out", default="site/land")
    ap.add_argument("--cache", default=None, help="keep downloaded terrain tiles here")
    ap.add_argument("--overture-release", default=OVERTURE_RELEASE)
    a = ap.parse_args(argv)
    cache = Path(a.cache) if a.cache else None
    for place in a.places:
        if place in REGIONS:
            paths = bake_region(place, a.out, cache, release=a.overture_release)
        elif place == "annapolis":
            paths = bake_annapolis(a.out, cache, a.overture_release)
        elif place == "baytiles":  # the Bay as coast squares (landtiles.py)
            from boatsim.oceandata import landtiles

            paths = landtiles.bake(Path(a.out), cache=cache)
        else:
            raise SystemExit(f"unknown place {place!r}")
        for p in paths:
            print(f"  {p.name}: {p.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
