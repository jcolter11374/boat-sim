"""Build our model of the Randolph team's boat as a detailed glTF .glb.

Run with Blender's Python module (pip install bpy==4.2.0, Python 3.11):

    python sea3d/blender/build_randolph.py sea3d/public/models/randolph.glb

The hull, wing, keel and panels are drawn here from the numbers in
src/boats/model.ts buildRandolph, which come from the Randolph team's published
design (their repo's design.py). The fittings (stern post brackets, radar
reflector, light, wind vane, modem bowl, wing clamp, tail fin, counterweight
pod, weed fairing, printed rudder) are their own published shapes, thinned out
(randolph_fittings.json, made by scripts/randolph_fittings.py; MIT, see
THIRD_PARTY_NOTICES.md). The colours are the ones their viewer and launch plan
give: hi-vis orange topsides, a white boot stripe, dark red antifouling, and a
fluorescent orange panel on the lower half of the wing. This is our model of
their boat, not their own: no names or lettering are painted on it.

Two parts are left free to turn so the page can animate them: the wing
assembly hangs under an empty named "wing_pivot" (on the mast, x = 0.6 m) and
the stern wind vane under "vane_pivot" (x = 1.53 m, 0.68 m up).
"""

from __future__ import annotations

import base64
import json
import math
import sys
from pathlib import Path

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
    naca,
    out_path,
    panel,
    pivot,
    reset,
    rod,
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
# Their colours (their viewer's hull material and docs/Launch_Plan.md "Labels and marking").
# Keep in step with src/boats/paint.ts BUILT.randolph and the drawn-in-code boat in src/boats/model.ts.
HIVIS = 0xFF5B12
PAINT = HullPaint(top=HIVIS, deck=0xDFE5E8, boot=0xF4F4F0, bottom=0x5A1712)
FITTINGS = Path(__file__).resolve().parent / "randolph_fittings.json"
SHARP = math.radians(35)  # edges sharper than this stay crisp on the thinned fittings


def fittings(mats: dict, parents: dict) -> None:
    """Their published fittings, one mesh per moving group and material (few draw calls).

    The file is in the builder frame already (see scripts/randolph_fittings.py)."""
    import bmesh  # only importable once bpy is loaded

    groups: dict[tuple[str, str], tuple[list, list]] = {}
    for p in json.loads(FITTINGS.read_text())["parts"]:
        v = np.frombuffer(base64.b64decode(p["pos"]), dtype="<i2").reshape(-1, 3) / 10000.0
        f = np.frombuffer(base64.b64decode(p["idx"]), dtype="<u2").reshape(-1, 3)
        verts, faces = groups.setdefault((p["group"], p["mat"]), ([], []))
        base = len(verts)
        verts += [tuple(map(float, q)) for q in v]
        faces += [tuple(int(i) + base for i in t) for t in f]
    for (group, mat), (verts, faces) in sorted(groups.items()):
        # The tail fin is found by name (boats/gear.ts hides it when the sail tears).
        name = "tail_flap" if group == "flap" else f"fit_{group}_{mat}"
        ob = mesh_object(name, verts, faces, mat=mats[mat], parent=parents.get(group))
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        for e in bm.edges:
            if len(e.link_faces) != 2 or e.calc_face_angle(0.0) > SHARP:
                e.smooth = False
        bm.to_mesh(ob.data)
        bm.free()


def join(name: str, obs: list, parent=None):
    """Several objects of one material as one mesh."""
    import bpy

    bpy.ops.object.select_all(action="DESELECT")
    for ob in obs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.join()
    obs[0].name = name
    if parent is not None:
        attach(obs[0], parent)
    return obs[0]


def wing(
    x_le: float,
    chord: float,
    y0: float,
    y1: float,
    band: tuple[float, float],
    t,
    white,
    hivis,
    parent,
):
    """The wing as one foil with a hi-vis panel across its lower half (both faces)."""
    prof = naca(t, 48)
    m = len(prof)
    ys = [y0, band[0], band[1], y1]
    verts = [(x_le + px * chord, y, pz * chord) for y in ys for px, pz in prof]
    faces = [
        (si * m + k, si * m + (k + 1) % m, (si + 1) * m + (k + 1) % m, (si + 1) * m + k)
        for si in range(len(ys) - 1)
        for k in range(m)
    ]
    n_skin = len(faces)
    for si in (0, len(ys) - 1):  # the ply end caps
        c = len(verts)
        verts.append((x_le + 0.4 * chord, ys[si], 0))
        faces += [(si * m + k, si * m + (k + 1) % m, c) for k in range(m)]
    ob = mesh_object("wing", verts, faces, mat=white, parent=parent)
    ob.data.materials.append(hivis)
    # Faces keep the order given (hull() counts on that too): the second ring of skin is the panel.
    for poly in ob.data.polygons[m : 2 * m]:
        poly.material_index = 1
    assert n_skin == 3 * m
    return ob


