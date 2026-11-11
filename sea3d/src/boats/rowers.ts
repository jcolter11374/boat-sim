// The crew at the oars of a rowing boat: simple figures that row in time,
// sliding on their seats, swinging their bodies and pulling the oars through
// the water, the blades lifted clear on the way back. Built in code on any
// model that has the named parts (blender/build_stock.py rower):
//   seat_<n> (empty on the seat's slide), oar_<n>_p / oar_<n>_s (empties at the
//   oar gates, the oars lying square across the boat).
// When nobody rows (stopped, or lying to the para-anchor) the rowers are below
// in the cabins and the oars rest, blades up. Cosmetic only. Builder frame:
// x aft from the bow, y up, z to port. Rowers face aft, like every rower.

import * as THREE from "three";

/** Strokes a second, a steady ocean pace (about 24 a minute). */
export const STROKE_RATE = 0.4;
/** Share of each stroke spent pulling (the blade in the water). */
const DRIVE = 0.4;
/** Seat to footplate, along the boat (blender/build_stock.py ROWER_STATIONS). */
const FOOT_DX = 0.9;
/** The oar handle from its gate, in the oar's own frame at rest (inboard 0.92 m along (0, -0.18, side)). */
const INBOARD = 0.92;

/** One stroke at phase p (0..1): oar sweep (rad, + blade aft), blade dip (rad, + down into the water),
 * seat travel (m aft), body lean (rad, + towards the stern). */
export function stroke(p: number): { sweep: number; dip: number; seat: number; lean: number } {
  const ease = (u: number) => 0.5 - 0.5 * Math.cos(Math.PI * THREE.MathUtils.clamp(u, 0, 1));
  // 0 at the catch (reached forward to the stern, blade towards the bow), 1 at the finish.
  const k = p < DRIVE ? ease(p / DRIVE) : 1 - ease((p - DRIVE) / (1 - DRIVE));
  const inWater = p < DRIVE ? Math.min(1, p / 0.04, (DRIVE - p) / 0.04) : 0;
  return {
    sweep: -0.6 + 1.05 * k,
    dip: inWater > 0 ? 0.07 * inWater : -0.05,
    seat: 0.5 * (1 - k),
    lean: 0.35 - 0.6 * k,
  };
}

/** Knee or elbow for a two-bone limb from a to c, bending towards `pole`. */
function joint(a: THREE.Vector3, c: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const ac = new THREE.Vector3().subVectors(c, a);
  const d = THREE.MathUtils.clamp(ac.length(), 1e-3, l1 + l2 - 1e-3);
  ac.normalize();
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const up = Math.sqrt(Math.max(l1 * l1 - along * along, 0));
  const side = pole.clone().addScaledVector(ac, -pole.dot(ac)).normalize();
  return out.copy(a).addScaledVector(ac, along).addScaledVector(side, up);
}

const Y = new THREE.Vector3(0, 1, 0);

/** Stretch a unit cylinder (1 m tall along y, centred) between two points. */
function limb(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, r: number): void {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(Y, d.divideScalar(Math.max(len, 1e-6)));
  m.scale.set(r, len, r);
}

interface Station {
  seat: THREE.Object3D;
  seatX: number;
  oars: { pivot: THREE.Object3D; side: number }[];
  body: THREE.Group;
  torso: THREE.Mesh;
  head: THREE.Mesh;
  limbs: THREE.Mesh[]; // thighs, shins, upper arms, forearms (port then starboard)
}

const JACKETS = [0xd8432b, 0xf2b33d, 0x2f6fa8, 0xe8590c];

export class Rowers {
  private readonly stations: Station[] = [];
  private readonly owned: { dispose(): void }[] = [];
  private row = 0; // 0 resting .. 1 rowing, eased
  private phase = 0;
  /** What the crew is doing (for the smoke test). */
  readonly shown = { rowing: false, stations: 0 };

