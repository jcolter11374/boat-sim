// Draw the solid parts of a detailed boat one-sided (speed list rank 18, 14 Nov).
//
// Blender exports every material double-sided unless told otherwise, so three.js
// shaded the inside of every hull, keel and fitting too: wherever a back face was
// drawn before the front face in front of it, that pixel was lit twice. Our parts
// are solids with their faces wound outward, so from outside the back faces are
// never what you see. Front-only drew the boats about a third cheaper (Rosa's per-object
// timing, software graphics: the cruiser on the practice page 179 -> 121 ms a frame, the
// kayak on the crossing 319 -> 195 ms at Medium) and changed at most a few dozen scattered
// edge pixels out of a quarter of a million, from 102 angles round each boat.
//
// Stays double-sided: sheets seen from both sides (sails, battens, the Randolph
// wing, flags), rigging wire and other hair-thin parts (held a pixel wide by
// boats/wire.ts), glass, flat parts, and the few open parts the render check
// found. The check (speed/tools/sides.mjs in the project files) renders every boat
// from 102 angles both ways and counts changed pixels; run it after a model changes.

import * as THREE from "three";

/** Material names of parts that are sheets, open or hair-thin, seen from both sides. The last four
 *  are the parts the render check (below) caught: the cat's trampoline, the drone's antenna dome,
 *  the rower's hatch and footplate trim, the Randolph boats' PVC mast tube. */
const TWO_SIDED_MATS = new Set(["sail", "wire", "wing", "wing_hivis", "glass", "flag", "trampoline", "dome", "trim", "pvc"]);
/** Mesh names of the same (the stock models name sails and battens per mesh). */
const TWO_SIDED_MESH = /^(sail|batten|wing|flag|burgee|jib|main|genoa)/i;
/** Parts thinner than this (m) on both short sides are wires and rods: left as they are. */
const THIN_M = 0.03;
/** Parts flatter than this (m) are sheets (a trampoline, a hatch lid, a disc). */
const FLAT_M = 0.005;

const size = new THREE.Vector3();

/** Whether a mesh is a solid part, drawn one-sided. */
export function isSolidPart(mesh: THREE.Mesh): boolean {
  if (TWO_SIDED_MESH.test(mesh.name)) return false;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (mats.some((m) => TWO_SIDED_MATS.has(m.name))) return false;
  const g = mesh.geometry;
  if (!g) return false;
  if (!g.boundingBox) g.computeBoundingBox();
  g.boundingBox!.getSize(size);
  const [a, b] = [size.x, size.y, size.z].sort((x, y) => x - y);
  if (a < FLAT_M || (a < THIN_M && b < THIN_M)) return false;
  // Faces wound outward enclose a positive volume; an inside-out part would vanish one-sided.
  return enclosedVolume(g) > 0;
}

/** The volume the triangles enclose, positive when wound outward (about the box centre). */
export function enclosedVolume(g: THREE.BufferGeometry): number {
  const p = g.attributes.position;
  if (!p) return 0;
  const idx = g.index;
  const n = idx ? idx.count : p.count;
  const c = new THREE.Vector3();
  g.boundingBox!.getCenter(c);
  let v = 0;
  for (let t = 0; t + 2 < n; t += 3) {
    const i = idx ? idx.getX(t) : t;
    const j = idx ? idx.getX(t + 1) : t + 1;
    const k = idx ? idx.getX(t + 2) : t + 2;
    const ax = p.getX(i) - c.x, ay = p.getY(i) - c.y, az = p.getZ(i) - c.z;
    const bx = p.getX(j) - c.x, by = p.getY(j) - c.y, bz = p.getZ(j) - c.z;
    const cx = p.getX(k) - c.x, cy = p.getY(k) - c.y, cz = p.getZ(k) - c.z;
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/**
 * Draw every solid part of a freshly loaded model front faces only. Call it first,
 * before the finishes (a finish may make its material double-sided again, as the
 * Randolph wing's does). A material shared with a two-sided part stays two-sided.
 * Returns how many materials it changed.
 */
export function cullHiddenFaces(root: THREE.Object3D): number {
  const keep = new Set<THREE.Material>();
  const solid = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) (isSolidPart(mesh) ? solid : keep).add(m);
  });
  let n = 0;
  for (const m of solid) {
    if (keep.has(m) || m.side !== THREE.DoubleSide) continue;
    m.side = THREE.FrontSide;
    m.needsUpdate = true;
    n++;
  }
  return n;
}
