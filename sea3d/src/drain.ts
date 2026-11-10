// Water pouring off the deck after a knockdown: when the boat has been rolled
// past its beam ends and comes back up, the water it scooped runs off both
// sides of the deck in sheets and drops. Particles, a few seconds' worth.
// Cosmetic: the trigger is the drawn boat's own roll, not the log.

import * as THREE from "three";
import type { HullForm } from "./boats/parts";
import type { BoatSpec } from "./boats/specs";

const N = 2400; // drops in flight at most
const LIFE = 2.6; // s a drop lives
const G = 9.81;

const vert = /* glsl */ `
attribute float aAge;   // 0..1 of its life, or > 1 when spent
attribute float aSize;
uniform float uScale;
varying float vAge;
void main() {
  vAge = aAge;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aAge > 1.0 ? 0.0 : aSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const frag = /* glsl */ `
uniform vec3 uColor;
varying float vAge;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);
  if (r > 0.2 || vAge > 1.0) discard;
  float a = (1.0 - vAge) * 0.85 * (1.0 - 4.0 * r);
  gl_FragColor = vec4(uColor, a);
}`;

// Streaks: each drop also draws its path over a short exposure, so the falling water reads as sheets.
const streakVert = /* glsl */ `
attribute float aAge;
attribute float aEnd;   // 0 = the drop, 1 = the tail
varying float vA;
void main() {
  vA = aAge > 1.0 ? 0.0 : (1.0 - aAge) * (1.0 - aEnd);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const streakFrag = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  if (vA < 0.01) discard;
  gl_FragColor = vec4(uColor, 0.75 * vA);
}`;
const TAIL = 0.07; // s of motion a streak shows

export class Drain {
  /** Drops and their streaks; add this to the scene. */
  readonly group = new THREE.Group();
  readonly points: THREE.Points;
  private streaks: THREE.LineSegments;
  private sPos = new Float32Array(N * 6);
  private sAge = new Float32Array(N * 2).fill(2);
  private sMat: THREE.ShaderMaterial;
  private pos = new Float32Array(N * 3);
  private vel = new Float32Array(N * 3);
  private age = new Float32Array(N).fill(2);
  private size = new Float32Array(N);
  private next = 0;
  private pouring = 0; // s of pouring left
  private wasOver = false;
  private mat: THREE.ShaderMaterial;
  /** Seconds since the last knockdown drained (for the wet look); Infinity if none. */
  sinceDrain = Infinity;
  /** Knockdowns drained so far. */
  count = 0;
  private edge: THREE.Vector3[] = []; // deck-edge points, boat frame

  constructor(form: HullForm, spec: BoatSpec) {
    // Deck edges, both sides, in the boat frame (builder frame: x aft from the bow, z to port; see model.ts frame()).
    for (let i = 1; i < 24; i++) {
      const s = 0.08 + (0.86 * i) / 24;
      const xb = s * form.L;
      for (const side of [1, -1]) {
        const zb = side * form.hb(s) * 0.97;
        this.edge.push(new THREE.Vector3(spec.cgX - xb, form.dz(s) + spec.cgBelowWaterline - spec.waterline, -zb));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("aAge", new THREE.BufferAttribute(this.age, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uScale: { value: 300 }, uColor: { value: new THREE.Color(0xe8f2f8) } },
      transparent: true,
      // Drawn before the sea and writing depth, so a crest in front hides a drop
      // but the sea's own depth never hides drops that are above it.
      depthWrite: true,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 9;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(this.sPos, 3));
    sg.setAttribute("aAge", new THREE.BufferAttribute(this.sAge, 1));
    sg.setAttribute("aEnd", new THREE.BufferAttribute(new Float32Array(N * 2).map((_, i) => i % 2), 1));
    this.sMat = new THREE.ShaderMaterial({
      vertexShader: streakVert,
      fragmentShader: streakFrag,
      uniforms: { uColor: this.mat.uniforms.uColor },
      transparent: true,
      depthWrite: false,
    });
    this.streaks = new THREE.LineSegments(sg, this.sMat);
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 12;
    this.group.add(this.points, this.streaks);
  }

  /** Start pouring now (also called by the roll watcher). */
  pour(seconds = 2.2): void {
    this.pouring = seconds;
    this.sinceDrain = 0;
    this.count++;
  }

  /**
   * Per frame. roll in radians (the drawn boat's), boat = its root group (world
   * pose), light 0..1, viewport height in pixels (sizes the drops).
   */
  update(dt: number, roll: number, boat: THREE.Object3D, light: number, viewH: number): void {
    // Watch for a knockdown: rolled past ~70 degrees, then back under ~30.
    const over = Math.abs(roll) > 1.2;
    if (over) this.wasOver = true;
    else if (this.wasOver && Math.abs(roll) < 0.5) {
      this.wasOver = false;
      this.pour();
    }
    this.sinceDrain += dt;
    // New drops from the deck edges, fewer as the deck empties.
    if (this.pouring > 0) {
      const rate = 2600 * Math.min(1, this.pouring / 1.2);
      let k = Math.round(rate * dt);
      boat.updateMatrixWorld();
      const q = boat.getWorldQuaternion(new THREE.Quaternion());
      const p = new THREE.Vector3();
      const out = new THREE.Vector3();
      while (k-- > 0) {
        const e = this.edge[(Math.random() * this.edge.length) | 0];
        p.copy(e);
        // Off the side it sits on, a little outwards and down.
        out.set(0, -0.3, Math.sign(e.z) * (0.5 + Math.random() * 0.9)).applyQuaternion(q);
        boat.localToWorld(p);
        const i = this.next;
        this.next = (this.next + 1) % N;
        this.pos.set([p.x, p.y, p.z], i * 3);
        this.vel.set([out.x + (Math.random() - 0.5) * 0.3, out.y, out.z + (Math.random() - 0.5) * 0.3], i * 3);
        this.age[i] = 0;
        this.size[i] = 0.018 + Math.random() * 0.032;
      }
      this.pouring -= dt;
    }
    // Fall under gravity; spent drops stop drawing.
    let live = false;
    for (let i = 0; i < N; i++) {
      if (this.age[i] > 1) continue;
      live = true;
      this.age[i] += dt / LIFE;
      this.vel[i * 3 + 1] -= G * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < -0.4) this.age[i] = 2; // into the sea
      for (let c = 0; c < 3; c++) {
        this.sPos[i * 6 + c] = this.pos[i * 3 + c];
        this.sPos[i * 6 + 3 + c] = this.pos[i * 3 + c] - this.vel[i * 3 + c] * TAIL;
      }
      this.sAge[i * 2] = this.sAge[i * 2 + 1] = this.age[i];
    }
    this.group.visible = live;
    if (!live) return;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aAge.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    this.streaks.geometry.attributes.position.needsUpdate = true;
    this.streaks.geometry.attributes.aAge.needsUpdate = true;
    this.mat.uniforms.uScale.value = viewH;
    this.mat.uniforms.uColor.value.setScalar(0.35 + 0.6 * light).multiply(new THREE.Color(0xe8f2f8));
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
    this.streaks.geometry.dispose();
    this.sMat.dispose();
  }
}
