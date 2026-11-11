"""Shared Blender helpers for the boat models (build_kayak.py, build_randolph.py).

Everything is built in the page's boat-building frame (x aft from the bow,
y up from the hull bottom, z to starboard), in metres, and turned into
Blender's z-up frame by P(). The glTF exporter's +Y-up conversion turns it
back, so the .glb is in the same frame as src/boats/model.ts.
"""

from __future__ import annotations

import math
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import bpy
import numpy as np

BAKE_SAMPLES = 48


def out_path(default: str) -> Path:
    """Output file from the command line (after "--" under blender -P)."""
    if "--" in sys.argv:
        return Path(sys.argv[sys.argv.index("--") + 1])
    return Path(sys.argv[1] if len(sys.argv) > 1 else default)


@dataclass
class HullForm:
    """Same as HullForm in src/boats/parts.ts: functions of s = x / L."""

    L: float
    n: float  # section fullness
    crown: float  # deck camber, m
    wl: float  # waterline above the hull bottom, m
    hb: Callable[[float], float]  # half-breadth
    kz: Callable[[float], float]  # keel height
    dz: Callable[[float], float]  # sheer height

    def deck_y(self, x: float, z: float) -> float:
        s = min(max(x / self.L, 0), 1)
        b = self.hb(s)
        return self.dz(s) + self.crown * (1 - min((z / b) ** 2, 1)) if b > 1e-6 else self.dz(s)


@dataclass
class HullPaint:
    top: int
    deck: int
    boot: int
    bottom: int
    lettering: str | None = None  # painted on both bows
    letter_ink: int = 0x1B2430
    letter_box: tuple[float, float, float] | None = (
        None  # (x0, y0, y1) in m; None = scaled to the hull
    )


# --------------------------------------------------------------- helpers ---
def P(x: float, y: float, z: float) -> tuple[float, float, float]:
    """Builder frame (x aft, y up, z starboard) -> Blender (z up)."""
    return (x, -z, y)


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hexcol(h: int) -> np.ndarray:
    return np.array([(h >> 16) & 255, (h >> 8) & 255, h & 255], dtype=np.float32) / 255


def new_image(name: str, w: int, h: int, rgb: np.ndarray | None = None) -> bpy.types.Image:
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = "sRGB"
    if rgb is not None:
        set_pixels(img, rgb)
    return img


def set_pixels(img: bpy.types.Image, rgb: np.ndarray) -> None:
    """rgb: (h, w, 3) sRGB 0..1, row 0 = bottom (v = 0)."""
    h, w, _ = rgb.shape
    px = np.ones((h, w, 4), dtype=np.float32)
    px[..., :3] = np.clip(rgb, 0, 1)
    img.pixels.foreach_set(px.ravel())
    img.update()


def get_pixels(img: bpy.types.Image) -> np.ndarray:
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    return px.reshape(h, w, 4)[..., :3]


def material(
    name: str,
    base=(0.8, 0.8, 0.8),
    rough=0.5,
    metal=0.0,
    image: bpy.types.Image | None = None,
    coat=0.0,
    emit: tuple | None = None,
) -> bpy.types.Material:
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*srgb_to_linear(np.array(base)), 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["Coat Weight"].default_value = coat
    bsdf.inputs["Coat Roughness"].default_value = 0.08
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*srgb_to_linear(np.array(emit)), 1)
        bsdf.inputs["Emission Strength"].default_value = 1.5
    if image is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return m


def mesh_object(
    name: str, verts, faces, uvs=None, mat=None, smooth=True, sharp_edges=(), parent=None
):
    """verts in builder frame; faces as vertex index tuples; uvs per face corner."""
    import bmesh  # only importable once bpy is loaded

    me = bpy.data.meshes.new(name)
    me.from_pydata([P(*v) for v in verts], [], faces)
    if uvs is not None:
        layer = me.uv_layers.new(name="UVMap")
        flat = [uv for f in uvs for uv in f]
        layer.data.foreach_set("uv", [c for uv in flat for c in uv])
    me.validate()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    if mat:
        me.materials.append(mat)
    if smooth:
        me.shade_smooth()
    if sharp_edges:
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.edges.ensure_lookup_table()
        want = {tuple(sorted(e)) for e in sharp_edges}
        for e in bm.edges:
            if tuple(sorted(v.index for v in e.verts)) in want:
                e.smooth = False
        bm.to_mesh(me)
        bm.free()
    # Faces must point outward for the exporter (single-sided in three.js).
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    if parent is not None:
        attach(ob, parent)
    return ob