WING_X = 0.6
VANE_AT = (1.53, 0.68, 0.0)


def build(out: Path) -> None:
    reset()
    hull_ob, hull_img, hull_rgb = hull(R, PAINT, rough=0.4, coat=0.35, nx=140, tex=(1024, 512))
    deck = R.deck_y

    # Keel, bulb, fairing and rudders are painted with the bottom paint (their viewer: "antifoul"),
    # so a Boatyard paint scheme recolours them with the bottom (paint.ts PAINTED_PARTS).
    antifoul = material("antifoul", base=hexcol(PAINT.bottom), rough=0.78)
    pvc = material("pvc", base=hexcol(0xE9ECEE), rough=0.5)
    dark = material("dark", base=hexcol(0x26292C), rough=0.5)
    spar = material("spar", base=hexcol(0x2A2D31), rough=0.35, metal=0.4)
    glass = material("fibreglass", base=hexcol(0xD6D3BD), rough=0.5)
    white = material("wing", base=hexcol(0xF7F7F4), rough=0.45)
    mats = {
        "antifoul": antifoul,
        "dark": dark,
        "spar": spar,
        "wing": white,
        # Their printed parts are white ASA where the sun gets at them.
        "asa": material("asa", base=hexcol(0xEFEFEA), rough=0.58),
        "hatch": material("hatch", base=hexcol(0xE3E6E2), rough=0.4),
    }

    # Keel fin (root 170, tip 150 mm chord, 430 mm deep) and the D72 lead bulb (about 9.2 kg; Rev B had D68, 8.2 kg).
    foil("keel", 0.17, 0.15, 0.657, 0.67, 0.02, -0.43, 0.12, antifoul)
    lathe("bulb", bulb_profile(0.32, 0.072, 0.4), 40, antifoul, (0.579, -0.434, 0))
    # Two solar panels on the aft deck.
    panel("panel_fwd", 0.65, 1.07, 0.28, deck, 4, 2)
    panel("panel_aft", 1.08, 1.48, 0.28, deck, 4, 2)
    # Mast tube (2 in PVC) and the printed bearing housing's rim on deck.
    cylinder("mast_tube", 0.03, WING_X, 0.0, 0.25, 0, pvc)
    cylinder(
        "bearing",
        0.033,
        WING_X,
        0.25,
        0.262,
        0,
        material("petg", base=hexcol(0x3D6A86), rough=0.36),
    )

    # Rotating wing assembly: wing, spar, boom, counterweight arm. Numbers relative to the pivot, as in model.ts.
    wp = pivot("wing_pivot", (WING_X, 0, 0))
    x = WING_X
    # Rev C5 wing (Wing_Shape_Study.md): 0.80 m span x 0.375 m chord, spar at 22% chord. Foam core,
    # glass skin, ply end caps. The hi-vis panel is their "wing panels ... lower half, so it reads
    # with the boat heeled" (Launch_Plan.md); GUESS: its exact edges (60 to 360 mm up the wing).
    wing(
        x - 0.0825,
        0.375,
        0.3,
        1.1,
        (0.36, 0.66),
        0.15,
        white,
        material("wing_hivis", base=hexcol(HIVIS), rough=0.45),
        wp,
    )
    # The spar shows only below the wing and as a stub above it: inside the wing it is not drawn
    # (it showed through the skin as specks). Spar and boom are one mesh, one thing to draw.
    join(
        "wing_spar",
        [
            cylinder("wing_spar", 0.015, x, 0.05, 0.305, 0, spar, segs=20),
            cylinder("wing_spar_top", 0.015, x, 1.095, 1.11, 0, spar, segs=20),
            rod("boom", (x, 0.276, 0), (x + 0.6, 0.276, 0), 0.006, spar),
        ],
        wp,
    )
    # Rev C3: the counterweight arm and the stern post are fibreglass (Structural_Review.md).
    rod("counter_arm", (x, 0.276, 0), (x - 0.3, 0.276, 0), 0.006, glass, parent=wp)

    # Stern post (20 x 2 mm fibreglass tube); its brackets, platform, light and vane are their parts.
    cylinder("stern_pole", 0.01, 1.53, 0.15, 0.65, 0, glass, segs=16)
    vp = pivot("vane_pivot", VANE_AT)
    # Rudder, stock at x = 1400 mm: their printed blade, on the centreline (the Boatyard copies it for the twin).
    rp = pivot("rudder_pivot", (1.4, 0, 0))
    fittings(mats, {"wing": wp, "flap": wp, "vane": vp, "rudder": rp})

    bake_ao([(hull_ob, hull_img, hull_rgb)])
    export(out)


build(out_path("randolph.glb"))
