"""Build the stock sailing boats as detailed 3D models (glTF .glb).

    python sea3d/blender/build_stock.py cruiser sea3d/public/models/stock_cruiser.glb
    python sea3d/blender/build_stock.py dinghy  sea3d/public/models/stock_dinghy.glb
    python sea3d/blender/build_stock.py beachcat sea3d/public/models/stock_beachcat.glb
    python sea3d/blender/build_stock.py drone   sea3d/public/models/stock_drone.glb
    python sea3d/blender/build_stock.py rower   sea3d/public/models/stock_rower.glb
    python sea3d/blender/build_stock.py pearson sea3d/public/models/stock_pearson.glb

(one boat per run: export() ends the process). Same frame and helpers as
build_kayak.py: x aft from the bow, y up from the bottom of the hull (the
canoe body; keels and boards hang below 0), metres. The page turns the model
half a turn about y to put the bow forward, so builder +z ends up to PORT
(boats/gear.ts): the red port light sits at +z.

Generic boats of three common kinds, with no maker's names, logos or sail
insignia (Maya, 11 Nov):
- cruiser: a 31 ft (9.45 m) masthead-sloop cruising yacht, fin keel and spade
  rudder, cabin trunk, cockpit, lifelines;
- dinghy: a 13 ft 9 in (4.2 m) lateen-rigged board boat, the kind people learn
  on: a flat deck, a little footwell, a daggerboard and a kick-up rudder;
- beachcat: a 16 ft (4.9 m) beach catamaran, two hulls, a trampoline, a tall
  rotating mast with a fully battened main and a jib, a rudder on each hull;
- drone: a 7 m wind-powered ocean drone (configs/stock_sail_drone7.yaml): a
  narrow hull on a deep keel, a 5 m rigid wing that turns freely on its mast
  and is set to the wind by a small tail flap on two booms, solar panels and
  a sensor mast. Generic colours, no maker's look;
- rower: an 8.64 m ocean rowing boat for four (configs/stock_ocean_rower45.yaml):
  cabins at both ends, two rowing stations with sliding seats and outriggers,
  a daggerboard and a transom rudder.

Sails sit under empties the page can find by name and turn with the sheet:
"main_pivot" (on the mast) and "jib_pivot" (on the forestay), so trimming
them later is a rotation, not a rebuild. Rudders and tillers sit under
"rudder_pivot" (one per hull on the cat: "rudder_pivot_s" / "rudder_pivot_p").
The drone's whole wing, booms and tail flap hang under "wing_pivot", which
the page turns to the wind (boats/gear.ts), as on Randolph's Rev B.
The rower's oars hang under "oar_<station>_<s|p>" at their gates and its
seats under "seat_<station>", so the page can row them.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))  # for blender -P

from common import (
    HullFinish,
    HullForm,
    HullPaint,
    attach,
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
    panel,
    pivot,
    reset,
    rod,
    rounded_box,
    tube,
)


# ------------------------------------------------------------- helpers ----
def sail(name, tack, head, clew, depth, mat, n=24, m=14, parent=None):
    """A sail between three corners (builder frame), with camber: the chord
    from luff to leech bellies out `depth` (fraction of chord) to starboard
    of the sail's plane, deepest about 40% back, flatter towards the head."""
    tack, head, clew = (np.array(p, float) for p in (tack, head, clew))
    nrm = np.cross(head - tack, clew - tack)
    nrm /= np.linalg.norm(nrm)
    if nrm[2] < 0:
        nrm = -nrm  # belly to builder +z, port (the page mirrors the pivot for the other tack)
    verts, faces = [], []
    for i in range(n + 1):
        t = i / n
        luff = tack + (head - tack) * t
        leech = clew + (head - clew) * t
        chord = np.linalg.norm(leech - luff)
        for j in range(m + 1):
            u = j / m
            bulge = math.sin(math.pi * u**0.8) * depth * chord * (1 - 0.55 * t)
            verts.append(tuple(luff + (leech - luff) * u + nrm * bulge))
    uvs = []
    for i in range(n):
        for j in range(m):
            k = i * (m + 1) + j
            faces.append((k, k + 1, k + m + 2, k + m + 1))
            # u: luff (0) to leech (1); v: foot (0) to head (1). The page's sail
            # cloth draws its seams and tapes and ripples the luff from these.
            u0, u1, v0, v1 = j / m, (j + 1) / m, i / n, (i + 1) / n
            uvs.append([(u0, v0), (u1, v0), (u1, v1), (u0, v1)])
    return mesh_object(name, verts, faces, uvs=uvs, mat=mat, parent=parent)


def battens(name, tack, head, clew, depth, k, mat, parent=None):
    """Thin dark strips across a sail (fully battened mains)."""
    tack, head, clew = (np.array(p, float) for p in (tack, head, clew))
    nrm = np.cross(head - tack, clew - tack)
    nrm /= np.linalg.norm(nrm)
    if nrm[2] < 0:
        nrm = -nrm
    for b in range(1, k + 1):
        t = b / (k + 1)
        luff = tack + (head - tack) * t
        leech = clew + (head - clew) * t
        chord = np.linalg.norm(leech - luff)
        pts = []
        for j in range(13):
            u = j / 12
            bulge = math.sin(math.pi * u**0.8) * depth * chord * (1 - 0.55 * t)
            pts.append(tuple(luff + (leech - luff) * u + nrm * (bulge + 0.004)))
        ob = tube(f"{name}_{b}", pts, 0.006, mat, segs=8)
        if parent is not None:
            attach(ob, parent)


def flat_quad(name, a, b, c, d, mat, parent=None):
    return mesh_object(name, [a, b, c, d], [(0, 1, 2, 3)], mat=mat, smooth=False, parent=parent)


def stanchions(f: HullForm, xs, height, inset, mat_post, mat_wire, ends=None):
    """Posts along both sheers, two wires through them; `ends` closes the line
    at the pulpit and pushpit (x positions)."""
    for side in (1, -1):
        top, mid = [], []
        line = list(xs)
        for x in line:
            s = x / f.L
            z = side * (f.hb(s) - inset)
            y0 = f.deck_y(x, z)
            rod(
                f"stanchion_{x:.2f}_{'p' if side > 0 else 's'}",
                (x, y0, z),
                (x, y0 + height, z),
                0.012,
                mat_post,
                segs=10,
            )
            top.append((x, y0 + height, z))
            mid.append((x, y0 + height * 0.5, z))
        if ends:
            for pts in (top, mid):
                pts.insert(0, (ends[0], pts[0][1], pts[0][2] * 0.85))
                pts.append((ends[1], pts[-1][1], pts[-1][2]))
        tube(f"lifeline_top_{'p' if side > 0 else 's'}", top, 0.003, mat_wire, segs=8)
        tube(f"lifeline_mid_{'p' if side > 0 else 's'}", mid, 0.003, mat_wire, segs=8)


def mats():
    return {
        "steel": material("steel", base=hexcol(0xCDD2D7), rough=0.25, metal=0.9),
        "alu": material("alu", base=hexcol(0xB9BEC4), rough=0.35, metal=0.8),
        "wire": material("wire", base=hexcol(0x9AA0A6), rough=0.3, metal=0.9),
        "black": material("black", base=hexcol(0x1E2124), rough=0.5),
        "sail": material("sail", base=hexcol(0xE8E3D6), rough=0.8),  # Dacron: warm off-white
        "teak": material("teak", base=hexcol(0x9C7A55), rough=0.7),
        "glass": material("glass", base=hexcol(0x1A2530), rough=0.08, metal=0.2),
        "lamp": material("lamp", base=hexcol(0xFFFFFF), rough=0.2, emit=(1.0, 0.95, 0.77)),
        "lead": material("lead", base=hexcol(0x3B3F44), rough=0.5, metal=0.3),
        "g10": material("g10", base=hexcol(0xEEEDE8), rough=0.4),
    }