def pivot(name: str, at: tuple[float, float, float]) -> bpy.types.Object:
    """An empty the page can find by name and turn (wing, vane...)."""
    ob = bpy.data.objects.new(name, None)
    ob.location = P(*at)
    bpy.context.collection.objects.link(ob)
    return ob


def attach(ob: bpy.types.Object, parent: bpy.types.Object) -> None:
    """Parent keeping the world position (mesh data stays in world coordinates)."""
    bpy.context.view_layer.update()  # parent.matrix_world is stale until then
    ob.parent = parent
    ob.matrix_parent_inverse = parent.matrix_world.inverted()


def lathe(name: str, profile, segs: int, mat, axis_origin, parent=None) -> bpy.types.Object:
    """Surface of revolution about the builder x axis. profile: [(along, r)]."""
    x0, y0, z0 = axis_origin
    verts, faces = [], []
    n = len(profile)
    for a, r in profile:
        for k in range(segs):
            th = 2 * math.pi * k / segs
            verts.append((x0 + a, y0 + r * math.cos(th), z0 + r * math.sin(th)))
    for i in range(n - 1):
        for k in range(segs):
            k2 = (k + 1) % segs
            faces.append((i * segs + k, i * segs + k2, (i + 1) * segs + k2, (i + 1) * segs + k))
    return mesh_object(name, verts, faces, mat=mat, parent=parent)


def bulb_profile(length: float, dia: float, max_at: float, n: int = 60):
    """Streamlined bulb as in parts.ts bulb()."""
    R = dia / 2
    prof = []
    for k in range(n + 1):
        u = k / n
        if u <= max_at:
            r = R * math.sqrt(max(1 - ((max_at - u) / max_at) ** 2, 0))
        else:
            r = R * max(1 - ((u - max_at) / (1 - max_at)) ** 2, 0) ** 0.75
        prof.append((u * length, max(r, 0.0004)))
    return prof


def naca(t: float, n: int = 40):
    pts = []
    for k in range(n + 1):
        xc = (1 - math.cos(math.pi * k / n)) / 2
        yt = (
            5
            * t
            * (
                0.2969 * math.sqrt(xc)
                - 0.126 * xc
                - 0.3516 * xc * xc
                + 0.2843 * xc**3
                - 0.1036 * xc**4
            )
        )
        pts.append((xc, yt))
    out = pts[::-1]
    out += [(x, -y) for x, y in pts[1:-1]]
    return out


def foil(
    name: str, root_c, tip_c, root_le, tip_le, y0, y1, t, mat, n_span=8, parent=None
) -> bpy.types.Object:
    """Tapered NACA foil between two horizontal sections, capped ends."""
    prof = naca(t, 48)
    m = len(prof)
    verts, faces = [], []
    for si in range(n_span + 1):
        f = si / n_span
        c = root_c + (tip_c - root_c) * f
        le = root_le + (tip_le - root_le) * f
        y = y0 + (y1 - y0) * f
        for px, pz in prof:
            verts.append((le + px * c, y, pz * c))
    for si in range(n_span):
        for k in range(m):
            k2 = (k + 1) % m
            faces.append((si * m + k, si * m + k2, (si + 1) * m + k2, (si + 1) * m + k))
    for si in (0, n_span):
        c = root_c if si == 0 else tip_c
        le = root_le if si == 0 else tip_le
        y = y0 if si == 0 else y1
        ci = len(verts)
        verts.append((le + 0.4 * c, y, 0))
        for k in range(m):
            faces.append((si * m + k, si * m + (k + 1) % m, ci))
    return mesh_object(name, verts, faces, mat=mat, parent=parent)


