"""Build the v4 kayak as a detailed 3D model (glTF .glb) with Blender.

Run with Blender's Python module (pip install bpy==4.2.0, Python 3.11):

    python sea3d/blender/build_kayak.py sea3d/public/models/kayak.glb

or with Blender itself:

    blender -b -P sea3d/blender/build_kayak.py -- sea3d/public/models/kayak.glb

The shape is the same one the page draws in code (src/boats/model.ts,
buildKayak, and the hull maths in src/boats/parts.ts): every number here comes
from there, so the physics and the picture still agree. What Blender adds is
looks: a dense smooth hull, a rubbing strake along the sheer, a painted hull
(gelcoat, white boot stripe, antifouling, name), solar cells, rounded
fittings, and soft "baked" shadows in the corners (ambient occlusion,
rendered once with Cycles and painted into the colours).

The model is in the boat-building frame the page uses (x aft from the bow,
y up from the hull bottom, z to starboard), in metres. Propellers are not in
it: the page adds them in code so they can spin.
"""

from __future__ import annotations

import math
import os
import sys
from pathlib import Path

import bpy
import numpy as np

OUT = Path(
    sys.argv[sys.argv.index("--") + 1]
    if "--" in sys.argv
    else (sys.argv[1] if len(sys.argv) > 1 else "kayak.glb")
)
BAKE_SAMPLES = 48

# ---------------------------------------------------------------- shape ----
# src/boats/model.ts buildKayak: HullForm K and specs.ts KAYAK.
L = 3.05
N_FULL = 3.0  # section fullness
CROWN = 0.025  # deck camber, m
WL = 0.10  # waterline above the hull bottom, m
BALLAST_DEPTH = 0.9  # bulb centre below the waterline, m


def hb(s: float) -> float:
    """Half-breadth at s = x / L."""
    if s <= 0.5:
        return 0.395 * max(1 - (1 - s / 0.5) ** 2, 0) ** 0.55
    return 0.395 - (0.395 - 0.16) * ((s - 0.5) / 0.5) ** 2.2


def kz(s: float) -> float:
    """Keel height above the lowest point."""
    if s < 0.3:
        return 0.16 * (1 - s / 0.3) ** 2
    if s > 0.75:
        return 0.05 * ((s - 0.75) / 0.25) ** 2
    return 0.0


def dz(s: float) -> float:
    """Sheer (deck edge) height."""
    return 0.34 + 0.06 * max(1 - s / 0.25, 0) ** 2


def deck_y(x: float, z: float) -> float:
    s = min(max(x / L, 0), 1)
    b = hb(s)
    return dz(s) + CROWN * (1 - min((z / b) ** 2, 1)) if b > 1e-6 else dz(s)


DOME = {"x0": 0.35, "x1": 2.55, "w": 0.23, "h": 0.2, "p": 2.6}


def dome_prof(x: float) -> float:
    u = (x - DOME["x0"]) / (DOME["x1"] - DOME["x0"])
    if u <= 0 or u >= 1:
        return 0.0
    return math.sqrt(max(1 - abs(2 * u - 1) ** 4, 0))


def dome_h(x: float, z: float) -> float:
    f = dome_prof(x)
    w, h = DOME["w"] * f, DOME["h"] * f
    if w <= 0 or abs(z) >= w:
        return 0.0
    return h * (1 - (abs(z) / w) ** DOME["p"]) ** (1 / DOME["p"])


def k_top(x: float, z: float) -> float:
    return deck_y(x, z) + dome_h(x, z)


# --------------------------------------------------------------- helpers ---
def P(x: float, y: float, z: float) -> tuple[float, float, float]:
    """Builder frame (x aft, y up, z starboard) -> Blender (z up). The glTF
    exporter's +Y-up conversion turns it back into the builder frame."""
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
    name: str, verts, faces, uvs=None, mat=None, smooth=True, sharp_edges=()
) -> bpy.types.Object:
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
    return ob


def lathe(name: str, profile, segs: int, mat, axis_origin, along_x=True) -> bpy.types.Object:
    """Surface of revolution about the builder x axis. profile: [(u_along, r)]."""
    x0, y0, z0 = axis_origin
    verts, faces = [], []
    n = len(profile)
    for i, (a, r) in enumerate(profile):
        for k in range(segs):
            th = 2 * math.pi * k / segs
            verts.append((x0 + a, y0 + r * math.cos(th), z0 + r * math.sin(th)))
    for i in range(n - 1):
        for k in range(segs):
            k2 = (k + 1) % segs
            faces.append((i * segs + k, i * segs + k2, (i + 1) * segs + k2, (i + 1) * segs + k))
    return mesh_object(name, verts, faces, mat=mat)


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