# --------------------------------------------------------------- cruiser ----
# 9.45 m long, 3.2 m beam, 1.75 m draft (fin keel with a bulb), masthead
# sloop with a 12.5 m mast above the deck. White topsides, a navy boot stripe.
CRUISER = {"L": 9.45, "B": 1.6, "wl": 0.55, "mast_x": 3.35, "mast_h": 12.4}
CRUISER_PAINT = HullPaint(
    top=0xF4F3EF, deck=0xE8E5DC, boot=0x1D2F4D, bottom=0x23344F, lettering=None
)
# A modern boat: bright, straight, glossy gelcoat.
CRUISER_FINISH = HullFinish(top_rough=0.12, top_coat=1.0)


def build_cruiser() -> list:
    L, B = CRUISER["L"], CRUISER["B"]
    M = mats()

    def hb(s: float) -> float:
        if s <= 0.56:
            return B * max(1 - (1 - s / 0.56) ** 2, 0) ** 0.62
        return B - (B - 1.32) * ((s - 0.56) / 0.44) ** 2  # a wide transom

    def kz(s: float) -> float:
        return 0.62 * max(1 - s / 0.2, 0) ** 2 + 0.36 * max((s - 0.72) / 0.28, 0) ** 1.8

    def dz(s: float) -> float:
        return 1.5 - 0.28 * s + 0.12 * max(1 - s / 0.15, 0) ** 2

    f = HullForm(L=L, n=2.3, crown=0.05, wl=CRUISER["wl"], hb=hb, kz=kz, dz=dz)
    ob, img, rgb = hull(
        f, CRUISER_PAINT, rough=0.22, coat=0.6, nx=200, nt=34, nd=20, finish=CRUISER_FINISH
    )
    rub = material("rubrail", base=hexcol(0x2A2E33), rough=0.5)
    tube(
        "toerail_s",
        [(x, f.dz(x / L) + 0.015, hb(x / L) - 0.01) for x in np.linspace(0.15, L - 0.02, 40)],
        0.018,
        rub,
    )
    tube(
        "toerail_p",
        [(x, f.dz(x / L) + 0.015, -hb(x / L) + 0.01) for x in np.linspace(0.15, L - 0.02, 40)],
        0.018,
        rub,
    )

    # Fin keel with a bulb, and a spade rudder.
    foil("keel", 1.35, 0.9, 3.55, 3.95, 0.25, -1.12, 0.11, M["lead"], n_span=10)
    lathe("keel_bulb", bulb_profile(1.6, 0.34, 0.4), 40, M["lead"], (3.45, -1.15, 0))
    rp = pivot("rudder_pivot", (8.55, 0.3, 0))
    foil("rudder", 0.62, 0.38, 8.45, 8.6, 0.3, -1.0, 0.12, M["g10"], parent=rp)

    # Cabin trunk with a sloping front, dark windows and a hatch; a teak cockpit.
    y_deck = lambda x: f.deck_y(x, 0)
    cab = material("cabin", base=hexcol(0xF1F0EC), rough=0.3, coat=0.4)
    x0, x1, hw = 2.75, 6.05, 1.02
    verts = []
    for x in (x0, x0 + 0.55, x1):
        yb = y_deck(x) - 0.02
        yt = y_deck(x0 + 0.55) + 0.5 if x > x0 else yb + 0.18
        w = hw * (0.82 if x == x0 else 1.0)
        verts += [(x, yb, -w), (x, yt, -w * 0.94), (x, yt, w * 0.94), (x, yb, w)]
    faces = [
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (4, 5, 9, 8),
        (5, 6, 10, 9),
        (6, 7, 11, 10),
        (0, 3, 2, 1),
        (8, 9, 10, 11),
    ]
    mesh_object("cabin", verts, faces, mat=cab, smooth=False)
    yt = y_deck(x0 + 0.55) + 0.5
    for side in (1, -1):
        for k, (a, b) in enumerate(((3.55, 4.45), (4.6, 5.6))):
            rounded_box(
                f"window_{k}_{'p' if side > 0 else 's'}",
                a,
                b,
                yt - 0.3,
                yt - 0.14,
                side * hw - 0.012,
                side * hw + 0.012,
                M["glass"],
                0.01,
            )
    rounded_box("hatch", 3.55, 4.25, yt, yt + 0.06, -0.35, 0.35, M["glass"], 0.02)
    rounded_box("companionway", 5.85, 6.07, yt - 0.42, yt - 0.02, -0.33, 0.33, M["teak"], 0.01)
    cy = y_deck(7.4)
    rounded_box("cockpit_sole", 6.15, 8.75, cy + 0.005, cy + 0.03, -0.75, 0.75, M["teak"], 0.01)
    for side in (1, -1):
        rounded_box(
            f"coaming_{'p' if side > 0 else 's'}",
            6.05,
            8.6,
            cy,
            cy + 0.32,
            side * 0.98 - 0.04,
            side * 0.98 + 0.04,
            cab,
            0.02,
        )
        rounded_box(
            f"bench_{'p' if side > 0 else 's'}",
            6.3,
            8.4,
            cy,
            cy + 0.2,
            side * 0.78 - 0.17,
            side * 0.78 + 0.17,
            M["teak"],
            0.02,
        )
    # A tiller (common on a 31-footer).
    rod(
        "tiller",
        (8.55, y_deck(8.55) + 0.45, 0),
        (7.3, y_deck(7.3) + 0.55, 0),
        0.025,
        M["teak"],
        parent=rp,
    )
    rod("rudder_stock", (8.55, 0.3, 0), (8.55, y_deck(8.55) + 0.47, 0), 0.03, M["steel"], parent=rp)

    # Pulpit, pushpit, stanchions and lifelines.
    yb = y_deck(0.3)
    tube(
        "pulpit",
        [
            (0.9, yb + 0.02, 0.62),
            (0.45, yb + 0.68, 0.45),
            (0.2, yb + 0.7, 0.0),
            (0.45, yb + 0.68, -0.45),
            (0.9, yb + 0.02, -0.62),
        ],
        0.014,
        M["steel"],
    )
    ys = y_deck(L - 0.2)
    tube(
        "pushpit",
        [
            (8.7, ys + 0.02, 1.25),
            (9.25, ys + 0.66, 1.15),
            (9.3, ys + 0.66, 0.4),
            (9.3, ys + 0.66, -0.4),
            (9.25, ys + 0.66, -1.15),
            (8.7, ys + 0.02, -1.25),
        ],
        0.014,
        M["steel"],
    )
    stanchions(
        f, [1.9, 3.2, 4.5, 5.8, 7.1, 8.3], 0.62, 0.07, M["steel"], M["wire"], ends=(0.55, 9.25)
    )

    # Rig: deck-stepped mast, boom, spreaders, standing rigging.
    mx, mh = CRUISER["mast_x"], CRUISER["mast_h"]
    ym = y_deck(mx) + 0.48  # on the cabin top
    cylinder("mast", 0.085, mx, ym, ym + mh, 0, M["alu"], segs=24, r_top=0.055)
    cylinder("masthead_light", 0.04, mx, ym + mh, ym + mh + 0.08, 0, M["lamp"], segs=16)
    for side in (1, -1):
        rod(
            f"spreader_{'p' if side > 0 else 's'}",
            (mx, ym + 6.4, 0),
            (mx + 0.1, ym + 6.4, side * 1.05),
            0.022,
            M["alu"],
            segs=10,
        )
        chain = (mx + 0.15, y_deck(mx + 0.15), side * (hb((mx + 0.15) / L) - 0.08))
        rod(
            f"shroud_{'p' if side > 0 else 's'}",
            chain,
            (mx + 0.1, ym + 6.4, side * 1.05),
            0.005,
            M["wire"],
            segs=6,
        )
        rod(
            f"shroud_up_{'p' if side > 0 else 's'}",
            (mx + 0.1, ym + 6.4, side * 1.05),
            (mx, ym + mh - 0.1, 0),
            0.005,
            M["wire"],
            segs=6,
        )
    bow = (0.18, y_deck(0.18) + 0.05, 0)
    rod("forestay", bow, (mx, ym + mh - 0.05, 0), 0.006, M["wire"], segs=6)
    rod(
        "backstay",
        (mx, ym + mh - 0.05, 0),
        (L - 0.12, y_deck(L - 0.12) + 0.05, 0),
        0.005,
        M["wire"],
        segs=6,
    )
    gx = 7.35
    mp = pivot("main_pivot", (mx, ym, 0))
    rod("boom", (mx + 0.09, ym + 0.95, 0), (gx, ym + 0.95, 0), 0.055, M["alu"], segs=16, parent=mp)
    main_t, main_h, main_c = (
        (mx + 0.1, ym + 1.0, 0),
        (mx + 0.08, ym + mh - 0.35, 0),
        (gx - 0.08, ym + 1.0, 0),
    )
    sail("sail_main", main_t, main_h, main_c, 0.07, M["sail"], parent=mp)
    jp = pivot("jib_pivot", bow)
    jib_t = (0.3, y_deck(0.3) + 0.42, 0)
    jib_h = (mx - 0.25, ym + mh - 0.9, 0)
    jib_c = (4.95, y_deck(4.95) + 0.6, 0)
    sail("sail_jib", jib_t, jib_h, jib_c, 0.09, M["sail"], parent=jp)
    # Winches by the cockpit.
    for side in (1, -1):
        cylinder(
            f"winch_{'p' if side > 0 else 's'}",
            0.07,
            6.3,
            cy + 0.32,
            cy + 0.46,
            side * 0.98,
            M["steel"],
            segs=20,
            r_top=0.06,
        )
    # Navigation lights on the pulpit.
    red = material("red_light", base=hexcol(0xFF3030), rough=0.2, emit=(1.0, 0.1, 0.1))
    green = material("green_light", base=hexcol(0x30FF60), rough=0.2, emit=(0.1, 1.0, 0.3))
    rounded_box("light_port", 0.42, 0.5, yb + 0.6, yb + 0.66, 0.44, 0.5, red, 0.005)
    rounded_box("light_starboard", 0.42, 0.5, yb + 0.6, yb + 0.66, -0.5, -0.44, green, 0.005)
    return [(ob, img, rgb)]