def cylinder(name, r, x, y0, y1, z, mat, segs=32, r_top=None, parent=None) -> bpy.types.Object:
    """Vertical cylinder with a slightly rounded top edge."""
    rt = r if r_top is None else r_top
    rings = [(y0, r), (y1 - 0.15 * rt, rt), (y1 - 0.03 * rt, rt * 0.93), (y1, rt * 0.6), (y1, 0.0)]
    verts, faces = [], []
    for y, rr in rings:
        for k in range(segs):
            th = 2 * math.pi * k / segs
            verts.append((x + rr * math.cos(th), y, z + rr * math.sin(th)))
    for i in range(len(rings) - 1):
        for k in range(segs):
            k2 = (k + 1) % segs
            faces.append((i * segs + k, (i + 1) * segs + k, (i + 1) * segs + k2, i * segs + k2))
    return mesh_object(name, verts, faces, mat=mat, parent=parent)


def rod(name, a, b, r, mat, segs=16, parent=None) -> bpy.types.Object:
    """Straight round bar from a to b (builder frame)."""
    a, b = np.array(a, float), np.array(b, float)
    d = b - a
    ln = float(np.linalg.norm(d))
    d /= ln
    u = np.cross(d, [0, 1, 0] if abs(d[1]) < 0.9 else [1, 0, 0])
    u /= np.linalg.norm(u)
    w = np.cross(d, u)
    verts, faces = [], []
    for end in (a, b):
        for k in range(segs):
            th = 2 * math.pi * k / segs
            verts.append(tuple(end + r * (math.cos(th) * u + math.sin(th) * w)))
    for k in range(segs):
        k2 = (k + 1) % segs
        faces.append((k, k2, segs + k2, segs + k))
    faces.append(tuple(range(segs)))
    faces.append(tuple(range(2 * segs - 1, segs - 1, -1)))
    return mesh_object(name, verts, faces, mat=mat, parent=parent)


