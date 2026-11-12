// The practice course's marks in the 3D view. Rosa placed them (course.ts); Sam made them
// float like the real thing (backlog item 1, Elena 12 Nov). Orange for the marks to round,
// yellow for the start and finish. Thomas Point Light is Iris's model, so the run to it has no buoy.
//
// A sailor's checklist for an inflatable racing mark (sailor-realism-checklist.md):
//   * real size, about 1.5 m across and 2 m out of the water; a speck at 800 m, which is
//     why the page shows a small distance tag and an edge arrow instead of drawing it bigger;
//   * it rides the waves: height and tilt from the sea under it, a beat behind the water
//     (it has mass and drag), never level on a slope;
//   * it is anchored, so the wind pushes it over against its line: a lean of a few degrees
//     downwind, more in a breeze;
//   * a darker wet band at the waterline, where it is always awash.

import * as THREE from "three";
import { heightAt, type WaveComponent } from "../waves";

const MARK = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.65 });
const FINISH = new THREE.MeshStandardMaterial({ color: 0xffd23a, roughness: 0.65 });
const WET = new THREE.MeshStandardMaterial({ color: 0x5a3a2a, roughness: 0.35, transparent: true, opacity: 0.55 });

/** How deep the mark floats (m): the bottom of the body is this far under the surface. GUESS */
export const DRAFT_M = 0.35;
/** Body: 1.5 m across at the water, tapering a little, 2 m out of the water plus the draft. */
const BODY = new THREE.CylinderGeometry(0.55, 0.75, 2.0 + DRAFT_M, 24);
BODY.translate(0, (2.0 + DRAFT_M) / 2, 0);
const TOP = new THREE.SphereGeometry(0.55, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
TOP.translate(0, 2.0 + DRAFT_M, 0);
/** The wet band: a slightly fatter ring from just under to 0.25 m over the waterline. */
const BAND = new THREE.CylinderGeometry(0.735, 0.765, 0.35, 24, 1, true);
BAND.translate(0, DRAFT_M + 0.075, 0);

/** Lean from the wind (degrees) at a wind speed (m/s): ~3 deg in a light air, up to 15 in a gale. GUESS */
export function windLeanDeg(windMs: number): number {
  return Math.min(15, 3 + 0.6 * Math.max(0, windMs));
}
/** How fast the mark follows the water: time constants (s) for heave and tilt. GUESS */
const HEAVE_TAU = 0.25;
const TILT_TAU = 0.6;
/** Half the span (m) over which the water's slope is read: about the mark's own width. */
const SLOPE_HALF_M = 0.75;

interface Mark {
  x: number;
  y: number;
  mesh: THREE.Group;
  /** Filtered heave and tilt (radians about x and z), so it lags the water. */
  h: number | null;
  tx: number;
  tz: number;
}

export class Buoys {
  readonly group = new THREE.Group();
  private marks: Mark[] = [];
  private lastT: number | null = null;

  constructor() {
    this.group.name = "practice-buoys";
  }

  /** The marks, metres east and north of the spell's start; the last is the finish (yellow). */
  set(xy: { x: number; y: number }[]): void {
    for (const m of this.marks) this.group.remove(m.mesh);
    this.marks = xy.map((p, i) => {
      const mat = i === xy.length - 1 && xy.length > 1 ? FINISH : MARK;
      const mesh = new THREE.Group();
      mesh.add(new THREE.Mesh(BODY, mat), new THREE.Mesh(TOP, mat), new THREE.Mesh(BAND, WET));
      this.group.add(mesh);
      return { ...p, mesh, h: null, tx: 0, tz: 0 };
    });
    this.group.visible = this.marks.length > 0;
    this.lastT = null;
  }

  /** Where each mark is in the scene (x east, z south of the boat), for the page's tags. */
  positions(boat: { x: number; y: number }): THREE.Vector3[] {
    return this.marks.map((m) => new THREE.Vector3(m.x - boat.x, 1.2, -(m.y - boat.y)));
  }

  /**
   * Keep them in place as the boat (at the origin) sails, x east and z south, riding the sea.
   * next: the mark sailed for now (Rosa): rounded marks go, and the finish (where she starts)
   * shows once the first mark is rounded, so it doesn't sit against her hull at the start.
   * comps: the live wave trains (the same sea that floats the boat). windU/windV: the wind
   * blowing TOWARD east/north (m/s), which leans the marks over against their lines.
   */
  update(boat: { x: number; y: number }, t: number, next = 0, comps?: WaveComponent[], windU = 0, windV = 0): void {
    const dt = this.lastT == null ? 0 : Math.min(0.25, Math.max(0, t - this.lastT));
    this.lastT = t;
    const kH = dt > 0 ? 1 - Math.exp(-dt / HEAVE_TAU) : 1;
    const kT = dt > 0 ? 1 - Math.exp(-dt / TILT_TAU) : 1;
    const w = Math.hypot(windU, windV);
    const lean = THREE.MathUtils.degToRad(windLeanDeg(w));
    // Tilt toward the downwind side: wind toward +x (east) tips the top to +x, a rotation about -z;
    // wind toward north (scene -z) tips the top to -z, a rotation about -x.
    const leanZ = w > 0 ? (-lean * windU) / w : 0;
    const leanX = w > 0 ? (-lean * windV) / w : 0;
    for (const [i, m] of this.marks.entries()) {
      const last = i === this.marks.length - 1 && this.marks.length > 1;
      m.mesh.visible = i >= next && (!last || next >= 1);
      const x = m.x - boat.x;
      const z = -(m.y - boat.y);
      let h = 0;
      let sx = 0;
      let sz = 0;
      if (comps && comps.length) {
        h = heightAt(comps, x, z, t);
        sx = (heightAt(comps, x + SLOPE_HALF_M, z, t) - heightAt(comps, x - SLOPE_HALF_M, z, t)) / (2 * SLOPE_HALF_M);
        sz = (heightAt(comps, x, z + SLOPE_HALF_M, t) - heightAt(comps, x, z - SLOPE_HALF_M, t)) / (2 * SLOPE_HALF_M);
      }
      // Lie with the water's surface: a slope rising to +x tilts the top toward -x.
      const wantZ = Math.atan(sx) + leanZ;
      const wantX = -Math.atan(sz) + leanX;
      m.h = m.h == null ? h : m.h + (h - m.h) * kH;
      m.tx += (wantX - m.tx) * kT;
      m.tz += (wantZ - m.tz) * kT;
      m.mesh.position.set(x, m.h - DRAFT_M, z);
      m.mesh.rotation.set(m.tx, 0, m.tz);
    }
  }
}