# ----------------------------------------------------------------- dinghy ----
# 4.2 m by 1.2 m, a flat board boat 0.3 m deep; lateen rig on a short mast.
DINGHY = {"L": 4.2, "B": 0.6, "wl": 0.08, "mast_x": 1.05}
DINGHY_PAINT = HullPaint(
    top=0xF5F4EF, deck=0xF0EFEA, boot=0x2C6FB5, bottom=0xEDEBE6, lettering=None
)


def build_dinghy() -> list:
    L, B = DINGHY["L"], DINGHY["B"]
    M = mats()

    def hb(s: float) -> float:
        if s <= 0.5:
            return B * max(1 - (1 - s / 0.5) ** 2.2, 0) ** 0.55
        return B - (B - 0.46) * ((s - 0.5) / 0.5) ** 2

    def kz(s: float) -> float:
        return 0.12 * max(1 - s / 0.3, 0) ** 2

    def dz(s: float) -> float:
        return 0.3 + 0.04 * max(1 - s / 0.2, 0) ** 2

    f = HullForm(L=L, n=5.0, crown=0.025, wl=DINGHY["wl"], hb=hb, kz=kz, dz=dz)
    ob, img, rgb = hull(f, DINGHY_PAINT, rough=0.3, coat=0.5, nx=140, nt=20, nd=20)
    # The footwell: a shallow tub let into the deck (drawn as its rim and floor).
    y = f.deck_y(2.6, 0)
    rounded_box("footwell", 2.25, 2.95, y - 0.01, y + 0.012, -0.32, 0.32, M["teak"], 0.02)
    rounded_box("footwell_rim", 2.22, 2.98, y, y + 0.03, -0.35, -0.31, M["g10"], 0.01)
    rounded_box("footwell_rim2", 2.22, 2.98, y, y + 0.03, 0.31, 0.35, M["g10"], 0.01)
    # Daggerboard and a kick-up rudder with a tiller.
    foil("daggerboard", 0.3, 0.26, 1.48, 1.52, 0.2, -0.75, 0.1, M["g10"])
    rp = pivot("rudder_pivot", (L - 0.02, 0.2, 0))
    foil("rudder", 0.24, 0.18, L - 0.02, L + 0.02, 0.28, -0.42, 0.1, M["g10"], parent=rp)
    rod(
        "tiller", (L, f.dz(1.0) + 0.06, 0), (3.2, f.dz(0.76) + 0.12, 0), 0.016, M["teak"], parent=rp
    )
    # Lateen rig: a short mast, the sail laced between a long yard and a boom
    # that cross at the mast.
    mx = DINGHY["mast_x"]
    ym = f.deck_y(mx, 0)
    cylinder("mast", 0.035, mx, ym - 0.2, ym + 2.0, 0, M["alu"], segs=16, r_top=0.03)
    mp = pivot("main_pivot", (mx, ym, 0))
    tack = (0.55, ym + 0.42, 0.0)
    clew = (3.95, ym + 0.5, 0.0)
    peak = (2.35, ym + 4.5, 0.0)
    rod(
        "boom",
        (tack[0] - 0.05, tack[1] - 0.03, 0),
        (clew[0] + 0.05, clew[1] - 0.03, 0),
        0.025,
        M["alu"],
        parent=mp,
    )
    rod(
        "yard",
        (tack[0] - 0.08, tack[1] - 0.06, 0),
        (peak[0] + 0.05, peak[1] + 0.04, 0),
        0.025,
        M["alu"],
        parent=mp,
    )
    sail_mat = material("sail_dinghy", base=hexcol(0xF6F4EC), rough=0.75)
    sail("sail_main", tack, peak, clew, 0.06, sail_mat, parent=mp)
    # One coloured panel low on the sail (generic, no insignia).
    band = material("sail_band", base=hexcol(0x2C6FB5), rough=0.75)
    t2 = (tack[0] + 0.12, tack[1] + 0.12, 0.012)
    c2 = (clew[0] - 0.55, clew[1] + 0.12, 0.012)
    flat_quad(
        "sail_band",
        t2,
        c2,
        (c2[0] - 0.05, c2[1] + 0.32, 0.012),
        (t2[0] + 0.12, t2[1] + 0.34, 0.012),
        band,
        parent=mp,
    )
    return [(ob, img, rgb)]


# --------------------------------------------------------------- beach cat ----
# Two 4.9 m hulls 2.4 m apart (centre to centre 2.1 m), a trampoline between
# two aluminium beams, an 8.3 m mast on the front beam, a fully battened main
# with a short boom and a jib on a bridle; a rudder on each stern.
CAT = {"L": 4.9, "hb": 0.2, "half_gap": 1.05, "depth": 0.55, "wl": 0.16, "mast_h": 8.3}
CAT_PAINT = HullPaint(top=0xF4F4F0, deck=0xECEBE6, boot=0xD8432B, bottom=0xF0EFEA, lettering=None)


