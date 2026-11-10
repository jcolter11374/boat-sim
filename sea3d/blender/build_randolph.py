"""Build our model of the Randolph team's boat (Rev B) as a detailed glTF .glb.

Run with Blender's Python module (pip install bpy==4.2.0, Python 3.11):

    python sea3d/blender/build_randolph.py sea3d/public/models/randolph.glb

Every shape and number comes from src/boats/model.ts buildRandolph, which was
drawn from the Randolph team's published design (their repo's design.py, Rev B).
This is our model of their boat, not their own: no names or markings are
painted on it.

Two parts are left free to turn so the page can animate them: the wing
assembly hangs under an empty named "wing_pivot" (on the mast, x = 0.6 m) and
the stern wind vane under "vane_pivot" (x = 1.53 m, 0.68 m up).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # for blender -P

from common import (
    HullForm,
    HullPaint,
    bake_ao,
    bulb_profile,
    cylinder,
    export,
    foil,
    hexcol,
    hull,
    lathe,
    material,
    out_path,
    panel,
    pivot,
    reset,
    rod,
    rounded_box,
)

# ---------------------------------------------------------------- shape ----
L = 1.5
WL = 0.09


def hb(s: float) -> float:
    if s <= 0.55:
        return 0.2 * max(1 - (1 - s / 0.55) ** 2, 0) ** 0.6
    return 0.2 - 0.05 * ((s - 0.55) / 0.45) ** 2


def kz(s: float) -> float:
    if s < 0.5:
        return 0.12 * max(1 - s / 0.5, 0) ** 2.2
    return 0.06 * ((s - 0.5) / 0.5) ** 2


def dz(s: float) -> float:
    return 0.23 + 0.03 * max(1 - s / 0.4, 0) ** 2


R = HullForm(L=L, n=2.2, crown=0.006, wl=WL, hb=hb, kz=kz, dz=dz)
PAINT = HullPaint(top=0xF1F3F4, deck=0xDFE5E8, boot=0x0F8A8A, bottom=0x2E5566)
TEAL = 0x0F8A8A
WING_X = 0.6
VANE_AT = (1.53, 0.68, 0.0)


def build(out: Path) -> None:
    reset()
    hull_ob, hull_img, hull_rgb = hull(R, PAINT, rough=0.4, coat=0.35, nx=140, tex=(1024, 512))
    deck = R.deck_y

    fin = material("fin", base=hexcol(0x30373C), rough=0.45)
    lead = material("lead", base=hexcol(0x6D7378), rough=0.4, metal=0.5)
    pvc = material("pvc", base=hexcol(0xE9ECEE), rough=0.5)
    dark = material("dark", base=hexcol(0x26292C), rough=0.5)
    spar = material("spar", base=hexcol(0x2A2D31), rough=0.35, metal=0.4)
    teal = material("teal", base=hexcol(TEAL), rough=0.4)

    # Keel fin (root 170, tip 150 mm chord, 430 mm deep) and 8.2 kg lead bulb.
    foil("keel", 0.17, 0.15, 0.657, 0.67, 0.02, -0.43, 0.12, fin)
    lathe("bulb", bulb_profile(0.32, 0.068, 0.4), 40, lead, (0.579, -0.434, 0))
    # Rudder, stock at x = 1400 mm.
    foil("rudder", 0.12, 0.12, 1.378, 1.378, 0.05, -0.19, 0.12, fin)
    # Two solar panels on the aft deck.
    panel("panel_fwd", 0.65, 1.07, 0.28, deck, 4, 2)
    panel("panel_aft", 1.08, 1.48, 0.28, deck, 4, 2)
    # Hatch.
    h = deck(0.43, 0)
    rounded_box(
        "hatch",
        0.33,
        0.53,
        h - 0.002,
        h + 0.012,
        -0.11,
        0.11,
        material("hatch", base=hexcol(0xC9D2D6), rough=0.4),
        0.005,
    )
    # Mast tube (2 in PVC) and bearing housing.
    cylinder("mast_tube", 0.03, WING_X, 0.0, 0.25, 0, pvc)
    cylinder("bearing", 0.0185, WING_X, 0.25, 0.268, 0, dark)

    # Rotating wing assembly: wing, spar, boom, tail flap, counterweight.
    # Numbers below are relative to the pivot, as in model.ts.
    wp = pivot("wing_pivot", (WING_X, 0, 0))
    x = WING_X
    foil(
        "wing",
        0.3,
        0.3,
        x - 0.066,
        x - 0.066,
        0.3,
        1.3,
        0.15,
        material("wing", base=hexcol(0xFBFBF7), rough=0.45),
        n_span=4,
        parent=wp,
    )
    cylinder("wing_spar", 0.0125, x, 0.05, 1.31, 0, spar, segs=20, parent=wp)
    rod("boom", (x, 0.276, 0), (x + 0.6, 0.276, 0), 0.006, spar, parent=wp)
    cylinder("flap_hinge", 0.016, x + 0.6, 0.255, 0.3, 0, dark, segs=20, parent=wp)
    foil("tail_flap", 0.12, 0.12, x + 0.576, x + 0.576, 0.3, 0.5, 0.12, teal, n_span=2, parent=wp)
    rod("counter_arm", (x, 0.276, 0), (x - 0.3, 0.276, 0), 0.006, spar, parent=wp)
    cylinder(
        "counterweight",
        0.032,
        x - 0.3,
        0.264,
        0.338,
        0,
        material("weight", base=hexcol(0x5F666B), rough=0.35, metal=0.5),
        parent=wp,
    )

    # Stern pole: transom bracket, antenna platform at 560 mm, wind vane at 650 mm.
    rounded_box("bracket", 1.49, 1.545, 0.15, 0.2, -0.02, 0.02, dark, 0.003)
    cylinder("stern_pole", 0.01, 1.53, 0.15, 0.65, 0, spar, segs=16)
    cylinder("antenna_disc", 0.04, 1.53, 0.553, 0.567, 0, pvc)
    cylinder("vane_bearing", 0.018, 1.53, 0.65, 0.69, 0, dark, segs=20)
    vp = pivot("vane_pivot", VANE_AT)
    vx, vy, _ = VANE_AT
    rod("vane_arm", (vx, vy, 0), (vx + 0.16, vy, 0), 0.004, dark, segs=10, parent=vp)
    rounded_box(
        "vane", vx + 0.1, vx + 0.17, vy - 0.03, vy + 0.04, -0.002, 0.002, teal, 0.0015, parent=vp
    )

    bake_ao([(hull_ob, hull_img, hull_rgb)])
    export(out)


build(out_path("randolph.glb"))