def foil(name: str, root_c, tip_c, root_le, tip_le, y0, y1, t, mat, n_span=8) -> bpy.types.Object:
    """Tapered NACA foil between two horizontal sections, rounded tip cap."""
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
    for si, ring in ((0, range(m)), (n_span, range(m))):
        c = root_c if si == 0 else tip_c
        le = root_le if si == 0 else tip_le
        y = y0 if si == 0 else y1
        ci = len(verts)
        verts.append((le + 0.4 * c, y, 0))
        for k in ring:
            faces.append((si * m + k, si * m + (k + 1) % m, ci))
    return mesh_object(name, verts, faces, mat=mat)


def cylinder(name, r, x, y0, y1, z, mat, segs=32, r_top=None) -> bpy.types.Object:
    """Vertical cylinder with slightly rounded top edge."""
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
    return mesh_object(name, verts, faces, mat=mat)


def rounded_box(name, x0, x1, y0, y1, z0, z1, mat, bevel=0.004) -> bpy.types.Object:
    verts = [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    ob = mesh_object(name, verts, faces, mat=mat, smooth=False)
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
    for p, q in zip(sp.points, pts):
        p.co = (*P(*q), 1)
    ob = bpy.data.objects.new(name, cu)
    bpy.context.collection.objects.link(ob)
    cu.materials.append(mat)
    return ob


# ------------------------------------------------------------- textures ----
def hull_texture(W: int, H: int, NT: int, ND: int) -> np.ndarray:
    """Paint for the hull, indexed by (s along the hull, ring position)."""
    M = 2 * NT + ND  # ring index runs 0..M (keel, starboard, deck, port, keel)
    u = (np.arange(W) + 0.5) / W
    v = (np.arange(H) + 0.5) / H
    S, V = np.meshgrid(u, v)  # (H, W)
    k = V * M
    kzv = np.vectorize(kz)(u)[None, :]
    dzv = np.vectorize(dz)(u)[None, :]
    hbv = np.vectorize(hb)(u)[None, :]
    side_s = k <= NT
    side_p = k >= NT + ND
    j = np.where(side_s, k, np.where(side_p, M - k, NT))
    t = (j / NT) ** 1.6
    height = kzv + t * (dzv - kzv)
    deck = ~(side_s | side_p)

    orange = hexcol(0xF26A1B)
    deck_or = hexcol(0xE0601A)
    boot = hexcol(0xF4F4EE)
    bottom = hexcol(0x2F383F)

    def band(x, lo, hi, w=0.0015):
        return np.clip((x - lo) / w + 0.5, 0, 1) * np.clip((hi - x) / w + 0.5, 0, 1)

    rng = np.random.default_rng(4)
    grain = rng.normal(0, 1, (H, W)).astype(np.float32)
    col = np.empty((H, W, 3), np.float32)
    below = band(height, -1, WL - 0.004)
    stripe = band(height, WL - 0.004, WL + 0.022)
    above = 1 - below - stripe
    for c in range(3):
        col[..., c] = below * bottom[c] + stripe * boot[c] + above * orange[c]
    # Antifouling is matte and a little blotchy; gelcoat is clean.
    col *= (1 + 0.025 * grain * below)[..., None]

    # Deck: diamond non-slip pattern.
    x = S * L
    zz = np.where(deck, hbv * (1 - 2 * (k - NT) / ND), 0)
    diamond = (np.abs(((x * 90) % 1) - 0.5) + np.abs(((zz * 90) % 1) - 0.5)) < 0.32
    deck_col = deck_or[None, None, :] * np.where(diamond, 0.94, 1.02)[..., None]
    col = np.where(deck[..., None], deck_col, col)

    # Name on both bows: "V4", reading forward-to-aft from outside on each side.
    try:
        from PIL import Image, ImageDraw, ImageFont

        font = None
        for f in (
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "DejaVuSans-Bold.ttf",
            "Arial Bold.ttf",
        ):
            try:
                font = ImageFont.truetype(f, 200)
                break
            except OSError:
                pass
        if font is not None:
            # Lettering box on the topsides: x 0.42..0.92 m, height 0.17..0.30 m.
            img = Image.new("L", (1000, 260), 0)
            ImageDraw.Draw(img).text((10, 10), "V4", fill=255, font=font)
            bbox = img.getbbox()
            img = img.crop(bbox)
            glyph = np.asarray(img, np.float32) / 255
            gh, gw = glyph.shape
            x0, x1, y0, y1 = 0.42, 0.42 + 0.13 * gw / gh, 0.17, 0.30
            inside = (x >= x0) & (x <= x1) & (height >= y0) & (height <= y1) & (side_s | side_p)
            gx = (x - x0) / (x1 - x0)
            gx = np.where(side_p, 1 - gx, gx)  # mirror on port so it reads from outside
            gi = np.clip(((y1 - height) / (y1 - y0) * (gh - 1)).astype(int), 0, gh - 1)
            gj = np.clip((gx * (gw - 1)).astype(int), 0, gw - 1)
            a = np.where(inside, glyph[gi, gj], 0)[..., None]
            col = col * (1 - a) + hexcol(0x1B2430)[None, None, :] * a
    except ImportError:
        pass
    return col


def cell_texture(cols: int, rows: int, px_per_cell: int = 64) -> np.ndarray:
    """Solar panel: blue-black cells, fine fingers, white busbars, aluminium frame."""
    W, H = cols * px_per_cell, rows * px_per_cell
    yy, xx = np.mgrid[0:H, 0:W]
    cu = (xx % px_per_cell) / px_per_cell
    cv = (yy % px_per_cell) / px_per_cell
    rng = np.random.default_rng(7)
    base = hexcol(0x101C33)[None, None, :] * (1 + 0.08 * rng.normal(0, 1, (H, W, 1)))
    col = base.copy()
    gap = (cu < 0.03) | (cu > 0.97) | (cv < 0.03) | (cv > 0.97)
    col[gap] = hexcol(0xD9DEE6)
    fingers = (np.abs(((cv * 22) % 1) - 0.5) < 0.06) & ~gap
    col[fingers] = col[fingers] * 0.85 + hexcol(0x6E7F99) * 0.15
    bus = ((np.abs(cu - 0.33) < 0.012) | (np.abs(cu - 0.67) < 0.012)) & ~gap
    col[bus] = hexcol(0xC8CED8)
    frame = (xx < 6) | (xx >= W - 6) | (yy < 6) | (yy >= H - 6)
    col[frame] = hexcol(0xB8BEC6)
    return col


# ---------------------------------------------------------------- build ----
def build() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    # Hull: dense rings like parts.ts hull(), one closed loop per station.
    NX, NT, ND = 180, 32, 18
    M = 2 * NT + ND
    verts, faces, uvs, sharp = [], [], [], []
    idx = {}
    for i in range(NX + 1):
        s = i / NX
        x = s * L
        b = max(hb(s), 0.0005)
        zk, zd = kz(s), dz(s)
        for kk in range(M):
            if kk <= NT:
                t = (kk / NT) ** 1.6
                lat = b * (1 - (1 - t) ** N_FULL) ** (1 / N_FULL)
                p = (x, zk + t * (zd - zk), lat)
            elif kk < NT + ND:
                zz = b * (1 - 2 * (kk - NT) / ND)
                p = (x, zd + CROWN * (1 - (zz / b) ** 2), zz)
            else:
                t = ((M - kk) / NT) ** 1.6
                lat = b * (1 - (1 - t) ** N_FULL) ** (1 / N_FULL)
                p = (x, zk + t * (zd - zk), -lat)
            idx[(i, kk)] = len(verts)
            verts.append(p)
    for i in range(NX):
        for kk in range(M):
            k2 = (kk + 1) % M
            faces.append((idx[(i, kk)], idx[(i, k2)], idx[(i + 1, k2)], idx[(i + 1, kk)]))
            u0, u1 = i / NX, (i + 1) / NX
            v0, v1 = kk / M, (kk + 1) / M
            uvs.append([(u0, v0), (u0, v1), (u1, v1), (u1, v0)])
        sharp.append((idx[(i, NT)], idx[(i + 1, NT)]))
        sharp.append((idx[(i, NT + ND)], idx[(i + 1, NT + ND)]))
    # Transom: fan to its middle (own plain material).
    c = len(verts)
    ring = [verts[idx[(NX, kk)]] for kk in range(M)]
    verts.append((L, sum(p[1] for p in ring) / M, 0))
    transom_faces = [(idx[(NX, kk)], c, idx[(NX, (kk + 1) % M)]) for kk in range(M)]
    for kk in range(M):
        sharp.append((idx[(NX, kk)], idx[(NX, (kk + 1) % M)]))

    hull_img = new_image("hull_paint", 2048, 512)
    hull_rgb = hull_texture(2048, 512, NT, ND)
    set_pixels(hull_img, hull_rgb)
    hull_mat = material("hull", image=hull_img, rough=0.32, coat=0.5)
    transom_mat = material("transom", base=hexcol(0xE8641C), rough=0.35, coat=0.5)
    hull = mesh_object(
        "hull",
        verts,
        faces + transom_faces,
        uvs=uvs + [[(0.999, 0.5)] * 3 for _ in transom_faces],
        mat=hull_mat,
        sharp_edges=sharp,
    )
    hull.data.materials.append(transom_mat)
    for poly in hull.data.polygons[len(faces) :]:
        poly.material_index = 1

    # Rubbing strake along the sheer, both sides, and round the stern.
    rub = material("rubber", base=hexcol(0x2A2E33), rough=0.7)
    for side in (1, -1):
        pts = []
        for i in range(0, NX + 1, 2):
            s = i / NX
            pts.append((s * L, dz(s) - 0.004, side * (max(hb(s), 0.0005) + 0.004)))
        tube(f"strake_{'stbd' if side > 0 else 'port'}", pts, 0.011, rub)
    tube(
        "strake_stern",
        [(L + 0.004, dz(1) - 0.004, z) for z in np.linspace(-hb(1) - 0.004, hb(1) + 0.004, 12)],
        0.011,
        rub,
    )

    # Self-righting dome (foam, gelcoated), with UVs for its baked shadows.
    nx, na = 120, 48
    dv, df, duv = [], [], []
    for i in range(nx + 1):
        x = DOME["x0"] + (DOME["x1"] - DOME["x0"]) * i / nx
        f = dome_prof(x)
        w = max(DOME["w"] * f, 0.0005)
        h = max(DOME["h"] * f, 0.0005)
        for j in range(na + 1):
            th = math.pi * j / na
            cth, sth = math.cos(th), math.sin(th)
            z = w * math.copysign(abs(cth) ** (2 / DOME["p"]), cth)
            y = h * sth ** (2 / DOME["p"])
            dv.append((x, deck_y(x, z) - 0.01 + y, z))
    for i in range(nx):
        for j in range(na):
            a = i * (na + 1) + j
            bb = a + na + 1
            df.append((a, a + 1, bb + 1, bb))
            duv.append(
                [
                    (i / nx, j / na),
                    (i / nx, (j + 1) / na),
                    ((i + 1) / nx, (j + 1) / na),
                    ((i + 1) / nx, j / na),
                ]
            )
    dome_img = new_image("dome_paint", 1024, 512)
    dome_rgb = np.ones((512, 1024, 3), np.float32) * hexcol(0xFF7B2B)
    set_pixels(dome_img, dome_rgb)
    dome = mesh_object(
        "dome", dv, df, uvs=duv, mat=material("dome", image=dome_img, rough=0.3, coat=0.6)
    )

    # Solar panels draped over the dome and aft deck: 100 W, 100 W, 50 W.
    for name, x0, x1, w, cols, rows in (
        ("panel_fwd", 0.55, 1.53, 0.54, 6, 3),
        ("panel_mid", 1.59, 2.5, 0.54, 6, 3),
        ("panel_aft", 2.56, 2.92, 0.34, 3, 3),
    ):
        pnx, pnz = 48, 24
        pv, pf, puv = [], [], []
        for i in range(pnx + 1):
            for j in range(pnz + 1):
                x = x0 + (x1 - x0) * i / pnx
                z = -w / 2 + w * j / pnz
                pv.append((x, k_top(x, z) + 0.014, z))
        for i in range(pnx):
            for j in range(pnz):
                a = i * (pnz + 1) + j
                bb = a + pnz + 1
                pf.append((a, bb, bb + 1, a + 1))
                puv.append(
                    [
                        (i / pnx, j / pnz),
                        ((i + 1) / pnx, j / pnz),
                        ((i + 1) / pnx, (j + 1) / pnz),
                        (i / pnx, (j + 1) / pnz),
                    ]
                )
        img = new_image(f"{name}_cells", cols * 64, rows * 64)
        set_pixels(img, cell_texture(cols, rows))
        ob = mesh_object(
            name, pv, pf, uvs=puv, mat=material(name, image=img, rough=0.12, metal=0.1, coat=0.8)
        )
        sol = ob.modifiers.new("thickness", "SOLIDIFY")
        sol.thickness = 0.008
        sol.offset = -1

    # Keel fin (G10) and 50 kg lead bulb; rudder.
    g10 = material("g10", base=hexcol(0x2B2F33), rough=0.45)
    lead = material("lead", base=hexcol(0x7A8086), rough=0.35, metal=0.6)
    bulb_y = WL - BALLAST_DEPTH
    sweep = (0.05 - (bulb_y + 0.03)) * math.tan(math.radians(20))
    foil("keel", 0.25, 0.25, 1.32, 1.32 + sweep, 0.05, bulb_y + 0.03, 0.1, g10)
    R, blen, at = 0.0625, 0.55, 0.4
    prof = []
    for kk in range(61):
        u = kk / 60
        r = (
            R * math.sqrt(max(1 - ((at - u) / at) ** 2, 0))
            if u <= at
            else R * max(1 - ((u - at) / (1 - at)) ** 2, 0) ** 0.75
        )
        prof.append((u * blen, max(r, 0.0004)))
    lathe("bulb", prof, 48, lead, (1.4, bulb_y, 0))
    foil("rudder", 0.2, 0.17, 2.86, 2.9, 0.06, -0.3, 0.12, g10)

    # Deck kit: AIS whip, all-round light, Globalstar beacon, tow eye.
    black = material("black", base=hexcol(0x222426), rough=0.5)
    white = material("white", base=hexcol(0xF4F4F0), rough=0.4)
    lamp = material("lamp", base=hexcol(0xFFFFFF), rough=0.2, emit=(1.0, 0.95, 0.77))
    steel = material("steel", base=hexcol(0xC9CED3), rough=0.25, metal=0.9)
    aft = deck_y(3.0, 0.11)
    cylinder("ais_base", 0.012, 3.0, aft, aft + 0.06, 0.11, black)
    cylinder("ais_whip", 0.005, 3.0, aft + 0.06, aft + 0.95, 0.11, white, segs=12, r_top=0.003)
    cylinder("light_post", 0.008, 3.0, aft, aft + 0.2, -0.11, black, segs=16)
    cylinder("light", 0.022, 3.0, aft + 0.2, aft + 0.25, -0.11, lamp)
    gs = deck_y(0.3, 0)
    rounded_box(
        "beacon",
        0.255,
        0.345,
        gs,
        gs + 0.028,
        -0.035,
        0.035,
        material("beacon", base=hexcol(0xF2C200), rough=0.4),
        0.006,
    )
    rounded_box(
        "beacon_top",
        0.265,
        0.335,
        gs + 0.026,
        gs + 0.031,
        -0.028,
        0.028,
        material("beacon_top", base=hexcol(0x24324A), rough=0.25, metal=0.3),
        0.002,
    )
    bpy.ops.mesh.primitive_torus_add(
        major_radius=0.03,
        minor_radius=0.007,
        major_segments=32,
        minor_segments=12,
        location=P(0.03, 0.31, 0),
        rotation=(0, 0, 0),
    )
    eye = bpy.context.active_object
    eye.name = "tow_eye"
    eye.rotation_euler = (math.pi / 2, 0, 0)
    eye.data.materials.append(steel)
    eye.data.shade_smooth()

    # Baked soft shadows (ambient occlusion) on the hull and dome, painted into their colours.
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = BAKE_SAMPLES
    scene.world = bpy.data.worlds.new("w")
    for ob, img, rgb in ((hull, hull_img, hull_rgb), (dome, dome_img, dome_rgb)):
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
        a = get_pixels(ao)[..., :1]
        a = np.clip(a, 0, 1) ** 0.8
        set_pixels(img, rgb * (0.3 + 0.7 * a))
        for m, n in nodes:
            m.node_tree.nodes.remove(n)
        bpy.data.images.remove(ao)

    # Apply modifiers and curves so the file holds plain meshes, then export.
    for ob in list(scene.objects):
        if ob.type == "CURVE":
            bpy.ops.object.select_all(action="DESELECT")
            ob.select_set(True)
            bpy.context.view_layer.objects.active = ob
            bpy.ops.object.convert(target="MESH")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUT),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_image_format="JPEG",
        export_jpeg_quality=88,
        export_extras=False,
    )
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")


build()
# bpy can crash while shutting down after a successful export (seen on CI):
# leave straight away with the right exit code.
sys.stdout.flush()
os._exit(0)