def build_beachcat() -> list:
    L, g = CAT["L"], CAT["half_gap"]
    M = mats()

    def hb(s: float) -> float:
        if s <= 0.42:
            return CAT["hb"] * max(1 - (1 - s / 0.42) ** 2, 0) ** 0.6
        return CAT["hb"] - (CAT["hb"] - 0.12) * ((s - 0.42) / 0.58) ** 2

    def kz(s: float) -> float:
        return (
            0.3 * max(1 - s / 0.3, 0) ** 2 + 0.08 * max((s - 0.8) / 0.2, 0) ** 2
        )  # a banana rocker

    def dz(s: float) -> float:
        return CAT["depth"] - 0.08 * s

    f = HullForm(L=L, n=2.0, crown=0.06, wl=CAT["wl"], hb=hb, kz=kz, dz=dz)
    port, img, rgb = hull(f, CAT_PAINT, rough=0.25, coat=0.55, nx=160, nt=26, nd=12)
    port.location = (0, -g, 0)  # Blender frame: builder +z (port) is Blender -y
    stbd = port.copy()
    stbd.name = "hull_starboard"
    bpy.context.collection.objects.link(stbd)
    stbd.location = (0, g, 0)
    port.name = "hull_port"

    # Beams and the trampoline between them.
    yd = f.dz(0.3) + 0.02
    for x in (1.45, 3.65):
        rod(f"beam_{x:.2f}", (x, yd, -g - 0.06), (x, yd, g + 0.06), 0.045, M["alu"])
    tramp = material("trampoline", base=hexcol(0x24282D), rough=0.85)
    flat_quad(
        "trampoline",
        (1.47, yd + 0.01, -g + 0.12),
        (1.47, yd + 0.01, g - 0.12),
        (3.63, yd + 0.01, g - 0.12),
        (3.63, yd + 0.01, -g + 0.12),
        tramp,
    )
    for side in (1, -1):
        rod(
            f"tramp_edge_{'p' if side > 0 else 's'}",
            (1.47, yd, side * (g - 0.12)),
            (3.63, yd, side * (g - 0.12)),
            0.02,
            M["alu"],
            segs=10,
        )
    # Mast on the front beam, a dolphin striker, stays to the bows.
    mh = CAT["mast_h"]
    cylinder("mast", 0.07, 1.45, yd, yd + mh, 0, M["alu"], segs=20, r_top=0.045)
    bow_s, bow_p = (0.25, f.dz(0.05) + 0.02, g), (0.25, f.dz(0.05) + 0.02, -g)
    hound = (1.45, yd + mh * 0.72, 0)
    bridle = (0.75, yd + 0.1, 0)
    rod("bridle_s", bow_s, bridle, 0.004, M["wire"], segs=6)
    rod("bridle_p", bow_p, bridle, 0.004, M["wire"], segs=6)
    rod("forestay", bridle, hound, 0.004, M["wire"], segs=6)
    for side in (1, -1):
        rod(
            f"shroud_{'p' if side > 0 else 's'}",
            (1.6, yd, side * g),
            hound,
            0.004,
            M["wire"],
            segs=6,
        )
    # Sails: a jib on the bridle, a fully battened square-top main with a short boom.
    jp = pivot("jib_pivot", bridle)
    sail(
        "sail_jib",
        (0.8, yd + 0.22, 0),
        (1.3, hound[1] - 0.12, 0),
        (2.25, yd + 0.42, 0),
        0.08,
        M["sail"],
        parent=jp,
    )
    mp = pivot("main_pivot", (1.45, yd, 0))
    rod("boom", (1.5, yd + 0.45, 0), (4.35, yd + 0.45, 0), 0.035, M["alu"], segs=12, parent=mp)
    m_t, m_h, m_c = (1.52, yd + 0.5, 0), (1.5, yd + mh - 0.08, 0), (4.3, yd + 0.5, 0)
    sail("sail_main", m_t, m_h, m_c, 0.065, M["sail"], parent=mp)
    battens("batten", m_t, m_h, m_c, 0.065, 7, M["black"], parent=mp)
    # Rudders on both sterns with a tiller bar across.
    for side, tag in ((1, "p"), (-1, "s")):  # builder +z is port
        rp = pivot(f"rudder_pivot_{tag}", (L - 0.03, 0.25, side * g))
        foil(f"rudder_{tag}", 0.26, 0.2, L - 0.03, L + 0.0, 0.32, -0.55, 0.1, M["g10"], parent=rp)
        rod(
            f"tiller_arm_{tag}",
            (L + 0.02, CAT["depth"] - 0.05, side * g),
            (L - 0.25, CAT["depth"] + 0.05, side * (g - 0.15)),
            0.015,
            M["alu"],
            parent=rp,
        )
    rod(
        "tiller_bar",
        (L - 0.25, CAT["depth"] + 0.05, g - 0.15),
        (L - 0.25, CAT["depth"] + 0.05, -g + 0.15),
        0.018,
        M["alu"],
    )
    return [(port, img, rgb)]


# ------------------------------------------------------------ ocean drone ----
# 7 m long, 0.9 m beam, about 2 m draft on a fin keel with a bulb; a 5 m wing
# about 1.1 m in chord stepped 2.6 m from the bow. Slate topsides, a yellow
# stripe to be seen by ships, a white wing with a yellow tip.
DRONE = {"L": 7.0, "B": 0.45, "wl": 0.34, "wing_x": 2.6, "wing_h": 5.0}
DRONE_PAINT = HullPaint(top=0x3A4756, deck=0xDADDE0, boot=0xF2B33D, bottom=0x262A2F, lettering=None)


