"""Take the small fittings of the Randolph team's own 3D model and store them, thinned out, for our build.

The Randolph team publish their boat as a browser 3D viewer (their repo sheltonr2/drone-boat,
build-files/viewer/model.json, MIT licence: see THIRD_PARTY_NOTICES.md). Its hull, wing, keel and
panels we already draw ourselves from their numbers (blender/build_randolph.py); what our model
lacked was the fittings: the stern post's brackets, radar reflector and light, the wind-vane
housing and arm, the satellite modem's bowl, the wing's clamp, servo housing, tail fin and
counterweight pod, the weed fairing and the printed rudders. This script copies those meshes,
places them, thins each to a few hundred triangles (their files are print-ready, 5 to 18 thousand
triangles a part) and writes blender/randolph_fittings.json, which is kept in git so the site build
needs nothing from their repo.

Run it again when their model changes (needs Blender's Python module, as blender/*.py do):

    git clone --depth 1 https://github.com/sheltonr2/drone-boat /tmp/drone-boat
    python sea3d/scripts/randolph_fittings.py /tmp/drone-boat/build-files/viewer/model.json

Coordinates: theirs are mm, x aft from the bow, y to port, z up from the hull bottom. Ours (the
builder frame of blender/common.py and src/boats/parts.ts) are metres, x aft, y up, z to port.
Stored as int16 tenths of a millimetre in our frame.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import bpy
import numpy as np

# id in their assembly -> (the group it moves with in our model, our material name, most triangles kept)
# Groups: "fixed" (hull), "wing" (turns with the wing), "flap" (the tail fin), "vane" (the wind vane),
# "rudder" (one rudder, moved to the centreline: the Boatyard copies it for the twin).
# Each group and material is one more thing to draw every frame (twice with shadows), so the list
# is kept to few materials, and parts too small or too hidden to see are left out (the membrane
# vent, the tail detent, the lead inside the counterweight pod, the pivot rod inside the tail fin).
PICK: dict[str, tuple[str, str, int]] = {
    "fairing": ("fixed", "antifoul", 260),
    "hatch_lid": ("fixed", "hatch", 500),
    "P06": ("fixed", "asa", 400),
    "radar": ("fixed", "asa", 200),
    "P05": ("fixed", "asa", 500),
    "gps": ("fixed", "dark", 80),
    "P20": ("fixed", "asa", 300),
    "navlight": ("fixed", "asa", 120),  # the lens; its light is drawn by boats/navlights.ts
    "P03": ("fixed", "asa", 300),
    "P01": ("fixed", "asa", 400),
    "P23": ("fixed", "asa", 700),
    "rockblock": ("fixed", "dark", 200),
    "schrader": ("fixed", "dark", 60),
    "deckfitting": ("fixed", "asa", 100),
    "P08": ("wing", "asa", 500),
    "P09": ("wing", "asa", 400),
    "P18": ("wing", "asa", 500),
    "P10a": ("flap", "wing", 500),
    "P10b": ("flap", "wing", 500),
    "P02": ("vane", "asa", 600),
    "P13a_port": ("rudder", "antifoul", 500),
    "P13b_port": ("rudder", "antifoul", 500),
}


def thin(v: np.ndarray, f: np.ndarray, most: int) -> tuple[np.ndarray, np.ndarray]:
    """Weld the creased copies of each corner, then collapse edges down to about `most` triangles."""
    import bmesh  # only importable once bpy is loaded

    me = bpy.data.meshes.new("t")
    me.from_pydata(v.tolist(), [], f.tolist())
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.02)  # mm
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("t", me)
    bpy.context.collection.objects.link(ob)
    if len(me.polygons) > most:
        mod = ob.modifiers.new("d", "DECIMATE")
        mod.ratio = most / len(me.polygons)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier="d")
    me = ob.data
    me.calc_loop_triangles()
    vo = np.array([p.co[:] for p in me.vertices], dtype=np.float64)
    fo = np.array([t.vertices[:] for t in me.loop_triangles], dtype=np.int64)
    bpy.data.objects.remove(ob)
    return vo, fo


def main(src: Path, out: Path) -> None:
    J = json.loads(src.read_text())
    buf = base64.b64decode(J["bin"])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    parts = []
    total = 0
    for a in J["assembly"]:
        if a["id"] not in PICK:
            continue
        group, mat, most = PICK[a["id"]]
        g = J["geoms"][a["geom"]]
        q = np.frombuffer(buf, dtype="<i2", count=g["nv"] * 3, offset=g["pos"]).reshape(-1, 3)
        v = (q.astype(np.float64) + 32768.0) * np.array(g["sc"]) + np.array(g["lo"])
        idx = np.frombuffer(
            buf, dtype="<u2" if g["it"] == 16 else "<u4", count=g["nf"] * 3, offset=g["idx"]
        )
        f = idx.astype(np.int64).reshape(-1, 3)
        m = np.array(a["m"], dtype=np.float64).reshape(4, 4).T  # three.js stores columns first
        v = v @ m[:3, :3].T + m[:3, 3]
        if group == "rudder":
            v[:, 1] -= J["rudder"]["y"][1]  # the port rudder, onto the centreline
        v, f = thin(v, f, most)
        ours = np.stack([v[:, 0], v[:, 2], v[:, 1]], axis=1) / 1000.0  # (x aft, y up, z port), m
        assert np.abs(ours * 10000.0).max() < 32767, f"{a['id']}: too far from the bow for int16"
        assert len(ours) < 65536, f"{a['id']}: too many points for uint16 corners"
        q16 = np.round(ours * 10000.0).astype("<i2")
        parts.append(
            {
                "id": a["id"],
                "name": a["name"],
                "group": group,
                "mat": mat,
                "nv": len(q16),
                "nf": len(f),
                "pos": base64.b64encode(q16.tobytes()).decode(),
                "idx": base64.b64encode(f.astype("<u2").tobytes()).decode(),
            }
        )
        total += len(f)
        print(f"{a['id']:10s} {g['nf']:6d} -> {len(f):5d} triangles  {group}/{mat}")
    missing = set(PICK) - {p["id"] for p in parts}
    assert not missing, f"not in their model any more: {sorted(missing)}"
    out.write_text(
        json.dumps(
            {
                "source": "sheltonr2/drone-boat build-files/viewer/model.json (MIT, (c) 2026 Randolph)",
                "their_version": J["version"],
                "their_date": J["date"],
                "units": "int16, 0.1 mm; x aft from the bow, y up from the hull bottom, z to port",
                "parts": parts,
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    print(f"{len(parts)} parts, {total} triangles, {out.stat().st_size / 1e3:.0f} kB -> {out}")


if __name__ == "__main__":
    main(
        Path(sys.argv[1]),
        Path(__file__).resolve().parent.parent / "blender" / "randolph_fittings.json",
    )
