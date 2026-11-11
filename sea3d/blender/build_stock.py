"""Build the stock sailing boats as detailed 3D models (glTF .glb).

    python sea3d/blender/build_stock.py cruiser sea3d/public/models/stock_cruiser.glb
    python sea3d/blender/build_stock.py dinghy  sea3d/public/models/stock_dinghy.glb
    python sea3d/blender/build_stock.py beachcat sea3d/public/models/stock_beachcat.glb

(one boat per run: export() ends the process). Same frame and helpers as
build_kayak.py: x aft from the bow, y up from the bottom of the hull (the
canoe body; keels and boards hang below 0), z to starboard, metres.

Generic boats of three common kinds, with no maker's names, logos or sail
insignia (Maya, 11 Nov):
- cruiser: a 31 ft (9.45 m) masthead-sloop cruising yacht, fin keel and spade
  rudder, cabin trunk, cockpit, lifelines;
- dinghy: a 13 ft 9 in (4.2 m) lateen-rigged board boat, the kind people learn
  on: a flat deck, a little footwell, a daggerboard and a kick-up rudder;
- beachcat: a 16 ft (4.9 m) beach catamaran, two hulls, a trampoline, a tall
  rotating mast with a fully battened main and a jib, a rudder on each hull.

Sails sit under empties the page can find by name and turn with the sheet:
"main_pivot" (on the mast) and "jib_pivot" (on the forestay), so trimming
them later is a rotation, not a rebuild. Rudders and tillers sit under
"rudder_pivot" (one per hull on the cat: "rudder_pivot_s" / "rudder_pivot_p").
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
        nrm = -nrm  # belly to starboard (the page turns the pivot for the other tack)
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
    for i in range(n):
        for j in range(m):
            k = i * (m + 1) + j
            faces.append((k, k + 1, k + m + 2, k + m + 1))
    return mesh_object(name, verts, faces, mat=mat, parent=parent)


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
            rod(f"stanchion_{x:.2f}_{'s' if side > 0 else 'p'}", (x, y0, z), (x, y0 + height, z), 0.012, mat_post, segs=10)
            top.append((x, y0 + height, z))
            mid.append((x, y0 + height * 0.5, z))
        if ends:
            for pts in (top, mid):
                pts.insert(0, (ends[0], pts[0][1], pts[0][2] * 0.85))
                pts.append((ends[1], pts[-1][1], pts[-1][2]))
        tube(f"lifeline_top_{'s' if side > 0 else 'p'}", top, 0.003, mat_wire, segs=8)
        tube(f"lifeline_mid_{'s' if side > 0 else 'p'}", mid, 0.003, mat_wire, segs=8)


def mats():
    return {
        "steel": material("steel", base=hexcol(0xCDD2D7), rough=0.25, metal=0.9),
        "alu": material("alu", base=hexcol(0xB9BEC4), rough=0.35, metal=0.8),
        "wire": material("wire", base=hexcol(0x9AA0A6), rough=0.3, metal=0.9),
        "black": material("black", base=hexcol(0x1E2124), rough=0.5),
        "sail": material("sail", base=hexcol(0xF3F1EA), rough=0.75),
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
CRUISER_PAINT = HullPaint(top=0xF4F3EF, deck=0xE8E5DC, boot=0x1D2F4D, bottom=0x23344F, lettering=None)


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
    ob, img, rgb = hull(f, CRUISER_PAINT, rough=0.22, coat=0.6, nx=200, nt=34, nd=20)
    rub = material("rubrail", base=hexcol(0x2A2E33), rough=0.5)
    tube("toerail_s", [(x, f.dz(x / L) + 0.015, hb(x / L) - 0.01) for x in np.linspace(0.15, L - 0.02, 40)], 0.018, rub)
    tube("toerail_p", [(x, f.dz(x / L) + 0.015, -hb(x / L) + 0.01) for x in np.linspace(0.15, L - 0.02, 40)], 0.018, rub)

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
    faces = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (4, 5, 9, 8), (5, 6, 10, 9), (6, 7, 11, 10), (0, 3, 2, 1), (8, 9, 10, 11)]
    mesh_object("cabin", verts, faces, mat=cab, smooth=False)
    yt = y_deck(x0 + 0.55) + 0.5
    for side in (1, -1):
        for k, (a, b) in enumerate(((3.55, 4.45), (4.6, 5.6))):
            rounded_box(f"window_{k}_{'s' if side > 0 else 'p'}", a, b, yt - 0.3, yt - 0.14, side * hw - 0.012, side * hw + 0.012, M["glass"], 0.01)
    rounded_box("hatch", 3.55, 4.25, yt, yt + 0.06, -0.35, 0.35, M["glass"], 0.02)
    rounded_box("companionway", 5.85, 6.07, yt - 0.42, yt - 0.02, -0.33, 0.33, M["teak"], 0.01)
    cy = y_deck(7.4)
    rounded_box("cockpit_sole", 6.15, 8.75, cy + 0.005, cy + 0.03, -0.75, 0.75, M["teak"], 0.01)
    for side in (1, -1):
        rounded_box(f"coaming_{'s' if side > 0 else 'p'}", 6.05, 8.6, cy, cy + 0.32, side * 0.98 - 0.04, side * 0.98 + 0.04, cab, 0.02)
        rounded_box(f"bench_{'s' if side > 0 else 'p'}", 6.3, 8.4, cy, cy + 0.2, side * 0.78 - 0.17, side * 0.78 + 0.17, M["teak"], 0.02)
    # A tiller (common on a 31-footer).
    rod("tiller", (8.55, y_deck(8.55) + 0.45, 0), (7.3, y_deck(7.3) + 0.55, 0), 0.025, M["teak"], parent=rp)
    rod("rudder_stock", (8.55, 0.3, 0), (8.55, y_deck(8.55) + 0.47, 0), 0.03, M["steel"], parent=rp)

    # Pulpit, pushpit, stanchions and lifelines.
    yb = y_deck(0.3)
    tube("pulpit", [(0.9, yb + 0.02, 0.62), (0.45, yb + 0.68, 0.45), (0.2, yb + 0.7, 0.0), (0.45, yb + 0.68, -0.45), (0.9, yb + 0.02, -0.62)], 0.014, M["steel"])
    ys = y_deck(L - 0.2)
    tube("pushpit", [(8.7, ys + 0.02, 1.25), (9.25, ys + 0.66, 1.15), (9.3, ys + 0.66, 0.4), (9.3, ys + 0.66, -0.4), (9.25, ys + 0.66, -1.15), (8.7, ys + 0.02, -1.25)], 0.014, M["steel"])
    stanchions(f, [1.9, 3.2, 4.5, 5.8, 7.1, 8.3], 0.62, 0.07, M["steel"], M["wire"], ends=(0.55, 9.25))

    # Rig: deck-stepped mast, boom, spreaders, standing rigging.
    mx, mh = CRUISER["mast_x"], CRUISER["mast_h"]
    ym = y_deck(mx) + 0.48  # on the cabin top
    cylinder("mast", 0.085, mx, ym, ym + mh, 0, M["alu"], segs=24, r_top=0.055)
    cylinder("masthead_light", 0.04, mx, ym + mh, ym + mh + 0.08, 0, M["lamp"], segs=16)
    for side in (1, -1):
        rod(f"spreader_{'s' if side > 0 else 'p'}", (mx, ym + 6.4, 0), (mx + 0.1, ym + 6.4, side * 1.05), 0.022, M["alu"], segs=10)
        chain = (mx + 0.15, y_deck(mx + 0.15), side * (hb((mx + 0.15) / L) - 0.08))
        rod(f"shroud_{'s' if side > 0 else 'p'}", chain, (mx + 0.1, ym + 6.4, side * 1.05), 0.005, M["wire"], segs=6)
        rod(f"shroud_up_{'s' if side > 0 else 'p'}", (mx + 0.1, ym + 6.4, side * 1.05), (mx, ym + mh - 0.1, 0), 0.005, M["wire"], segs=6)
    bow = (0.18, y_deck(0.18) + 0.05, 0)
    rod("forestay", bow, (mx, ym + mh - 0.05, 0), 0.006, M["wire"], segs=6)
    rod("backstay", (mx, ym + mh - 0.05, 0), (L - 0.12, y_deck(L - 0.12) + 0.05, 0), 0.005, M["wire"], segs=6)
    gx = 7.35
    mp = pivot("main_pivot", (mx, ym, 0))
    rod("boom", (mx + 0.09, ym + 0.95, 0), (gx, ym + 0.95, 0), 0.055, M["alu"], segs=16, parent=mp)
    main_t, main_h, main_c = (mx + 0.1, ym + 1.0, 0), (mx + 0.08, ym + mh - 0.35, 0), (gx - 0.08, ym + 1.0, 0)
    sail("sail_main", main_t, main_h, main_c, 0.07, M["sail"], parent=mp)
    jp = pivot("jib_pivot", bow)
    jib_t = (0.3, y_deck(0.3) + 0.42, 0)
    jib_h = (mx - 0.25, ym + mh - 0.9, 0)
    jib_c = (4.95, y_deck(4.95) + 0.6, 0)
    sail("sail_jib", jib_t, jib_h, jib_c, 0.09, M["sail"], parent=jp)
    # Winches by the cockpit.
    for side in (1, -1):
        cylinder(f"winch_{'s' if side > 0 else 'p'}", 0.07, 6.3, cy + 0.32, cy + 0.46, side * 0.98, M["steel"], segs=20, r_top=0.06)
    # Navigation lights on the pulpit.
    red = material("red_light", base=hexcol(0xFF3030), rough=0.2, emit=(1.0, 0.1, 0.1))
    green = material("green_light", base=hexcol(0x30FF60), rough=0.2, emit=(0.1, 1.0, 0.3))
    rounded_box("light_port", 0.42, 0.5, yb + 0.6, yb + 0.66, -0.5, -0.44, red, 0.005)
    rounded_box("light_starboard", 0.42, 0.5, yb + 0.6, yb + 0.66, 0.44, 0.5, green, 0.005)
    return [(ob, img, rgb)]


# ----------------------------------------------------------------- dinghy ----
# 4.2 m by 1.2 m, a flat board boat 0.3 m deep; lateen rig on a short mast.
DINGHY = {"L": 4.2, "B": 0.6, "wl": 0.08, "mast_x": 1.05}
DINGHY_PAINT = HullPaint(top=0xF5F4EF, deck=0xF0EFEA, boot=0x2C6FB5, bottom=0xEDEBE6, lettering=None)


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
    rod("tiller", (L, f.dz(1.0) + 0.06, 0), (3.2, f.dz(0.76) + 0.12, 0), 0.016, M["teak"], parent=rp)
    # Lateen rig: a short mast, the sail laced between a long yard and a boom
    # that cross at the mast.
    mx = DINGHY["mast_x"]
    ym = f.deck_y(mx, 0)
    cylinder("mast", 0.035, mx, ym - 0.2, ym + 2.0, 0, M["alu"], segs=16, r_top=0.03)
    mp = pivot("main_pivot", (mx, ym, 0))
    tack = (0.55, ym + 0.42, 0.0)
    clew = (3.95, ym + 0.5, 0.0)
    peak = (2.35, ym + 4.5, 0.0)
    rod("boom", (tack[0] - 0.05, tack[1] - 0.03, 0), (clew[0] + 0.05, clew[1] - 0.03, 0), 0.025, M["alu"], parent=mp)
    rod("yard", (tack[0] - 0.08, tack[1] - 0.06, 0), (peak[0] + 0.05, peak[1] + 0.04, 0), 0.025, M["alu"], parent=mp)
    sail_mat = material("sail_dinghy", base=hexcol(0xF6F4EC), rough=0.75)
    sail("sail_main", tack, peak, clew, 0.06, sail_mat, parent=mp)
    # One coloured panel low on the sail (generic, no insignia).
    band = material("sail_band", base=hexcol(0x2C6FB5), rough=0.75)
    t2 = (tack[0] + 0.12, tack[1] + 0.12, 0.012)
    c2 = (clew[0] - 0.55, clew[1] + 0.12, 0.012)
    flat_quad("sail_band", t2, c2, (c2[0] - 0.05, c2[1] + 0.32, 0.012), (t2[0] + 0.12, t2[1] + 0.34, 0.012), band, parent=mp)
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
        return 0.3 * max(1 - s / 0.3, 0) ** 2 + 0.08 * max((s - 0.8) / 0.2, 0) ** 2  # a banana rocker

    def dz(s: float) -> float:
        return CAT["depth"] - 0.08 * s

    f = HullForm(L=L, n=2.0, crown=0.06, wl=CAT["wl"], hb=hb, kz=kz, dz=dz)
    stbd, img, rgb = hull(f, CAT_PAINT, rough=0.25, coat=0.55, nx=160, nt=26, nd=12)
    stbd.location = (0, -g, 0)  # Blender frame: builder +z is Blender -y
    port = stbd.copy()
    port.name = "hull_port"
    bpy.context.collection.objects.link(port)
    port.location = (0, g, 0)
    stbd.name = "hull_starboard"

    # Beams and the trampoline between them.
    yd = f.dz(0.3) + 0.02
    for x in (1.45, 3.65):
        rod(f"beam_{x:.2f}", (x, yd, -g - 0.06), (x, yd, g + 0.06), 0.045, M["alu"])
    tramp = material("trampoline", base=hexcol(0x24282D), rough=0.85)
    flat_quad("trampoline", (1.47, yd + 0.01, -g + 0.12), (1.47, yd + 0.01, g - 0.12), (3.63, yd + 0.01, g - 0.12), (3.63, yd + 0.01, -g + 0.12), tramp)
    for side in (1, -1):
        rod(f"tramp_edge_{'s' if side > 0 else 'p'}", (1.47, yd, side * (g - 0.12)), (3.63, yd, side * (g - 0.12)), 0.02, M["alu"], segs=10)
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
        rod(f"shroud_{'s' if side > 0 else 'p'}", (1.6, yd, side * g), hound, 0.004, M["wire"], segs=6)
    # Sails: a jib on the bridle, a fully battened square-top main with a short boom.
    jp = pivot("jib_pivot", bridle)
    sail("sail_jib", (0.8, yd + 0.22, 0), (1.3, hound[1] - 0.12, 0), (2.25, yd + 0.42, 0), 0.08, M["sail"], parent=jp)
    mp = pivot("main_pivot", (1.45, yd, 0))
    rod("boom", (1.5, yd + 0.45, 0), (4.35, yd + 0.45, 0), 0.035, M["alu"], segs=12, parent=mp)
    m_t, m_h, m_c = (1.52, yd + 0.5, 0), (1.5, yd + mh - 0.08, 0), (4.3, yd + 0.5, 0)
    sail("sail_main", m_t, m_h, m_c, 0.065, M["sail"], parent=mp)
    battens("batten", m_t, m_h, m_c, 0.065, 7, M["black"], parent=mp)
    # Rudders on both sterns with a tiller bar across.
    for side, tag in ((1, "s"), (-1, "p")):
        rp = pivot(f"rudder_pivot_{tag}", (L - 0.03, 0.25, side * g))
        foil(f"rudder_{tag}", 0.26, 0.2, L - 0.03, L + 0.0, 0.32, -0.55, 0.1, M["g10"], parent=rp)
        rod(f"tiller_arm_{tag}", (L + 0.02, CAT["depth"] - 0.05, side * g), (L - 0.25, CAT["depth"] + 0.05, side * (g - 0.15)), 0.015, M["alu"], parent=rp)
    rod("tiller_bar", (L - 0.25, CAT["depth"] + 0.05, g - 0.15), (L - 0.25, CAT["depth"] + 0.05, -g + 0.15), 0.018, M["alu"])
    return [(stbd, img, rgb)]


BUILD = {"cruiser": build_cruiser, "dinghy": build_dinghy, "beachcat": build_beachcat}


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    if len(args) != 2 or args[0] not in BUILD:
        sys.exit(f"usage: build_stock.py {{{'|'.join(BUILD)}}} out.glb")
    reset()
    bake = BUILD[args[0]]()
    bake_ao(bake)
    export(Path(args[1]))


main()