def build_drone() -> list:
    L, B = DRONE["L"], DRONE["B"]
    M = mats()

    def hb(s: float) -> float:
        # A fine, knife-like bow, parallel sides, a narrow transom.
        if s <= 0.45:
            return B * max(1 - (1 - s / 0.45) ** 2, 0) ** 0.95
        return B - (B - 0.3) * ((s - 0.45) / 0.55) ** 2

    def kz(s: float) -> float:
        return 0.3 * max(1 - s / 0.25, 0) ** 2 + 0.12 * max((s - 0.85) / 0.15, 0) ** 2

    def dz(s: float) -> float:
        return 0.72 - 0.08 * s + 0.1 * max(1 - s / 0.12, 0) ** 2

    f = HullForm(L=L, n=2.6, crown=0.06, wl=DRONE["wl"], hb=hb, kz=kz, dz=dz)
    ob, img, rgb = hull(f, DRONE_PAINT, rough=0.3, coat=0.4, nx=180, nt=28, nd=18)
    yd = lambda x: f.deck_y(x, 0)

    # Deep fin keel with a long lead bulb (draft about 2 m), a spade rudder aft.
    foil("keel", 1.0, 0.7, 2.3, 2.55, 0.15, -1.45, 0.1, M["lead"], n_span=10)
    lathe("keel_bulb", bulb_profile(1.5, 0.3, 0.4), 40, M["lead"], (2.15, -1.55, 0))
    rp = pivot("rudder_pivot", (6.55, 0.2, 0))
    foil("rudder", 0.5, 0.36, 6.45, 6.55, 0.2, -0.9, 0.12, M["g10"], parent=rp)

    # Solar panels fore and aft of the wing, a hatch, a low deck fairing at the step.
    panel("panel_fwd", 0.9, 2.05, 0.62, lambda x, z: f.deck_y(x, z), 5, 2)
    panel("panel_aft", 3.25, 5.6, 0.56, lambda x, z: f.deck_y(x, z), 10, 2)
    rounded_box("hatch", 5.75, 6.2, yd(6.0) - 0.01, yd(6.0) + 0.05, -0.18, 0.18, M["g10"], 0.012)
    dark = material("fairing", base=hexcol(0x2B3036), rough=0.45)
    wx = DRONE["wing_x"]
    cylinder("wing_step", 0.2, wx, yd(wx) - 0.02, yd(wx) + 0.12, 0, dark, r_top=0.13)
    # Sensor mast at the stern: a light, an antenna dome and a little weather vane mount.
    sx = 6.25
    cylinder("sensor_mast", 0.03, sx, yd(sx), yd(sx) + 1.1, 0, M["alu"], segs=16)
    rod("sensor_arm", (sx - 0.18, yd(sx) + 0.95, 0), (sx + 0.18, yd(sx) + 0.95, 0), 0.015, M["alu"])
    dome = material("dome", base=hexcol(0xF2F2EE), rough=0.4)
    cylinder("antenna_dome", 0.09, sx, yd(sx) + 1.1, yd(sx) + 1.2, 0, dome, r_top=0.04)
    cylinder("masthead_light", 0.028, sx + 0.18, yd(sx) + 0.95, yd(sx) + 1.02, 0, M["lamp"])
    # Bow: a small sensor pod on the stem.
    lathe("bow_pod", bulb_profile(0.4, 0.12, 0.35), 20, dark, (0.3, yd(0.5) + 0.04, 0))

    # The wing: one rigid foil turning freely on a mast. Two booms reach aft
    # from it to a small tail flap that sets its angle to the wind, and a
    # counterweight forward balances it. All of it turns about wing_pivot.
    wp = pivot("wing_pivot", (wx, 0, 0))
    wing_mat = material("wing", base=hexcol(0xF5F5F1), rough=0.4, coat=0.3)
    tip_mat = material("wing_tip", base=hexcol(0xF2B33D), rough=0.45)
    y0 = yd(wx) + 0.25
    y1 = y0 + DRONE["wing_h"]
    foil(
        "wing", 1.15, 0.85, wx - 0.3, wx - 0.2, y0, y1 - 0.35, 0.14, wing_mat, n_span=12, parent=wp
    )
    foil(
        "wing_tip",
        0.85,
        0.7,
        wx - 0.2,
        wx - 0.17,
        y1 - 0.35,
        y1,
        0.14,
        tip_mat,
        n_span=3,
        parent=wp,
    )
    cylinder("wing_mast", 0.05, wx, yd(wx) - 0.05, y0 + 0.1, 0, dark, segs=20, parent=wp)
    by = y0 + 0.55
    tx = wx + 2.6  # tail flap hinge
    for z in (0.09, -0.09):
        rod(
            f"tail_boom_{'p' if z > 0 else 's'}",
            (wx + 0.75, by, z),
            (tx, by, z * 0.4),
            0.022,
            M["alu"],
            parent=wp,
        )
    foil(
        "tail_flap",
        0.42,
        0.34,
        tx - 0.04,
        tx - 0.02,
        by - 0.55,
        by + 0.75,
        0.12,
        wing_mat,
        n_span=3,
        parent=wp,
    )
    rod(
        "counter_arm",
        (wx - 0.25, by - 0.25, 0),
        (wx - 0.95, by - 0.25, 0),
        0.025,
        M["alu"],
        parent=wp,
    )
    lathe(
        "counterweight",
        bulb_profile(0.36, 0.12, 0.45),
        24,
        M["lead"],
        (wx - 1.15, by - 0.25, 0),
        parent=wp,
    )
    return [(ob, img, rgb)]


# ----------------------------------------------------------------- rower ----
# An 8.64 m ocean rowing boat for four (configs/stock_ocean_rower45.yaml; Theo's
# stats card, from the published specs of a Rannoch R45; our own generic model,
# no maker's look). Cabins at both ends, an open rowing deck between them with
# two rowing stations, a daggerboard, and a transom rudder. x is metres aft of the
# bow tip; layout GUESSES as on the card.
ROWER = {"L": 8.64, "B": 0.87, "wl": 0.35}
ROWER_PAINT = HullPaint(top=0xF4F4F1, deck=0x8E949A, boot=0x2F6FA8, bottom=0xE4E6E6, lettering=None)
#: Rowing stations: (seat travel from, to, oar gate x, footplate x). Rowers face aft.
ROWER_STATIONS = ((2.45, 3.25, 3.3, 3.55), (3.75, 4.55, 4.6, 4.85))


def cabin(name, f: HullForm, rings, inset, mat, sq=3.0):
    """A cabin top lofted along the hull: rings of (x, height above the deck, width
    fraction of the deck at x). Superelliptic sections (flat-ish sides, a rounded
    roof); flat bulkheads close both ends. Returns the roof height function."""
    nz = 24
    verts, faces = [], []

    def sec(x, h, wf):
        w = max((f.hb(x / f.L) - inset) * wf, 0.02)
        pts = []
        for k in range(nz + 1):
            a = math.pi * k / nz  # from starboard deck edge over the top to port
            cz, sy = math.cos(a), math.sin(a)
            z = w * math.copysign(abs(cz) ** (2 / sq), cz)
            y = h * abs(sy) ** (2 / sq)
            pts.append((x, f.deck_y(x, z) - 0.02 + y, z))
        return pts

    n = len(rings)
    for x, h, wf in rings:
        verts += sec(x, h, wf)
    m = nz + 1
    for i in range(n - 1):
        for k in range(nz):
            a = i * m + k
            faces.append((a, a + 1, a + m + 1, a + m))
    for i in (0, n - 1):  # bulkheads
        faces.append(tuple(i * m + k for k in range(m)))
    mesh_object(name, verts, faces, mat=mat)
    xs = [r[0] for r in rings]

    def top(x, z):
        x = min(max(x, xs[0]), xs[-1])
        h = float(np.interp(x, xs, [r[1] for r in rings]))
        wf = float(np.interp(x, xs, [r[2] for r in rings]))
        w = max((f.hb(x / f.L) - inset) * wf, 0.02)
        u = min(abs(z) / w, 1)
        return f.deck_y(x, z) - 0.02 + h * (1 - u**sq) ** (1 / sq)

    return top


def oar(name, gate, length, inboard, out_dir, mat_shaft, mat_blade, parent):
    """An oar resting in its gate: shaft from the handle through the gate, blade at
    the end. out_dir: unit vector from the gate towards the blade."""
    g = np.array(gate, float)
    d = np.array(out_dir, float)
    d /= np.linalg.norm(d)
    handle = g - d * inboard
    tip = g + d * (length - inboard)
    neck = tip - d * 0.5
    rod(f"{name}_shaft", tuple(handle), tuple(neck), 0.02, mat_shaft, segs=10, parent=parent)
    rod(
        f"{name}_grip",
        tuple(handle),
        tuple(handle + d * 0.3),
        0.026,
        M_BLACK(),
        segs=10,
        parent=parent,
    )
    # Blade: a flat spoon, wider at the tip, standing on edge.
    up = np.array([0.0, 1.0, 0.0])
    side = np.cross(d, up)
    side /= np.linalg.norm(side)
    verts = []
    for t, w in ((0.0, 0.03), (0.15, 0.08), (0.5, 0.11), (1.0, 0.1)):
        c = neck + d * (0.5 * t)
        for sy in (-1, 1):
            for sz in (-1, 1):
                verts.append(tuple(c + up * (w * sy) + side * (0.007 * sz)))
    faces = []
    for i in range(3):
        a = i * 4
        b = a + 4
        faces += [
            (a, a + 1, b + 1, b),
            (a + 2, b + 2, b + 3, a + 3),
            (a, b, b + 2, a + 2),
            (a + 1, a + 3, b + 3, b + 1),
        ]
    faces += [(0, 2, 3, 1), (12, 13, 15, 14)]
    mesh_object(f"{name}_blade", verts, faces, mat=mat_blade, smooth=False, parent=parent)


_black = None


def M_BLACK():
    global _black
    if _black is None:
        _black = material("grip", base=hexcol(0x1E2124), rough=0.6)
    return _black