def rounded_box(name, x0, x1, y0, y1, z0, z1, mat, bevel=0.004, parent=None) -> bpy.types.Object:
    verts = [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    ob = mesh_object(name, verts, faces, mat=mat, smooth=False, parent=parent)
    mod = ob.modifiers.new("bevel", "BEVEL")
    mod.width = bevel
    mod.segments = 3
    mod.harden_normals = True
    return ob


def tube(name, pts, r, mat, segs=12) -> bpy.types.Object:
    """Round tube along a polyline (builder frame)."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = r
    cu.bevel_resolution = segs // 4
    sp = cu.splines.new("POLY")
    sp.points.add(len(pts) - 1)
    for p, q in zip(sp.points, pts, strict=True):
        p.co = (*P(*q), 1)
    ob = bpy.data.objects.new(name, cu)
    bpy.context.collection.objects.link(ob)
    cu.materials.append(mat)
    return ob


# ------------------------------------------------------------- textures ----
def hull_texture(f: HullForm, paint: HullPaint, W: int, H: int, NT: int, ND: int) -> np.ndarray:
    """Paint for a hull, indexed by (s along the hull, ring position)."""
    M = 2 * NT + ND  # ring index runs 0..M (keel, starboard, deck, port, keel)
    u = (np.arange(W) + 0.5) / W
    v = (np.arange(H) + 0.5) / H
    S, V = np.meshgrid(u, v)  # (H, W)
    k = V * M
    kzv = np.vectorize(f.kz)(u)[None, :]
    dzv = np.vectorize(f.dz)(u)[None, :]
    hbv = np.vectorize(f.hb)(u)[None, :]
    side_s = k <= NT
    side_p = k >= NT + ND
    j = np.where(side_s, k, np.where(side_p, M - k, NT))
    t = (j / NT) ** 1.6
    height = kzv + t * (dzv - kzv)
    deck = ~(side_s | side_p)

    def band(x, lo, hi, w=0.0015):
        return np.clip((x - lo) / w + 0.5, 0, 1) * np.clip((hi - x) / w + 0.5, 0, 1)

    rng = np.random.default_rng(4)
    grain = rng.normal(0, 1, (H, W)).astype(np.float32)
    col = np.empty((H, W, 3), np.float32)
    below = band(height, -1, f.wl - 0.004)
    stripe = band(height, f.wl - 0.004, f.wl + 0.022)
    above = 1 - below - stripe
    top, boot, bottom, deck_c = (
        hexcol(paint.top),
        hexcol(paint.boot),
        hexcol(paint.bottom),
        hexcol(paint.deck),
    )
    for c in range(3):
        col[..., c] = below * bottom[c] + stripe * boot[c] + above * top[c]
    col *= (1 + 0.025 * grain * below)[..., None]  # antifouling is a little blotchy

    # Deck: diamond non-slip pattern.
    x = S * f.L
    zz = np.where(deck, hbv * (1 - 2 * (k - NT) / ND), 0)
    diamond = (np.abs(((x * 90) % 1) - 0.5) + np.abs(((zz * 90) % 1) - 0.5)) < 0.32
    deck_col = deck_c[None, None, :] * np.where(diamond, 0.94, 1.02)[..., None]
    col = np.where(deck[..., None], deck_col, col)

    if paint.lettering:
        col = letter(col, paint, x, height, side_s, side_p, f)
    return col


def letter(col, paint: HullPaint, x, height, side_s, side_p, f: HullForm):
    """Paint text on both bows, reading correctly from outside on each side."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return col
    font = None
    for name in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "DejaVuSans-Bold.ttf",
        "Arial Bold.ttf",
    ):
        try:
            font = ImageFont.truetype(name, 200)
            break
        except OSError:
            pass
    if font is None:
        return col
    img = Image.new("L", (1000, 260), 0)
    ImageDraw.Draw(img).text((10, 10), paint.lettering, fill=255, font=font)
    img = img.crop(img.getbbox())
    glyph = np.asarray(img, np.float32) / 255
    gh, gw = glyph.shape
    # Lettering box on the topsides; by default scaled to the hull, ~14% of length aft of the bow.
    if paint.letter_box:
        x0, y0, y1 = paint.letter_box
    else:
        y0 = f.wl + 0.25 * (f.dz(0.2) - f.wl)
        y1 = y0 + 0.38 * (f.dz(0.2) - f.wl)
        x0 = 0.14 * f.L
    x1 = x0 + (y1 - y0) * gw / gh
    inside = (x >= x0) & (x <= x1) & (height >= y0) & (height <= y1) & (side_s | side_p)
    gx = (x - x0) / (x1 - x0)
    gx = np.where(side_p, 1 - gx, gx)  # mirror on port so it reads from outside
    gi = np.clip(((y1 - height) / (y1 - y0) * (gh - 1)).astype(int), 0, gh - 1)
    gj = np.clip((gx * (gw - 1)).astype(int), 0, gw - 1)
    a = np.where(inside, glyph[gi, gj], 0)[..., None]
    return col * (1 - a) + hexcol(paint.letter_ink)[None, None, :] * a


def cell_texture(cols: int, rows: int, px_per_cell: int = 64) -> np.ndarray:
    """Solar panel: blue-black cells, fine fingers, white busbars, aluminium frame."""
    W, H = cols * px_per_cell, rows * px_per_cell
    yy, xx = np.mgrid[0:H, 0:W]
    cu = (xx % px_per_cell) / px_per_cell
    cv = (yy % px_per_cell) / px_per_cell
    rng = np.random.default_rng(7)
    col = hexcol(0x101C33)[None, None, :] * (1 + 0.08 * rng.normal(0, 1, (H, W, 1)))
    gap = (cu < 0.03) | (cu > 0.97) | (cv < 0.03) | (cv > 0.97)
    col[gap] = hexcol(0xD9DEE6)
    fingers = (np.abs(((cv * 22) % 1) - 0.5) < 0.06) & ~gap
    col[fingers] = col[fingers] * 0.85 + hexcol(0x6E7F99) * 0.15
    bus = ((np.abs(cu - 0.33) < 0.012) | (np.abs(cu - 0.67) < 0.012)) & ~gap
    col[bus] = hexcol(0xC8CED8)
    frame = (xx < 6) | (xx >= W - 6) | (yy < 6) | (yy >= H - 6)
    col[frame] = hexcol(0xB8BEC6)
    return col


