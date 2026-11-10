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
import sys
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))  # for blender -P

from common import (
    HullForm,
    HullPaint,
    P,
    bake_ao,
    bulb_profile,
    cylinder,
    export,
    foil,
    hexcol,
    hull,
    lathe,
    material,
    mesh_object,
    new_image,
    out_path,
    panel,
    reset,
    rounded_box,
    set_pixels,
    strakes,
)

# ---------------------------------------------------------------- shape ----
# src/boats/model.ts buildKayak: HullForm K and specs.ts KAYAK.
L = 3.05
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


K = HullForm(L=L, n=3.0, crown=0.025, wl=WL, hb=hb, kz=kz, dz=dz)
PAINT = HullPaint(
    top=0xF26A1B,
    deck=0xE0601A,
    boot=0xF4F4EE,
    bottom=0x2F383F,
    lettering="V4",
    letter_box=(0.42, 0.17, 0.30),
)
deck_y = K.deck_y

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


def build(out: Path) -> None:
    reset()
    hull_ob, hull_img, hull_rgb = hull(K, PAINT, rough=0.32, coat=0.5)
    strakes(K, material("rubber", base=hexcol(0x2A2E33), rough=0.7))

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
    panel("panel_fwd", 0.55, 1.53, 0.54, k_top, 6, 3)
    panel("panel_mid", 1.59, 2.5, 0.54, k_top, 6, 3)
    panel("panel_aft", 2.56, 2.92, 0.34, k_top, 3, 3)

    # Keel fin (G10) and 50 kg lead bulb; rudder.
    g10 = material("g10", base=hexcol(0x2B2F33), rough=0.45)
    lead = material("lead", base=hexcol(0x7A8086), rough=0.35, metal=0.6)
    bulb_y = WL - BALLAST_DEPTH
    sweep = (0.05 - (bulb_y + 0.03)) * math.tan(math.radians(20))
    foil("keel", 0.25, 0.25, 1.32, 1.32 + sweep, 0.05, bulb_y + 0.03, 0.1, g10)
    prof = bulb_profile(0.55, 0.125, 0.4)
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

    bake_ao([(hull_ob, hull_img, hull_rgb), (dome, dome_img, dome_rgb)])
    export(out)


build(out_path("kayak.glb"))