def build_rower() -> list:
    L, B = ROWER["L"], ROWER["B"]
    M = mats()

    def hb(s: float) -> float:
        # A fine bow, long straight sides, a broad transom.
        if s <= 0.33:
            return B * max(1 - (1 - s / 0.33) ** 2, 0) ** 0.75
        if s <= 0.78:
            return B
        return B - (B - 0.62) * ((s - 0.78) / 0.22) ** 1.6

    def kz(s: float) -> float:
        return 0.24 * max(1 - s / 0.2, 0) ** 2 + 0.06 * max((s - 0.9) / 0.1, 0) ** 2

    def dz(s: float) -> float:
        return 0.7 + 0.14 * max(1 - s / 0.22, 0) ** 2 + 0.04 * max((s - 0.88) / 0.12, 0)

    f = HullForm(L=L, n=3.2, crown=0.03, wl=ROWER["wl"], hb=hb, kz=kz, dz=dz)
    ob, img, rgb = hull(f, ROWER_PAINT, rough=0.3, coat=0.5, nx=180, nt=28, nd=18)
    yd = lambda x: f.deck_y(x, 0)
    gel = material("gelcoat", base=hexcol(0xF6F6F3), rough=0.28, coat=0.5)
    dark = material("trim", base=hexcol(0x2B3036), rough=0.5)
    seat_m = material("seat", base=hexcol(0x30353B), rough=0.55)

    # Bow cabin: low, for one or two. Stern cabin: the main one, taller.
    bow_top = cabin(
        "bow_cabin",
        f,
        [
            (0.35, 0.1, 0.55),
            (0.7, 0.42, 0.8),
            (1.2, 0.7, 0.92),
            (2.2, 0.75, 0.94),
            (2.3, 0.72, 0.93),
        ],
        0.07,
        gel,
    )
    stern_top = cabin(
        "stern_cabin",
        f,
        [
            (5.0, 0.95, 0.93),
            (5.12, 1.0, 0.94),
            (7.3, 1.0, 0.94),
            (7.9, 0.82, 0.92),
            (8.25, 0.55, 0.88),
        ],
        0.07,
        gel,
    )
    # Hatches onto the rowing deck, and small side windows.
    rounded_box("bow_hatch", 2.29, 2.33, yd(2.3) + 0.12, yd(2.3) + 0.6, -0.26, 0.26, dark, 0.02)
    rounded_box("stern_hatch", 4.97, 5.01, yd(5.0) + 0.14, yd(5.0) + 0.8, -0.28, 0.28, dark, 0.02)
    for side in (1, -1):
        for x0, x1, y in ((5.5, 6.1, 0.55), (6.4, 7.0, 0.55)):
            z = side * ((B - 0.07) * 0.94 - 0.01)
            rounded_box(
                f"window_{x0:.1f}_{'p' if side > 0 else 's'}",
                x0,
                x1,
                yd(x0) + y,
                yd(x0) + y + 0.16,
                z - 0.012,
                z + 0.012,
                M["glass"],
                0.01,
            )
    # Solar panels on both cabin roofs (the bow one is in the listings).
    panel("panel_bow", 0.95, 2.1, 0.62, bow_top, 4, 2)
    panel("panel_stern", 5.35, 7.35, 0.95, stern_top, 7, 3)

    # The rowing deck: two stations, each a sliding seat on rails, a footplate
    # (the stroke seat's steers the rudder) and outriggers carrying the oar gates.
    for n, (s0, s1, gx, fx) in enumerate(ROWER_STATIONS, 1):
        y = yd((s0 + s1) / 2)
        for z in (0.13, -0.13):
            rod(
                f"rail_{n}_{'p' if z > 0 else 's'}",
                (s0 - 0.05, y + 0.13, z),
                (s1 + 0.25, y + 0.13, z),
                0.012,
                M["alu"],
                segs=8,
            )
            rod(
                f"rail_leg_{n}_{'p' if z > 0 else 's'}_a",
                (s0 - 0.03, y, z),
                (s0 - 0.03, y + 0.13, z),
                0.01,
                M["alu"],
                segs=8,
            )
            rod(
                f"rail_leg_{n}_{'p' if z > 0 else 's'}_b",
                (s1 + 0.23, y, z),
                (s1 + 0.23, y + 0.13, z),
                0.01,
                M["alu"],
                segs=8,
            )
        sp = pivot(f"seat_{n}", (s0 + 0.2, y + 0.15, 0))
        rounded_box(
            f"seat_{n}_pad",
            s0 + 0.03,
            s0 + 0.37,
            y + 0.15,
            y + 0.2,
            -0.17,
            0.17,
            seat_m,
            0.02,
            parent=sp,
        )
        # Footplate, raked back towards the rower.
        verts = [
            (fx, y + 0.05, -0.17),
            (fx, y + 0.05, 0.17),
            (fx - 0.12, y + 0.38, 0.17),
            (fx - 0.12, y + 0.38, -0.17),
        ]
        mesh_object(f"footplate_{n}", verts, [(0, 1, 2, 3)], mat=dark, smooth=False)
        for side in (1, -1):
            zg = side * 1.0
            zb = side * (B - 0.02)
            yg = y + 0.3
            rod(
                f"rigger_{n}_{'p' if side > 0 else 's'}_a",
                (gx - 0.35, yd(gx) + 0.02, zb),
                (gx, yg, zg),
                0.016,
                M["alu"],
                segs=10,
            )
            rod(
                f"rigger_{n}_{'p' if side > 0 else 's'}_b",
                (gx + 0.3, yd(gx) + 0.02, zb),
                (gx, yg, zg),
                0.016,
                M["alu"],
                segs=10,
            )
            cylinder(
                f"gate_{n}_{'p' if side > 0 else 's'}",
                0.03,
                gx,
                yg - 0.02,
                yg + 0.1,
                zg,
                dark,
                segs=12,
            )
            # Oars at rest: square across the boat, blades just clear of the water.
            op = pivot(f"oar_{n}_{'p' if side > 0 else 's'}", (gx, yg + 0.05, zg))
            out = np.array([0.0, -0.18, side * 1.0])
            oar(
                f"oar_{n}_{'p' if side > 0 else 's'}",
                (gx, yg + 0.05, zg),
                3.15,
                0.92,
                out,
                M["alu"],
                gel,
                op,
            )
    # Flush deck lockers (food and water ballast), the daggerboard case and the board.
    for k, x in enumerate((2.62, 3.95, 4.3)):
        cylinder(
            f"locker_{k}",
            0.16,
            x,
            yd(x) - 0.01,
            yd(x) + 0.015,
            0.0 if k != 1 else 0.3,
            dark,
            segs=24,
        )
    rounded_box("board_case", 3.95, 4.35, yd(4.1) - 0.01, yd(4.1) + 0.18, -0.03, 0.03, gel, 0.01)
    foil("daggerboard", 0.32, 0.28, 3.98, 4.0, -0.55, 0.05, 0.1, M["g10"], n_span=4)

    # Stern: a transom-hung rudder with a tiller autopilot, a grab handle, a light pole.
    rp = pivot("rudder_pivot", (L - 0.02, 0.3, 0))
    foil("rudder", 0.36, 0.3, L - 0.05, L - 0.02, -0.25, 0.42, 0.1, M["g10"], n_span=6, parent=rp)
    rod("tiller", (L - 0.02, 0.46, 0), (L - 0.4, 0.56, 0), 0.016, M["alu"], segs=10, parent=rp)
    rounded_box("autopilot", 8.05, 8.25, yd(8.1) + 0.4, yd(8.1) + 0.5, 0.1, 0.22, dark, 0.01)
    tube(
        "grab_handle",
        [
            (L - 0.01, 0.62, -0.25),
            (L + 0.1, 0.66, -0.2),
            (L + 0.12, 0.68, 0.0),
            (L + 0.1, 0.66, 0.2),
            (L - 0.01, 0.62, 0.25),
        ],
        0.014,
        M["steel"],
    )
    px = 7.7
    pole_y = stern_top(px, 0.25)
    cylinder("light_pole", 0.02, px, pole_y - 0.02, pole_y + 0.9, 0.25, M["alu"], segs=12)
    cylinder("masthead_light", 0.03, px, pole_y + 0.9, pole_y + 0.98, 0.25, M["lamp"])
    cylinder("ais_antenna", 0.012, px, pole_y - 0.02, pole_y + 0.7, -0.25, M["black"], segs=8)
    # Low guard rails of webbing along the rowing deck, and a jackstay down the middle.
    stanchions(
        f,
        [2.4, 3.0, 3.65, 4.3, 4.9],
        0.32,
        0.04,
        M["steel"],
        material("webbing", base=hexcol(0x3A3F45), rough=0.8),
    )
    tube(
        "jackstay", [(2.35, yd(2.35) + 0.03, 0.42), (4.95, yd(4.95) + 0.03, 0.42)], 0.006, M["wire"]
    )
    return [(ob, img, rgb)]


