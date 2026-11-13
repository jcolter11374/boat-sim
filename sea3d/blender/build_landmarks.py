"""Build landmarks seen from the water as 3D models (glTF .glb).

    python sea3d/blender/build_landmarks.py thomaspoint sea3d/public/models/landmark_thomaspoint.glb

(one per run: export() ends the process). Frame: x east, y up from the water
(mean sea level), z south, metres, with the origin at the landmark's centre,
which is the same frame the page uses (land/landmarks.ts), so it is placed
without turning.

thomaspoint: Thomas Point Shoal Light (1875), off Annapolis on the Chesapeake
Bay. It's a "screwpile" lighthouse: a 1.5-storey hexagonal wooden cottage
standing on iron legs that were screwed into the Bay floor, with a square
black lantern on the roof. White walls, a red roof, brown legs, and stone
heaped round the legs against winter ice. From the US Lighthouse Society's
light list and its Wikipedia page: the light is 43 ft (13 m) above the water,
the top is about 15 m up, and it stands in about 2 m of water on 9 piles.
The cottage's width, the deck height and the window layout are GUESSES from
photos, not drawings.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))  # for blender -P

from common import export, hexcol, material, mesh_object, reset, rod

# Heights (m above the water).
DECK = 3.6  # the platform the cottage stands on (GUESS)
EAVES = 6.9
RIDGE = 9.6
LANTERN_DECK = 11.6
FOCAL = 13.0  # the light itself: 43 ft
TOP = 15.0
HOUSE_R = 4.3  # cottage, corner to centre (GUESS: about 8.6 m across)
DECK_R = 5.7
FLOOR = -2.2  # the Bay floor here (about 7 ft of water)


def mats():
    return {
        "white": material("white", base=hexcol(0xF2F0EA), rough=0.8),
        "trim": material("trim", base=hexcol(0xFFFFFF), rough=0.7),
        "roof": material("roof", base=hexcol(0x9E2B22), rough=0.75),
        "black": material("black", base=hexcol(0x1C1E20), rough=0.5, metal=0.4),
        "pile": material("pile", base=hexcol(0x4A3426), rough=0.7, metal=0.3),
        "deck": material("deck", base=hexcol(0x6B6A66), rough=0.85),
        "glass": material("glass", base=hexcol(0x1A2530), rough=0.08, metal=0.2),
        "lantern_glass": material("lantern_glass", base=hexcol(0xC8D4DC), rough=0.05, metal=0.6),
        "stone": material("stone", base=hexcol(0x8B8780), rough=0.95),
        "brick": material("brick", base=hexcol(0x8A4A3A), rough=0.9),
        # The page finds this by name and flashes it (land/landmarks.ts).
        "lamp": material("lamp", base=hexcol(0xFFFFFF), rough=0.2, emit=(1.0, 0.97, 0.88)),
    }


def ring(n, r, y, rot=0.0):
    return [
        (r * math.cos(rot + 2 * math.pi * k / n), y, r * math.sin(rot + 2 * math.pi * k / n))
        for k in range(n)
    ]


def prism(name, n, r0, r1, y0, y1, mat, rot=0.0, top=True, bottom=True, at=(0.0, 0.0)):
    """An n-sided straight or tapered prism (a pyramid with r1 = 0)."""
    cx, cz = at
    verts = [(x + cx, y, z + cz) for x, y, z in ring(n, r0, y0, rot) + ring(n, r1, y1, rot)]
    faces = [(k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n)]
    if bottom:
        faces.append(tuple(range(n - 1, -1, -1)))
    if top and r1 > 0:
        faces.append(tuple(range(n, 2 * n)))
    return mesh_object(name, verts, faces, mat=mat, smooth=False)


def quad(name, a, b, c, d, mat):
    return mesh_object(name, [a, b, c, d], [(0, 1, 2, 3)], mat=mat, smooth=False)


def wall_panel(name, k, n, r, y0, y1, w, mat, out=0.03, rot=0.0):
    """A flat rectangle on face k of an n-gon of corner radius r (windows, door)."""
    a0 = rot + 2 * math.pi * k / n
    a1 = rot + 2 * math.pi * (k + 1) / n
    p0 = np.array([r * math.cos(a0), 0, r * math.sin(a0)])
    p1 = np.array([r * math.cos(a1), 0, r * math.sin(a1)])
    mid = (p0 + p1) / 2
    along = (p1 - p0) / np.linalg.norm(p1 - p0)
    normal = mid / np.linalg.norm(mid)
    c = mid + normal * out
    h = along * w / 2
    return quad(
        name,
        tuple(c - h + [0, y0, 0]),
        tuple(c + h + [0, y0, 0]),
        tuple(c + h + [0, y1, 0]),
        tuple(c - h + [0, y1, 0]),
        mat,
    )


def rock(name, at, size, rng, mat):
    """A rough stone: a squashed, jittered 8-sided double cone."""
    n = 7
    verts = [(0.0, size * 0.55, 0.0), (0.0, -size * 0.3, 0.0)]
    for k in range(n):
        a = 2 * math.pi * k / n + rng.uniform(-0.3, 0.3)
        rr = size * rng.uniform(0.7, 1.1)
        verts.append((rr * math.cos(a), size * rng.uniform(-0.05, 0.2), rr * math.sin(a)))
    faces = []
    for k in range(n):
        a, b = 2 + k, 2 + (k + 1) % n
        faces += [(0, b, a), (1, a, b)]
    x, y, z = at
    return mesh_object(
        name, [(vx + x, vy + y, vz + z) for vx, vy, vz in verts], faces, mat=mat, smooth=False
    )


def build_thomaspoint() -> None:
    m = mats()
    rng = np.random.default_rng(1875)
    rot = math.pi / 6  # flat faces to north and south: the door faces south (+z)

    # The legs: six under the deck's corners, three inside, and braces between them.
    outer = [(x, z) for x, _, z in ring(6, DECK_R - 0.5, 0, rot)]
    inner = [(x, z) for x, _, z in ring(3, 1.8, 0, rot + math.pi / 2)]
    for i, (x, z) in enumerate(outer + inner):
        rod(f"pile{i}", (x, FLOOR, z), (x, DECK - 0.25, z), 0.17, m["pile"])
    for i in range(6):
        (x0, z0), (x1, z1) = outer[i], outer[(i + 1) % 6]
        for y in (0.9, DECK - 0.5):
            rod(f"girt{i}_{y:.1f}", (x0, y, z0), (x1, y, z1), 0.07, m["pile"], segs=8)
        rod(f"brace{i}a", (x0, 0.9, z0), (x1, DECK - 0.5, z1), 0.05, m["pile"], segs=8)
        rod(f"brace{i}b", (x1, 0.9, z1), (x0, DECK - 0.5, z0), 0.05, m["pile"], segs=8)
        rod(f"spoke{i}", (x0, DECK - 0.5, z0), (0, DECK - 0.5, 0), 0.06, m["pile"], segs=8)

    # Stone heaped round the legs against ice (riprap).
    for i in range(70):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(4.2, 8.5)
        s = rng.uniform(0.5, 1.1)
        y = rng.uniform(-0.6, 0.4) - 0.08 * (r - 4.2)
        rock(f"rock{i}", (r * math.cos(a), y, r * math.sin(a)), s, rng, m["stone"])

    # The deck, its edge and the railing round it.
    prism("deck", 6, DECK_R, DECK_R, DECK - 0.3, DECK, m["deck"], rot)
    posts = ring(6, DECK_R - 0.1, DECK, rot)
    for i in range(6):
        x0, _, z0 = posts[i]
        x1, _, z1 = posts[(i + 1) % 6]
        rod(f"rail_post{i}", (x0, DECK, z0), (x0, DECK + 1.0, z0), 0.04, m["trim"], segs=8)
        for y in (DECK + 0.5, DECK + 1.0):
            rod(f"rail{i}_{y:.1f}", (x0, y, z0), (x1, y, z1), 0.025, m["trim"], segs=6)

    # The cottage: white walls, windows on each face, the door on the south face.
    prism("walls", 6, HOUSE_R, HOUSE_R, DECK, EAVES, m["white"], rot)
    prism("skirt", 6, HOUSE_R + 0.06, HOUSE_R + 0.06, DECK, DECK + 0.25, m["trim"], rot)
    prism("frieze", 6, HOUSE_R + 0.06, HOUSE_R + 0.06, EAVES - 0.3, EAVES, m["trim"], rot)
    for k in range(6):
        door = k == 1  # the face looking south-west
        for j, off in enumerate((-1.05, 1.05) if not door else (-1.35, 1.35)):
            # two windows a face (beside the door on the south face)
            a0, a1 = rot + 2 * math.pi * k / 6, rot + 2 * math.pi * (k + 1) / 6
            p0 = np.array([HOUSE_R * math.cos(a0), HOUSE_R * math.sin(a0)])
            p1 = np.array([HOUSE_R * math.cos(a1), HOUSE_R * math.sin(a1)])
            mid = (p0 + p1) / 2 + (p1 - p0) / np.linalg.norm(p1 - p0) * off
            ang = math.atan2(mid[1], mid[0])
            rr = float(np.hypot(*mid))
            # a frame then the glass on top of it
            for nm, w, y0, y1, out, mat in (
                ("frame", 0.95, DECK + 0.95, DECK + 2.45, 0.03, m["trim"]),
                ("glass", 0.75, DECK + 1.05, DECK + 2.35, 0.05, m["glass"]),
            ):
                c = np.array([rr * math.cos(ang), 0, rr * math.sin(ang)])
                nrm = c / np.linalg.norm(c)
                c = c + nrm * out
                along = np.array([-math.sin(ang), 0, math.cos(ang)]) * w / 2
                quad(
                    f"win{k}_{j}_{nm}",
                    tuple(c - along + [0, y0, 0]),
                    tuple(c + along + [0, y0, 0]),
                    tuple(c + along + [0, y1, 0]),
                    tuple(c - along + [0, y1, 0]),
                    mat,
                )
        if door:
            wall_panel("door_frame", k, 6, HOUSE_R, DECK, DECK + 2.3, 1.15, m["trim"], 0.04, rot)
            wall_panel("door", k, 6, HOUSE_R, DECK, DECK + 2.2, 0.95, m["roof"], 0.06, rot)

    # The roof: a red six-sided hip, overhanging the walls, with three dormers.
    prism("roof", 6, HOUSE_R + 0.55, 1.5, EAVES - 0.1, RIDGE, m["roof"], rot, top=True)
    prism("soffit", 6, HOUSE_R + 0.55, HOUSE_R, EAVES - 0.12, EAVES - 0.1, m["trim"], rot)
    for k in (1, 3, 5):
        a = rot + 2 * math.pi * (k + 0.5) / 6
        ux, uz = math.cos(a), math.sin(a)
        tx, tz = -uz, ux
        r0, y0, h, w = HOUSE_R - 0.1, EAVES + 0.4, 1.3, 1.5
        # front of the dormer, its little gable roof and its window
        fx, fz = r0 * ux * math.cos(math.pi / 6), r0 * uz * math.cos(math.pi / 6)
        verts = [
            (fx - tx * w / 2, y0, fz - tz * w / 2),
            (fx + tx * w / 2, y0, fz + tz * w / 2),
            (fx + tx * w / 2, y0 + h, fz + tz * w / 2),
            (fx, y0 + h + 0.55, fz),
            (fx - tx * w / 2, y0 + h, fz - tz * w / 2),
        ]
        back = [(x - ux * 2.0, y, z - uz * 2.0) for x, y, z in verts]
        mesh_object(
            f"dormer{k}",
            verts + back,
            [(0, 1, 2, 3, 4), (1, 6, 7, 2), (5, 0, 4, 9)],
            mat=m["white"],
            smooth=False,
        )
        mesh_object(
            f"dormer{k}_roof",
            [verts[4], verts[3], back[3], back[4], verts[2], back[2]],
            [(0, 1, 2, 3), (1, 4, 5, 2)],
            mat=m["roof"],
            smooth=False,
        )
        cx, cz = fx + ux * 0.03, fz + uz * 0.03
        quad(
            f"dormer{k}_glass",
            (cx - tx * 0.4, y0 + 0.25, cz - tz * 0.4),
            (cx + tx * 0.4, y0 + 0.25, cz + tz * 0.4),
            (cx + tx * 0.4, y0 + 1.15, cz + tz * 0.4),
            (cx - tx * 0.4, y0 + 1.15, cz - tz * 0.4),
            m["glass"],
        )
    prism(
        "chimney", 4, 0.35, 0.35, RIDGE - 1.6, RIDGE + 0.6, m["brick"], math.pi / 4, at=(-2.0, -1.0)
    )

    # Above the roof: a short white base, the lantern deck with a black railing, and
    # the square black lantern with its glass, the lamp, and a dome and ventilator ball.
    prism("lantern_base", 6, 1.5, 1.3, RIDGE - 0.1, LANTERN_DECK, m["white"], rot)
    prism("lantern_deck", 4, 2.0, 2.0, LANTERN_DECK - 0.15, LANTERN_DECK, m["black"], math.pi / 4)
    corners = ring(4, 1.9, LANTERN_DECK, math.pi / 4)
    for i in range(4):
        x0, _, z0 = corners[i]
        x1, _, z1 = corners[(i + 1) % 4]
        rod(
            f"gallery_post{i}",
            (x0, LANTERN_DECK, z0),
            (x0, LANTERN_DECK + 0.95, z0),
            0.03,
            m["black"],
            segs=8,
        )
        for y in (LANTERN_DECK + 0.45, LANTERN_DECK + 0.95):
            rod(f"gallery{i}_{y:.2f}", (x0, y, z0), (x1, y, z1), 0.02, m["black"], segs=6)
    sq = math.pi / 4
    g0, g1 = LANTERN_DECK + 0.6, FOCAL + 0.9
    prism("lantern_sill", 4, 1.25, 1.25, LANTERN_DECK, g0, m["black"], sq)
    prism("lantern_glass", 4, 1.15, 1.15, g0, g1, m["lantern_glass"], sq, top=False, bottom=False)
    for i, (x, _, z) in enumerate(ring(4, 1.18, 0, sq)):
        rod(f"mullion{i}", (x, g0, z), (x, g1, z), 0.05, m["black"], segs=6)
    prism("lantern_head", 4, 1.3, 1.3, g1, g1 + 0.2, m["black"], sq)
    prism("lantern_roof", 8, 1.35, 0.15, g1 + 0.2, TOP - 0.35, m["black"], 0.0)
    prism("ventilator", 8, 0.2, 0.2, TOP - 0.35, TOP - 0.1, m["black"], 0.0)
    rod("vane", (0, TOP - 0.1, 0), (0, TOP + 0.3, 0), 0.02, m["black"], segs=6)
    # The light: a lens on a stand; it glows, and the page flashes it.
    rod("lens_stand", (0, g0, 0), (0, FOCAL - 0.35, 0), 0.08, m["black"], segs=8)
    prism("lamp", 12, 0.3, 0.3, FOCAL - 0.35, FOCAL + 0.35, m["lamp"], 0.0)


BUILD = {"thomaspoint": build_thomaspoint}


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    if len(args) != 2 or args[0] not in BUILD:
        sys.exit(f"usage: build_landmarks.py {{{'|'.join(BUILD)}}} out.glb")
    reset()
    BUILD[args[0]]()
    join_by_material()
    export(Path(args[1]))


def join_by_material() -> None:
    """One mesh a material (a few draw calls, not hundreds); the lamp keeps its name."""
    for ob in list(bpy.context.scene.objects):  # bevels and the like baked in first
        if ob.type == "MESH" and ob.modifiers:
            bpy.context.view_layer.objects.active = ob
            for mod in list(ob.modifiers):
                bpy.ops.object.modifier_apply(modifier=mod.name)
    by: dict[str, list] = {}
    for ob in bpy.context.scene.objects:
        if ob.type == "MESH" and ob.data.materials:
            by.setdefault(ob.data.materials[0].name, []).append(ob)
    for name, obs in by.items():
        bpy.ops.object.select_all(action="DESELECT")
        for ob in obs:
            ob.select_set(True)
        bpy.context.view_layer.objects.active = obs[0]
        if len(obs) > 1:
            bpy.ops.object.join()
        obs[0].name = name


main()
