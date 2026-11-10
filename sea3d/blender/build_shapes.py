"""Build the Boatyard's other hull shapes as detailed 3D models (glTF .glb).

    python sea3d/blender/build_shapes.py cat     sea3d/public/models/shape_cat.glb
    python sea3d/blender/build_shapes.py semisub sea3d/public/models/shape_semisub.glb
    python sea3d/blender/build_shapes.py board   sea3d/public/models/shape_board.glb

(one shape per run: export() ends the process). Same frame and helpers as
build_kayak.py: x aft from the bow, y up from the hull bottom, z to starboard,
metres. These are design studies for the Boatyard, drawn at the sizes agreed
with Theo (length, beam, mass in src/yard/shapes.ts) so his physics and the
picture describe the same boat. Each carries today's kit: two T200 thrusters
(drawn here, without propellers), solar panels, the electronics, the
Globalstar beacon, an AIS whip and the all-round light.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy

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
    panel,
    reset,
    rod,
    rounded_box,
    strakes,
)

PAINT = HullPaint(top=0xF26A1B, deck=0xE0601A, boot=0xF4F4EE, bottom=0x2F383F, lettering=None)


def kit(x: float, y: float, z: float, mats) -> None:
    """AIS whip, all-round light and the yellow Globalstar beacon, standing on (x, y, z)."""
    black, white, lamp, _, _ = mats
    cylinder("ais_base", 0.012, x, y, y + 0.06, z + 0.09, black)
    cylinder("ais_whip", 0.005, x, y + 0.06, y + 0.95, z + 0.09, white, segs=12, r_top=0.003)
    cylinder("light_post", 0.008, x, y, y + 0.2, z - 0.09, black, segs=16)
    cylinder("light", 0.022, x, y + 0.2, y + 0.25, z - 0.09, lamp)


def beacon(x: float, y: float, z: float, mats) -> None:
    _, _, _, bmat, btop = mats
    rounded_box("beacon", x - 0.045, x + 0.045, y, y + 0.028, z - 0.035, z + 0.035, bmat, 0.006)
    rounded_box(
        "beacon_top", x - 0.035, x + 0.035, y + 0.026, y + 0.031, z - 0.028, z + 0.028, btop, 0.002
    )


def thruster(
    name: str, x: float, y: float, z: float, mat, strut_top: float | None = None, strut=None
) -> None:
    """A T200 body (about 0.11 m long, 0.1 m across) lying fore and aft, on a strut."""
    prof = [
        (0.0, 0.0004),
        (0.01, 0.03),
        (0.03, 0.045),
        (0.08, 0.05),
        (0.105, 0.04),
        (0.115, 0.0004),
    ]
    lathe(name, prof, 32, mat, (x, y, z))
    if strut_top is not None and strut is not None:
        foil(f"{name}_strut", 0.08, 0.08, x + 0.015, x + 0.015, y + 0.03, strut_top, 0.15, strut)


def common_mats():
    return (
        material("black", base=hexcol(0x222426), rough=0.5),
        material("white", base=hexcol(0xF4F4F0), rough=0.4),
        material("lamp", base=hexcol(0xFFFFFF), rough=0.2, emit=(1.0, 0.95, 0.77)),
        material("beacon", base=hexcol(0xF2C200), rough=0.4),
        material("beacon_top", base=hexcol(0x24324A), rough=0.25, metal=0.3),
    )


# ------------------------------------------------------------- catamaran ----
# Two slim hulls, 3.0 m long, 0.30 m wide, 1.30 m apart; a bridge deck with
# three panels; the electronics in a pod under the deck; a thruster under each
# hull (steering by running them at different speeds, no rudder).
CAT = {"L": 3.0, "half_gap": 0.65, "hb": 0.15, "depth": 0.38, "wl": 0.16}


def build_cat() -> list:
    L, g = CAT["L"], CAT["half_gap"]

    def hb(s: float) -> float:
        if s <= 0.45:
            return CAT["hb"] * max(1 - (1 - s / 0.45) ** 2, 0) ** 0.6
        return CAT["hb"] - (CAT["hb"] - 0.09) * ((s - 0.45) / 0.55) ** 2

    def kz(s: float) -> float:
        return 0.18 * (1 - s / 0.25) ** 2 if s < 0.25 else 0.02 * max((s - 0.85) / 0.15, 0) ** 2

    def dz(s: float) -> float:
        return CAT["depth"] + 0.05 * max(1 - s / 0.2, 0) ** 2

    f = HullForm(L=L, n=2.4, crown=0.015, wl=CAT["wl"], hb=hb, kz=kz, dz=dz)
    stbd, img, rgb = hull(f, PAINT, rough=0.32, coat=0.5, nx=140, nt=26, nd=12)
    stbd.location = P(0, 0, g)
    port = stbd.copy()  # the same hull, shared mesh and paint
    port.name = "hull_port"
    bpy.context.collection.objects.link(port)
    port.location = P(0, 0, -g)
    rubber = material("rubber", base=hexcol(0x2A2E33), rough=0.7)
    for side in (1, -1):
        sf = HullForm(L=L, n=2.4, crown=0.015, wl=CAT["wl"], hb=hb, kz=kz, dz=dz)
        strakes(sf, rubber)
        for name in ("strake_stbd", "strake_port", "strake_stern"):
            ob = bpy.data.objects.get(name)
            if ob is not None:
                ob.location = P(0, 0, side * g)
                ob.name = f"{name}_{'s' if side > 0 else 'p'}"

    # Bridge deck: two aluminium beams and a white composite deck on them.
    alu = material("steel", base=hexcol(0xC9CED3), rough=0.3, metal=0.85)
    deck_y = CAT["depth"] + 0.07
    for x in (0.72, 2.45):
        rod(f"beam_{x:.2f}", (x, deck_y - 0.03, -g), (x, deck_y - 0.03, g), 0.03, alu)
    deck = material("white", base=hexcol(0xF2F2EE), rough=0.4)
    rounded_box("bridge_deck", 0.62, 2.55, deck_y, deck_y + 0.035, -g - 0.05, g + 0.05, deck, 0.01)
    top = lambda x, z: deck_y + 0.035
    panel("panel_fwd", 0.68, 1.28, 1.2, top, 7, 3)
    panel("panel_mid", 1.32, 1.92, 1.2, top, 7, 3)
    panel("panel_aft", 1.96, 2.5, 1.2, top, 7, 3)
    # Electronics pod slung under the deck, clear of the water.
    pod = material("dome", base=hexcol(0xFF7B2B), rough=0.3, coat=0.6)
    prof = bulb_profile(1.1, 0.26, 0.35)
    lathe("pod", prof, 40, pod, (0.95, deck_y - 0.15, 0))
    mats = common_mats()
    kit(2.42, deck_y + 0.035, 0, mats)
    beacon(0.68, deck_y + 0.035, 0, mats)
    g10 = material("g10", base=hexcol(0x2B2F33), rough=0.45)
    for side in (1, -1):
        thruster(
            f"thruster_{'starboard' if side > 0 else 'port'}",
            2.62,
            -0.07,
            side * g,
            mats[0],
            0.03,
            g10,
        )
    return [(stbd, img, rgb)]


# ------------------------------------------------------- semi-submerged -----
# A cigar-shaped hull riding almost awash (0.10 m of freeboard), 3.2 m by
# 0.50 m and 0.28 m deep (Theo's option a, 175 kg, 0.18 m draft); a short streamlined tower for the antennas and the beacon; two
# panels on the flat top (often under water, so less sun); lead low inside.
SEMI = {"L": 3.2, "hb": 0.25, "depth": 0.28, "wl": 0.18}


def build_semisub() -> list:
    L = SEMI["L"]

    def hb(s: float) -> float:
        return SEMI["hb"] * max(1 - abs(2 * s - 1) ** 2.6, 0) ** 0.5 + 0.004

    def kz(s: float) -> float:
        return 0.11 * max(1 - s / 0.18, 0) ** 2 + 0.06 * max((s - 0.88) / 0.12, 0) ** 2

    def dz(s: float) -> float:
        return (
            SEMI["depth"] - 0.05 * max(1 - s / 0.15, 0) ** 2 - 0.04 * max((s - 0.9) / 0.1, 0) ** 2
        )

    f = HullForm(L=L, n=2.0, crown=0.06, wl=SEMI["wl"], hb=hb, kz=kz, dz=dz)
    ob, img, rgb = hull(f, PAINT, rough=0.32, coat=0.5, nx=160, nt=28, nd=14)
    strakes(f, material("rubber", base=hexcol(0x2A2E33), rough=0.7), r=0.009)
    top = lambda x, z: f.deck_y(x, z)
    panel("panel_fwd", 0.55, 1.4, 0.34, top, 5, 2)
    panel("panel_aft", 1.85, 2.7, 0.34, top, 5, 2)
    # The tower: a streamlined fin standing on the deck, a cap for the antennas.
    tower = material("dome", base=hexcol(0xFF7B2B), rough=0.3, coat=0.6)
    y0 = f.deck_y(1.6, 0)
    foil("tower", 0.36, 0.26, 1.45, 1.52, y0 - 0.02, y0 + 0.55, 0.22, tower)
    mats = common_mats()
    kit(1.66, y0 + 0.55, 0, mats)
    beacon(1.58, y0 + 0.55, 0, mats)
    g10 = material("g10", base=hexcol(0x2B2F33), rough=0.45)
    for side in (1, -1):
        thruster(
            f"thruster_{'starboard' if side > 0 else 'port'}",
            2.9,
            0.0,
            side * 0.15,
            mats[0],
            0.1,
            g10,
        )
    foil("rudder", 0.16, 0.13, 3.0, 3.03, 0.03, -0.18, 0.12, g10)
    return [(ob, img, rgb)]


# ------------------------------------------------------------- surfboard ----
# A flat, wide, thin board, 3.0 m by 0.85 m and 0.18 m deep, with two panels
# flush on the deck; a 0.9 m fin with a 25 kg bulb, and a buoyant 60 L pod on
# deck (the electronics dome, 0.3 m tall) so it rights itself (Theo).
BOARD = {"L": 3.0, "hb": 0.425, "depth": 0.18, "wl": 0.06, "fin": 0.9}


def build_board() -> list:
    L = BOARD["L"]

    def hb(s: float) -> float:
        if s <= 0.4:
            return BOARD["hb"] * max(1 - (1 - s / 0.4) ** 2, 0) ** 0.5
        return BOARD["hb"] - (BOARD["hb"] - 0.3) * ((s - 0.4) / 0.6) ** 2

    def kz(s: float) -> float:
        return 0.12 * max(1 - s / 0.28, 0) ** 2.2  # rocker at the nose

    def dz(s: float) -> float:
        return BOARD["depth"] + 0.08 * max(1 - s / 0.2, 0) ** 2

    f = HullForm(L=L, n=6.0, crown=0.03, wl=BOARD["wl"], hb=hb, kz=kz, dz=dz)
    ob, img, rgb = hull(f, PAINT, rough=0.32, coat=0.5, nx=160, nt=20, nd=20)
    strakes(f, material("rubber", base=hexcol(0x2A2E33), rough=0.7), r=0.008)
    top = lambda x, z: f.deck_y(x, z)
    panel("panel_fwd", 0.42, 1.12, 0.62, top, 5, 4, lift=0.006)
    panel("panel_aft", 1.98, 2.62, 0.62, top, 5, 4, lift=0.006)
    # The buoyant pod: a low streamlined dome, 0.8 m long, 0.5 m wide, 0.3 m
    # tall (about 60 L), its foam-filled top what flips the board back up.
    dome = material("dome", base=hexcol(0xFF7B2B), rough=0.3, coat=0.6)
    x0, x1, yd = 1.16, 1.94, f.deck_y(1.55, 0)
    verts, faces = [], []
    nu, nv = 36, 18
    for i in range(nu + 1):
        u = i / nu
        x = x0 + (x1 - x0) * u
        half_l = math.sin(math.pi * u) ** 0.55  # 0 at the ends
        for j in range(nv + 1):
            a = math.pi * j / nv  # 0 = starboard, pi = port, over the top
            zz = 0.25 * half_l * math.cos(a)
            yy = yd - 0.01 + 0.31 * half_l * math.sin(a) ** 0.8
            verts.append(P(x, yy, zz))
    for i in range(nu):
        for j in range(nv):
            k = i * (nv + 1) + j
            faces.append((k, k + nv + 1, k + nv + 2, k + 1))
    me = bpy.data.meshes.new("pod")
    me.from_pydata(verts, [], faces)
    me.update()
    for poly in me.polygons:
        poly.use_smooth = True
    pod = bpy.data.objects.new("pod", me)
    pod.data.materials.append(dome)
    bpy.context.collection.objects.link(pod)
    g10 = material("g10", base=hexcol(0x2B2F33), rough=0.45)
    lead = material("lead", base=hexcol(0x7A8086), rough=0.35, metal=0.6)
    bulb_y = -BOARD["fin"] + 0.02
    foil("keel", 0.3, 0.24, 1.25, 1.42, 0.01, bulb_y + 0.03, 0.1, g10)
    lathe("bulb", bulb_profile(0.5, 0.1, 0.4), 48, lead, (1.3, bulb_y, 0))
    mats = common_mats()
    kit(2.75, f.deck_y(2.75, 0), 0, mats)
    beacon(1.62, yd + 0.29, 0, mats)
    for side in (1, -1):
        thruster(
            f"thruster_{'starboard' if side > 0 else 'port'}",
            2.72,
            -0.1,
            side * 0.2,
            mats[0],
            0.01,
            g10,
        )
    return [(ob, img, rgb)]


BUILD = {"cat": build_cat, "semisub": build_semisub, "board": build_board}


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    if len(args) != 2 or args[0] not in BUILD:
        sys.exit(f"usage: build_shapes.py {{{'|'.join(BUILD)}}} out.glb")
    reset()
    bake = BUILD[args[0]]()
    bake_ao(bake)
    export(Path(args[1]))


main()