# ---------------------------------------------------------------- pearson ----
# Our model of Randolph's own boat, a Pearson 31-2 with the deep keel (Bill Shaw
# design, built 1987-91). Builder's numbers (pearsonyachts.org/models/pearson-31-2,
# cross-checked with goodoldboat.com/saildata/boat/pearson-312): LOA 30.8 ft
# (9.39 m), LWL 25.4 ft (7.74 m), beam 10.8 ft (3.29 m), draft 5.6 ft (1.71 m),
# masthead sloop, I 42.5 ft (12.95 m), J 12.8 ft (3.90 m), P 36.8 ft (11.22 m),
# E 12.0 ft (3.66 m), mast 46.3 ft (14.11 m) above the waterline, elliptical fin
# keel, spade rudder, "T" cockpit with a wheel. Not the builder's drawings: the
# hull lines between those numbers, the cabin, deck gear and colours are GUESSES
# (white hull, a navy cove stripe) until Randolph's team says otherwise.
PEARSON = {"L": 9.39, "B": 1.645, "wl": 0.55, "draft": 1.71, "mast_above_wl": 14.11}
PEARSON["mast_x"] = 0.16 + 3.90  # J back from the stem head
PEARSON_PAINT = HullPaint(
    top=0xF3F0E6, deck=0xE9E5DA, boot=0x1A2A4A, bottom=0x2B3A55, lettering=None
)
# A 1970s hull, kept up: gelcoat a touch ivory and a little softer in its
# reflections than a new boat's (never dirty).
PEARSON_FINISH = HullFinish(top_rough=0.2, top_coat=0.85, deck_rough=0.5)


def pearson_hb(s: float) -> float:
    """Half-beam (m): fullest just aft of the middle, a broad transom."""
    B = PEARSON["B"]
    if s <= 0.55:
        return B * max(1 - (1 - s / 0.55) ** 2, 0) ** 0.6
    return B - (B - 1.22) * ((s - 0.55) / 0.45) ** 2


def pearson_kz(s: float) -> float:
    """Hull bottom above its lowest point (m): a raked bow overhang (the forefoot
    meets the water about 0.85 m aft of the stem) and a short counter aft."""
    return 1.3 * max(1 - s / 0.25, 0) ** 2 + 0.75 * max((s - 0.68) / 0.32, 0) ** 1.6


def pearson_dz(s: float) -> float:
    """Sheer (deck edge) above the hull bottom (m): springy, high at the bow."""
    return 1.62 - 0.3 * s + 0.14 * max(1 - s / 0.18, 0) ** 2


