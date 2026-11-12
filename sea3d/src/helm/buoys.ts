// The practice course's marks in the 3D view (Rosa): plain racing buoys, orange for the
// marks to round and yellow for the start and finish. Iris may dress them up; Thomas Point
// Light is her model, so the run to it has no buoy.

import * as THREE from "three";

const MARK = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6 });
const FINISH = new THREE.MeshStandardMaterial({ color: 0xffd23a, roughness: 0.6 });
// A tall inflatable racing mark: about 1.5 m across and 2 m out of the water, so it shows at 800 m.
const BODY = new THREE.CylinderGeometry(0.55, 0.75, 2.2, 20);
BODY.translate(0, 0.9, 0);
const TOP = new THREE.ConeGeometry(0.55, 0.6, 20);
TOP.translate(0, 2.3, 0);

export class Buoys {
  readonly group = new THREE.Group();
  private marks: { x: number; y: number; mesh: THREE.Group }[] = [];

  constructor() {
    this.group.name = "practice-buoys";
  }

  /** The marks, metres east and north of the spell's start; the last is the finish (yellow). */
  set(xy: { x: number; y: number }[]): void {
    for (const m of this.marks) this.group.remove(m.mesh);
    this.marks = xy.map((p, i) => {
      const mat = i === xy.length - 1 && xy.length > 1 ? FINISH : MARK;
      const mesh = new THREE.Group();
      mesh.add(new THREE.Mesh(BODY, mat), new THREE.Mesh(TOP, mat));
      this.group.add(mesh);
      return { ...p, mesh };
    });
    this.group.visible = this.marks.length > 0;
  }

  /** Keep them in place as the boat (at the origin) sails: x east, z south. */
  update(boat: { x: number; y: number }, t: number): void {
    for (const [i, m] of this.marks.entries()) {
      m.mesh.position.set(m.x - boat.x, Math.sin(t * 1.3 + i) * 0.15 - 0.3, -(m.y - boat.y));
      m.mesh.rotation.z = Math.sin(t * 0.9 + i * 2) * 0.06;
      // A real mark is a speck at 800 m; drawn bigger with distance so you can steer for it (game feel).
      m.mesh.scale.setScalar(Math.max(1, Math.hypot(m.x - boat.x, m.y - boat.y) / 200));
    }
  }
}