  private constructor(g: THREE.Object3D) {
    const cyl = this.keep(new THREE.CylinderGeometry(1, 1, 1, 10));
    const ball = this.keep(new THREE.SphereGeometry(1, 14, 10));
    const skin = this.keep(new THREE.MeshStandardMaterial({ color: 0xc89f82, roughness: 0.7 }));
    const legs = this.keep(new THREE.MeshStandardMaterial({ color: 0x2b3036, roughness: 0.8 }));
    for (let n = 1; ; n++) {
      const seat = g.getObjectByName(`seat_${n}`);
      const port = g.getObjectByName(`oar_${n}_p`);
      const stbd = g.getObjectByName(`oar_${n}_s`);
      if (!seat || !port || !stbd) break;
      const jacket = this.keep(new THREE.MeshStandardMaterial({ color: JACKETS[(n - 1) % JACKETS.length], roughness: 0.55 }));
      const body = new THREE.Group();
      body.name = `rower_${n}`;
      const mk = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
        const m = new THREE.Mesh(geo, mat);
        body.add(m);
        return m;
      };
      const torso = mk(cyl, jacket);
      const head = mk(ball, skin);
      head.scale.setScalar(0.11);
      const limbs = [mk(cyl, legs), mk(cyl, legs), mk(cyl, legs), mk(cyl, legs), mk(cyl, jacket), mk(cyl, skin), mk(cyl, jacket), mk(cyl, skin)];
      (seat.parent ?? g).add(body);
      this.stations.push({
        seat,
        seatX: seat.position.x,
        oars: [
          { pivot: port, side: 1 },
          { pivot: stbd, side: -1 },
        ],
        body,
        torso,
        head,
        limbs,
      });
    }
    this.shown.stations = this.stations.length;
  }

  /** The crew for a model, or null when it has no rowing stations. */
  static find(g: THREE.Object3D): Rowers | null {
    const r = new Rowers(g);
    if (r.stations.length) return r;
    r.dispose();
    return null;
  }

  private keep<T extends { dispose(): void }>(x: T): T {
    this.owned.push(x);
    return x;
  }

  /** speed: through the water over cruising speed; nobody rows below about a third of it. */
  update(dt: number, speed: number): void {
    const rowing = speed > 0.3;
    this.shown.rowing = rowing;
    this.row += ((rowing ? 1 : 0) - this.row) * Math.min(1, dt * 1.5);
    this.phase = (this.phase + dt * STROKE_RATE * (0.85 + 0.15 * Math.min(speed, 1.2))) % 1;
    const s = stroke(this.phase);
    const w = this.row;
    const sweep = s.sweep * w;
    const dip = s.dip * w - 0.08 * (1 - w); // at rest the blades are up clear of the water
    const hip = new THREE.Vector3();
    const sh = new THREE.Vector3();
    const foot = new THREE.Vector3();
    const hand = new THREE.Vector3();
    const mid = new THREE.Vector3();
    for (const st of this.stations) {
      st.seat.position.x = st.seatX + s.seat * w;
      for (const o of st.oars) o.pivot.rotation.set(o.side * dip, o.side * sweep, 0, "YXZ");
      // Below in the cabin when not rowing.
      st.body.visible = w > 0.5;
      if (!st.body.visible) continue;
      st.body.updateMatrixWorld();
      const y = st.seat.position.y;
      hip.set(st.seat.position.x, y + 0.13, 0);
      const lean = s.lean * w;
      sh.set(hip.x + Math.sin(lean) * 0.52, hip.y + Math.cos(lean) * 0.52, 0);
      limb(st.torso, hip, sh, 0.15);
      st.head.position.set(sh.x + Math.sin(lean) * 0.2, sh.y + Math.cos(lean) * 0.2, 0);
      for (const [i, o] of st.oars.entries()) {
        const z = o.side * 0.1;
        // Legs: hip to the footplate, knees up.
        foot.set(st.seatX + FOOT_DX - 0.1, y - 0.02, z);
        const h = hip.clone().setZ(z);
        joint(h, foot, 0.46, 0.46, new THREE.Vector3(0.2, 1, 0), mid);
        limb(st.limbs[i * 2], h, mid, 0.07);
        limb(st.limbs[i * 2 + 1], mid, foot, 0.055);
        // Arms: shoulder to the oar's handle, elbows out and down.
        const p = o.pivot;
        hand.set(0, 0.18 * INBOARD, -o.side * INBOARD).applyEuler(p.rotation).add(p.position);
        const s0 = sh.clone().setZ(o.side * 0.19).addScaledVector(Y, -0.06);
        joint(s0, hand, 0.3, 0.32, new THREE.Vector3(-0.3, -1, o.side), mid);
        limb(st.limbs[4 + i * 2], s0, mid, 0.05);
        limb(st.limbs[5 + i * 2], mid, hand, 0.04);
      }
    }
  }

  dispose(): void {
    for (const st of this.stations) st.body.removeFromParent();
    this.owned.forEach((x) => x.dispose());
  }
}