def build_pearson() -> list:
    L, wl = PEARSON["L"], PEARSON["wl"]
    M = mats()
    hb = pearson_hb
    f = HullForm(L=L, n=2.1, crown=0.06, wl=wl, hb=hb, kz=pearson_kz, dz=pearson_dz)
    ob, img, rgb = hull(
        f, PEARSON_PAINT, rough=0.22, coat=0.6, nx=200, nt=34, nd=20, finish=PEARSON_FINISH
    )
    y_deck = lambda x: f.deck_y(x, 0)
    navy = material("cove_stripe", base=hexcol(0x1A2A4A), rough=0.2, coat=0.8)
    rub = material("rubrail", base=hexcol(0xD9D6CC), rough=0.45)
    for side, tag in ((1, "p"), (-1, "s")):
        # A teak toerail on the sheer, and the classic navy cove stripe just below it.
        tube(
            f"toerail_{tag}",
            [
                (x, f.dz(x / L) + 0.02, side * (hb(x / L) - 0.012))
                for x in np.linspace(0.2, L - 0.04, 40)
            ],
            0.02,
            M["teak"],
        )
        tube(
            f"cove_{tag}",
            [
                (x, f.dz(x / L) - 0.12, side * (hb(x / L) + 0.004))
                for x in np.linspace(0.45, L - 0.3, 40)
            ],
            0.012,
            navy,
        )
        tube(
            f"rubrail_{tag}",
            [
                (x, f.dz(x / L) - 0.03, side * (hb(x / L) + 0.006))
                for x in np.linspace(0.3, L - 0.08, 40)
            ],
            0.016,
            rub,
        )

    # The deep elliptical fin keel (no bulb; 3,800 lb of lead) and a spade rudder.
    # Keel and rudder in the hull's bottom paint, as on a boat kept in the water.
    antifoul = material("antifoul", base=hexcol(PEARSON_PAINT.bottom), rough=0.86)
    tip = wl - PEARSON["draft"]
    foil("keel", 1.65, 0.85, 3.55, 4.05, 0.2, tip + 0.06, 0.12, antifoul, n_span=12)
    lathe(
        "keel_tip",
        [(0.0, 0.0), (0.12, 0.05), (0.6, 0.065), (0.84, 0.03), (0.86, 0.0)],
        24,
        antifoul,
        (4.05, tip + 0.06, 0),
    )
    rp = pivot("rudder_pivot", (8.2, 0.42, 0))
    foil("rudder", 0.62, 0.36, 8.08, 8.24, 0.42, wl - 1.5, 0.12, antifoul, parent=rp)
    rod("rudder_stock", (8.2, 0.42, 0), (8.2, y_deck(8.2) + 0.05, 0), 0.03, M["steel"], parent=rp)

    # Cabin trunk: a long, low house with a raked front and long portlights.
    cab = material("cabin", base=hexcol(0xF2F1EC), rough=0.3, coat=0.4)
    x0, x1, hw = 2.55, 6.2, 1.08
    rise = 0.46
    verts = []
    for x in (x0, x0 + 0.7, x1):
        yb = y_deck(x) - 0.02
        yt = y_deck(x0 + 0.7) + rise if x > x0 else yb + 0.16
        w = hw * (0.8 if x == x0 else 1.0)
        verts += [(x, yb, -w), (x, yt, -w * 0.93), (x, yt, w * 0.93), (x, yb, w)]
    faces = [
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (4, 5, 9, 8),
        (5, 6, 10, 9),
        (6, 7, 11, 10),
        (0, 3, 2, 1),
        (8, 9, 10, 11),
    ]
    mesh_object("cabin", verts, faces, mat=cab, smooth=False)
    yt = y_deck(x0 + 0.7) + rise
    for side in (1, -1):
        tag = "p" if side > 0 else "s"
        rounded_box(
            f"portlight_{tag}",
            3.45,
            5.75,
            yt - 0.27,
            yt - 0.15,
            side * hw - 0.013,
            side * hw + 0.013,
            M["glass"],
            0.03,
        )
        tube(
            f"handrail_{tag}",
            [
                (3.4, yt + 0.02, side * 0.62),
                (3.5, yt + 0.08, side * 0.62),
                (5.6, yt + 0.08, side * 0.62),
                (5.7, yt + 0.02, side * 0.62),
            ],
            0.014,
            M["teak"],
        )
    rounded_box("hatch", 3.0, 3.6, yt, yt + 0.07, -0.33, 0.33, M["glass"], 0.02)
    rounded_box("companionway", 6.0, 6.22, yt - 0.42, yt - 0.02, -0.34, 0.34, M["teak"], 0.01)

    # The "T" cockpit: wide at the wheel, seats either side, teak sole.
    cy = y_deck(7.4)
    rounded_box("cockpit_sole", 6.25, 8.85, cy - 0.38, cy - 0.35, -0.55, 0.55, M["teak"], 0.01)
    rounded_box("cockpit_sole_aft", 7.6, 8.85, cy - 0.38, cy - 0.35, -0.95, 0.95, M["teak"], 0.01)
    for side in (1, -1):
        tag = "p" if side > 0 else "s"
        rounded_box(
            f"coaming_{tag}",
            6.2,
            7.6,
            cy,
            cy + 0.3,
            side * 1.05 - 0.04,
            side * 1.05 + 0.04,
            cab,
            0.02,
        )
        rounded_box(
            f"seat_{tag}",
            6.3,
            7.55,
            cy - 0.02,
            cy + 0.02,
            side * 0.82 - 0.24,
            side * 0.82 + 0.24,
            M["teak"],
            0.01,
        )
        # Primary winches on the coamings.
        cylinder(
            f"winch_{tag}",
            0.075,
            6.6,
            cy + 0.3,
            cy + 0.46,
            side * 1.05,
            M["steel"],
            segs=20,
            r_top=0.065,
        )
    # Wheel on a pedestal, binnacle compass on top.
    wx, wy = 7.95, cy + 0.45
    cylinder("pedestal", 0.08, wx - 0.25, cy - 0.35, wy, 0, M["steel"], segs=16, r_top=0.07)
    cylinder("binnacle", 0.11, wx - 0.25, wy, wy + 0.12, 0, M["black"], segs=20)
    R = 0.5
    ring = [(wx, wy + R * math.cos(a), R * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 41)]
    tube("wheel", ring, 0.016, M["steel"], segs=8)
    for k in range(6):
        a = k * math.pi / 3
        rod(
            f"wheel_spoke_{k}",
            (wx, wy, 0),
            (wx, wy + R * math.cos(a), R * math.sin(a)),
            0.009,
            M["steel"],
            segs=6,
        )

    # Pulpit, pushpit, stanchions and lifelines.
    yb = y_deck(0.35)
    tube(
        "pulpit",
        [
            (1.0, yb + 0.02, 0.62),
            (0.5, yb + 0.68, 0.42),
            (0.25, yb + 0.7, 0.0),
            (0.5, yb + 0.68, -0.42),
            (1.0, yb + 0.02, -0.62),
        ],
        0.014,
        M["steel"],
    )
    ys = y_deck(L - 0.2)
    tube(
        "pushpit",
        [
            (8.6, ys + 0.02, 1.2),
            (9.15, ys + 0.66, 1.1),
            (9.22, ys + 0.66, 0.35),
            (9.22, ys + 0.66, -0.35),
            (9.15, ys + 0.66, -1.1),
            (8.6, ys + 0.02, -1.2),
        ],
        0.014,
        M["steel"],
    )
    stanchions(
        f, [2.0, 3.3, 4.6, 5.9, 7.2, 8.3], 0.62, 0.07, M["steel"], M["wire"], ends=(0.6, 9.15)
    )

    # Masthead rig: deck-stepped mast on the cabin top, two-spreader, boom.
    mx = PEARSON["mast_x"]
    ym = y_deck(mx) + 0.44
    mh = wl + PEARSON["mast_above_wl"] - ym
    cylinder("mast", 0.09, mx, ym, ym + mh, 0, M["alu"], segs=24, r_top=0.06)
    cylinder("masthead_light", 0.04, mx, ym + mh, ym + mh + 0.08, 0, M["lamp"], segs=16)
    for side in (1, -1):
        tag = "p" if side > 0 else "s"
        for k, (h, w) in enumerate(((4.6, 1.0), (8.9, 0.72))):
            rod(
                f"spreader{k}_{tag}",
                (mx, ym + h, 0),
                (mx + 0.08, ym + h, side * w),
                0.02,
                M["alu"],
                segs=10,
            )
        chain = (mx + 0.1, y_deck(mx + 0.1), side * (hb((mx + 0.1) / L) - 0.08))
        rod(f"shroud_{tag}", chain, (mx + 0.08, ym + 4.6, side * 1.0), 0.005, M["wire"], segs=6)
        rod(
            f"shroud_mid_{tag}",
            (mx + 0.08, ym + 4.6, side * 1.0),
            (mx + 0.08, ym + 8.9, side * 0.72),
            0.005,
            M["wire"],
            segs=6,
        )
        rod(
            f"shroud_up_{tag}",
            (mx + 0.08, ym + 8.9, side * 0.72),
            (mx, ym + mh - 0.1, 0),
            0.005,
            M["wire"],
            segs=6,
        )
    bow = (0.16, y_deck(0.16) + 0.05, 0)
    rod("forestay", bow, (mx, ym + mh - 0.05, 0), 0.006, M["wire"], segs=6)
    rod(
        "backstay",
        (mx, ym + mh - 0.05, 0),
        (L - 0.1, y_deck(L - 0.1) + 0.05, 0),
        0.005,
        M["wire"],
        segs=6,
    )
    gx = mx + 3.66  # E
    boom_y = ym + 1.15
    mp = pivot("main_pivot", (mx, ym, 0))
    rod("boom", (mx + 0.09, boom_y, 0), (gx, boom_y, 0), 0.055, M["alu"], segs=16, parent=mp)
    sail(
        "sail_main",
        (mx + 0.1, boom_y + 0.05, 0),
        (mx + 0.08, boom_y + 11.22, 0),
        (gx - 0.08, boom_y + 0.05, 0),
        0.07,
        M["sail"],
        parent=mp,
    )
    jp = pivot("jib_pivot", bow)
    # A 135% genoa: its clew about 1.35 J aft of the stem, overlapping the mast.
    sail(
        "sail_jib",
        (0.3, y_deck(0.3) + 0.4, 0),
        (mx - 0.25, ym + mh - 0.9, 0),
        (0.16 + 1.35 * 3.90, y_deck(5.4) + 0.55, 0),
        0.09,
        M["sail"],
        parent=jp,
    )

    red = material("red_light", base=hexcol(0xFF3030), rough=0.2, emit=(1.0, 0.1, 0.1))
    green = material("green_light", base=hexcol(0x30FF60), rough=0.2, emit=(0.1, 1.0, 0.3))
    rounded_box("light_port", 0.48, 0.56, yb + 0.6, yb + 0.66, 0.42, 0.48, red, 0.005)
    rounded_box("light_starboard", 0.48, 0.56, yb + 0.6, yb + 0.66, -0.48, -0.42, green, 0.005)
    return [(ob, img, rgb)]


BUILD = {
    "cruiser": build_cruiser,
    "dinghy": build_dinghy,
    "beachcat": build_beachcat,
    "drone": build_drone,
    "rower": build_rower,
    "pearson": build_pearson,
}


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    if len(args) != 2 or args[0] not in BUILD:
        sys.exit(f"usage: build_stock.py {{{'|'.join(BUILD)}}} out.glb")
    reset()
    bake = BUILD[args[0]]()
    bake_ao(bake)
    export(Path(args[1]))


main()