# ---------------------------------------------------------------- parts ----
def hull(
    f: HullForm, paint: HullPaint, rough=0.32, coat=0.5, nx=180, nt=32, nd=18, tex=(2048, 512)
):
    """The hull from its form, as parts.ts hull() but dense; painted texture.
    Returns (object, image, rgb) for baking."""
    M = 2 * nt + nd
    verts, faces, uvs, sharp = [], [], [], []
    idx = {}
    for i in range(nx + 1):
        s = i / nx
        x = s * f.L
        b = max(f.hb(s), 0.0005)
        zk, zd = f.kz(s), f.dz(s)
        for kk in range(M):
            if kk <= nt:
                t = (kk / nt) ** 1.6
                lat = b * (1 - (1 - t) ** f.n) ** (1 / f.n)
                p = (x, zk + t * (zd - zk), lat)
            elif kk < nt + nd:
                zz = b * (1 - 2 * (kk - nt) / nd)
                p = (x, zd + f.crown * (1 - (zz / b) ** 2), zz)
            else:
                t = ((M - kk) / nt) ** 1.6
                lat = b * (1 - (1 - t) ** f.n) ** (1 / f.n)
                p = (x, zk + t * (zd - zk), -lat)
            idx[(i, kk)] = len(verts)
            verts.append(p)
    for i in range(nx):
        for kk in range(M):
            k2 = (kk + 1) % M
            faces.append((idx[(i, kk)], idx[(i, k2)], idx[(i + 1, k2)], idx[(i + 1, kk)]))
            u0, u1 = i / nx, (i + 1) / nx
            v0, v1 = kk / M, (kk + 1) / M
            uvs.append([(u0, v0), (u0, v1), (u1, v1), (u1, v0)])
        sharp.append((idx[(i, nt)], idx[(i + 1, nt)]))
        sharp.append((idx[(i, nt + nd)], idx[(i + 1, nt + nd)]))
    # Transom: fan to its middle (own plain material).
    c = len(verts)
    ring = [verts[idx[(nx, kk)]] for kk in range(M)]
    verts.append((f.L, sum(p[1] for p in ring) / M, 0))
    transom = [(idx[(nx, kk)], c, idx[(nx, (kk + 1) % M)]) for kk in range(M)]
    sharp += [(idx[(nx, kk)], idx[(nx, (kk + 1) % M)]) for kk in range(M)]

    img = new_image("hull_paint", *tex)
    rgb = hull_texture(f, paint, tex[0], tex[1], nt, nd)
    set_pixels(img, rgb)
    ob = mesh_object(
        "hull",
        verts,
        faces + transom,
        uvs=uvs + [[(0.999, 0.5)] * 3 for _ in transom],
        mat=material("hull", image=img, rough=rough, coat=coat),
        sharp_edges=sharp,
    )
    ob.data.materials.append(
        material("transom", base=hexcol(paint.top) * 0.96, rough=rough, coat=coat)
    )
    for poly in ob.data.polygons[len(faces) :]:
        poly.material_index = 1
    return ob, img, rgb


def strakes(f: HullForm, mat, r=0.011, nx=90) -> None:
    """Rubbing strake along both sheers and round the stern."""
    for side in (1, -1):
        pts = []
        for i in range(nx + 1):
            s = i / nx
            pts.append((s * f.L, f.dz(s) - 0.004, side * (max(f.hb(s), 0.0005) + 0.004)))
        tube(f"strake_{'stbd' if side > 0 else 'port'}", pts, r, mat)
    hb1 = f.hb(1) + 0.004
    tube(
        "strake_stern",
        [(f.L + 0.004, f.dz(1) - 0.004, z) for z in np.linspace(-hb1, hb1, 12)],
        r,
        mat,
    )


def envelope(top, x, z, dx, dz, n=4) -> float:
    """The highest point of top() within one cell (dx, dz) of (x, z)."""
    return max(
        top(x + dx * a / n, z + dz * b / n) for a in range(-n, n + 1) for b in range(-n, n + 1)
    )


def panel(
    name, x0, x1, w, top, cols, rows, thick=0.008, lift=0.014, parent=None
) -> bpy.types.Object:
    """Solar panel draped over a surface height function top(x, z).

    Each corner sits on the highest point of the surface within one cell of it,
    so the flat facets between corners clear a curved, steep-sided surface (the
    kayak's dome shoulders) instead of letting it poke through the cells."""
    pnx, pnz = 48, 24
    dx, dz = (x1 - x0) / pnx, w / pnz
    pv, pf, puv = [], [], []
    for i in range(pnx + 1):
        for j in range(pnz + 1):
            x = x0 + (x1 - x0) * i / pnx
            z = -w / 2 + w * j / pnz
            pv.append((x, envelope(top, x, z, dx, dz) + lift, z))
    for i in range(pnx):
        for j in range(pnz):
            a = i * (pnz + 1) + j
            b = a + pnz + 1
            pf.append((a, b, b + 1, a + 1))
            puv.append(
                [
                    (i / pnx, j / pnz),
                    ((i + 1) / pnx, j / pnz),
                    ((i + 1) / pnx, (j + 1) / pnz),
                    (i / pnx, (j + 1) / pnz),
                ]
            )
    img = new_image(f"{name}_cells", cols * 64, rows * 64, cell_texture(cols, rows))
    ob = mesh_object(
        name,
        pv,
        pf,
        uvs=puv,
        mat=material(name, image=img, rough=0.12, metal=0.1, coat=0.8),
        parent=parent,
    )
    sol = ob.modifiers.new("thickness", "SOLIDIFY")
    sol.thickness = thick
    sol.offset = -1
    return ob


# --------------------------------------------------------- bake, export ----
def bake_ao(targets) -> None:
    """Soft shadows (ambient occlusion) baked with Cycles and painted into each
    target's colours. targets: [(object, image, rgb)]."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = BAKE_SAMPLES
    scene.world = bpy.data.worlds.new("w")
    for ob, img, rgb in targets:
        ao = bpy.data.images.new(
            f"{ob.name}_ao", img.size[0], img.size[1], alpha=False, float_buffer=True
        )
        ao.colorspace_settings.name = "Non-Color"
        nodes = []
        for m in ob.data.materials:
            n = m.node_tree.nodes.new("ShaderNodeTexImage")
            n.image = ao
            m.node_tree.nodes.active = n
            nodes.append((m, n))
        bpy.ops.object.select_all(action="DESELECT")
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.bake(type="AO", margin=8, use_clear=True)
        a = np.clip(get_pixels(ao)[..., :1], 0, 1) ** 0.8
        set_pixels(img, rgb * (0.3 + 0.7 * a))
        for m, n in nodes:
            m.node_tree.nodes.remove(n)
        bpy.data.images.remove(ao)


def export(out: Path) -> None:
    """Curves to meshes, then a .glb with JPEG textures; then exit at once
    (bpy can crash while shutting down after a good export, seen on CI)."""
    for ob in list(bpy.context.scene.objects):
        if ob.type == "CURVE":
            bpy.ops.object.select_all(action="DESELECT")
            ob.select_set(True)
            bpy.context.view_layer.objects.active = ob
            bpy.ops.object.convert(target="MESH")
    out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(out),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_image_format="JPEG",
        export_jpeg_quality=88,
        export_extras=False,
    )
    print(f"wrote {out} ({out.stat().st_size / 1e6:.2f} MB)")
    sys.stdout.flush()
    os._exit(0)


def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
