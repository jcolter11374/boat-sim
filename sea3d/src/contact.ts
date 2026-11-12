// Where the boat meets the water: a foam collar hugging the hull at the
// waterline, and spray thrown up when the bow drops into a wave. Cosmetic;
// driven only by the boat's logged speed, the logged sea (through the wave
// components) and the motion model's pose, so it never disagrees with the log.

import * as THREE from "three";
import { FOAM_LAMP_GLSL, FOAM_LAMP_UNIFORMS } from "./boats/navlights";
import type { HullForm, Quality } from "./boats/parts";
import type { BoatSpec } from "./boats/specs";
import { toWorld, type Placement } from "./standin";
import { heightAt, type WaveComponent } from "./waves";
import { WashSlot } from "./boatWash";
import { putInWater } from "./boats/inWater";

const N_SIDE = 40; // outline points per side

const collarVert = /* glsl */ `
  attribute vec2 aUV; // x along the hull (0 bow .. 1 stern), y across (0 hull .. 1 outer edge)
  varying vec2 vUV;
  varying vec3 vW;
  void main() {
    vUV = aUV;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const collarFrag = /* glsl */ `
  ${FOAM_LAMP_GLSL}
  uniform float uTime;
  uniform float uFlow;  // water distance run, m (foam streams aft with it)
  uniform float uI;     // strength 0..1
  uniform float uLight;
  uniform vec2 uDir;    // boat's forward direction in world xz
  varying vec2 vUV;
  varying vec3 vW;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  void main() {
    // Foam texture in the boat's own frame, moving aft as the water goes past.
    vec2 side = vec2(-uDir.y, uDir.x);
    vec2 q = vec2(dot(vW.xz, uDir) + uFlow, dot(vW.xz, side));
    float n = vnoise(q * vec2(7.0, 11.0) + uTime * 0.3) * 0.55 + vnoise(q * vec2(19.0, 27.0) - uTime * 0.5) * 0.3
            + vnoise(q * 3.0) * 0.15;
    float edge = 1.0 - smoothstep(0.0, 1.0, vUV.y);           // thick at the hull, thin outside
    float bow = 1.0 + 0.8 * (1.0 - smoothstep(0.0, 0.25, vUV.x)); // more at the bow
    float a = smoothstep(0.55 - 0.45 * edge * uI * bow, 0.75, n) * edge * edge * uI;
    // Thick at the bow, thinning aft and breaking into patches with gaps (Elena, WIP 2).
    float aft = smoothstep(0.15, 0.9, vUV.x);
    float gaps = smoothstep(0.3, 0.6, vnoise(q * vec2(0.9, 2.5) + 3.7));
    a *= mix(1.0, gaps, aft) * (1.0 - 0.45 * aft);
    gl_FragColor = vec4(vec3(0.95, 0.97, 1.0) * (uLight + foamLamp(vW)), clamp(a, 0.0, 0.9));
  }
`;

const sprayVert = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  varying float vAlpha;
  varying vec3 vW;
  void main() {
    vAlpha = aAlpha;
    vW = (modelMatrix * vec4(position, 1.0)).xyz;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (320.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const sprayFrag = /* glsl */ `
  ${FOAM_LAMP_GLSL}
  uniform float uLight;
  varying float vAlpha;
  varying vec3 vW;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = dot(d, d) * 4.0;
    if (r > 1.0) discard;
    gl_FragColor = vec4(vec3(0.93, 0.96, 1.0) * (uLight + foamLamp(vW)), vAlpha * (1.0 - r));
  }
`;

const SPRAY: Record<Quality, number> = { low: 0, high: 220 };
const SPRAY_LIFE = 1.3; // s

/** What the boat is doing this frame. */
export interface ContactState {
  speed: number; // m/s through the water (logged)
  /** Bow height above the water surface under it, m (from the motion model's pose). */
  bowClearance: number;
  light: number; // 0..1 for unlit foam
}

export class Contact {
  /** How hard the bow dropped into the water this frame, 0..1 (0 most frames). */
  splash = 0;
  readonly collar: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly spray: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Outline points in the boat frame (x ahead, z starboard), bow -> stern on starboard, then back on port. */
  private readonly ring: [number, number][] = [];
  private readonly normals: [number, number][] = [];
  private readonly along: number[] = [];
  private flow = 0;
  private lastT = -1;
  private lastClear = 0;
  // spray pool, boat frame x/z with world y
  private readonly n: number;
  private readonly sp: Float32Array; // x, y, z
  private readonly sv: Float32Array; // vx, vy, vz
  private readonly born: Float32Array;
  private next = 0;
  /** For the test hook: how much is showing. */
  readonly shown = { collar: 0, spray: 0 };

  /** This hull's bow wave and wash in the sea (boatWash.ts), and its wet line (boats/inWater.ts). */
  private readonly wash: WashSlot | null;
  private readonly water: ReturnType<typeof putInWater> | null;
  private wlMid = 0;
  private wlLength = 0;
  private wlHalfBeam = 0;

  /** root: the boat's model, to put its hull materials in the water (wet line, nothing
   *  showing below the surface). Without it only the foam collar and spray are drawn. */
  constructor(form: HullForm, spec: BoatSpec, quality: Quality, root?: THREE.Object3D) {
    // Waterline outline from the hull form (same maths as parts.ts hull()):
    // at height wl the half-width is b (1 - (1 - t)^n)^(1/n), t = (wl - kz) / (dz - kz).
    const side: [number, number, number][] = []; // builder x, half-width, s
    for (let i = 0; i <= N_SIDE; i++) {
      const s = i / N_SIDE;
      const kz = form.kz(s);
      const dz = form.dz(s);
      const b = form.hb(s);
      if (form.wl <= kz || dz <= kz) continue; // hull clear of the water here (raked bow)
      const t = Math.min((form.wl - kz) / (dz - kz), 1);
      side.push([s * form.L, b * Math.pow(1 - Math.pow(1 - t, form.n), 1 / form.n), s]);
    }
    // Builder x (aft from the bow) -> boat frame x (ahead of the CG); starboard is +z.
    const bx = (x: number) => spec.cgX - x;
    for (const [x, w, s] of side) {
      this.ring.push([bx(x), w]);
      this.along.push(s);
    }
    for (let i = side.length - 1; i >= 0; i--) {
      const [x, w, s] = side[i];
      this.ring.push([bx(x), -w]);
      this.along.push(s);
    }
    const xs = this.ring.map(([x]) => x);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    this.wlMid = (lo + hi) / 2;
    this.wlLength = hi - lo;
    this.wlHalfBeam = Math.max(...this.ring.map(([, w]) => Math.abs(w)));
    this.wash = WashSlot.take();
    this.water = root ? putInWater(root) : null;
    const m = this.ring.length;
    for (let i = 0; i < m; i++) {
      const a = this.ring[(i - 1 + m) % m];
      const b = this.ring[(i + 1) % m];
      const tx = b[0] - a[0];
      const tz = b[1] - a[1];
      const l = Math.hypot(tx, tz) || 1;
      let nx = tz / l;
      let nz = -tx / l;
      // Point outward (away from the hull's middle line).
      const p = this.ring[i];
      if (nz * p[1] < 0 || (Math.abs(p[1]) < 1e-3 && nx * (p[0] - (spec.cgX - form.L / 2)) < 0)) {
        nx = -nx;
        nz = -nz;
      }
      this.normals.push([nx, nz]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(m * 2 * 3), 3));
    const uv = new Float32Array(m * 4);
    for (let i = 0; i < m; i++) uv.set([this.along[i], 0, this.along[i], 1], i * 4);
    geo.setAttribute("aUV", new THREE.BufferAttribute(uv, 2));
    const idx: number[] = [];
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      idx.push(i * 2, j * 2, i * 2 + 1, j * 2, j * 2 + 1, i * 2 + 1);
    }
    geo.setIndex(idx);
    this.collar = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: collarVert,
        fragmentShader: collarFrag,
        uniforms: { uTime: { value: 0 }, uFlow: { value: 0 }, uI: { value: 0 }, uLight: { value: 1 }, uDir: { value: new THREE.Vector2(1, 0) }, ...FOAM_LAMP_UNIFORMS },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.collar.frustumCulled = false;
    this.collar.renderOrder = 11; // over the sea, like the wake
    this.collar.name = "foam_collar";

    this.n = SPRAY[quality];
    this.sp = new Float32Array(this.n * 3);
    this.sv = new Float32Array(this.n * 3);
    this.born = new Float32Array(this.n).fill(-99);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    sg.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(this.n), 1));
    sg.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(this.n), 1));
    this.spray = new THREE.Points(
      sg,
      new THREE.ShaderMaterial({ vertexShader: sprayVert, fragmentShader: sprayFrag, uniforms: { uLight: { value: 1 }, ...FOAM_LAMP_UNIFORMS }, transparent: true, depthWrite: false }),
    );
    this.spray.frustumCulled = false;
    this.spray.renderOrder = 12;
    this.spray.name = "bow_spray";
    this.bowX = this.ring[0][0];
    this.beam = Math.max(...this.ring.map((p) => Math.abs(p[1]))) * 2;
    this.spec = spec;
  }

  private readonly bowX: number;
  private readonly beam: number;
  private readonly spec: BoatSpec;

  /** Bow point in the boat frame (x ahead, z starboard), for the bow clearance. */
  get bow(): [number, number] {
    return [this.bowX, 0];
  }

  update(comps: WaveComponent[], t: number, place: Placement, hs: number, s: ContactState): void {
    const dt = this.lastT < 0 ? 0 : THREE.MathUtils.clamp(t - this.lastT, 0, 0.1);
    this.lastT = t;
    this.flow += s.speed * dt;
    const speedK = THREE.MathUtils.clamp(s.speed / Math.max(this.spec.cruiseSpeed, 0.3), 0, 1.6);
    const seaK = THREE.MathUtils.clamp(hs / 4, 0, 1);

    // Collar: inner edge just inside the hull, outer edge pushed out more at the
    // bow and with speed; every point sits on the sea surface under it.
    const pos = this.collar.geometry.attributes.position.array as Float32Array;
    const m = this.ring.length;
    for (let i = 0; i < m; i++) {
      const [x, z] = this.ring[i];
      const [nx, nz] = this.normals[i];
      const sAlong = this.along[i];
      const bowK = 1 - THREE.MathUtils.smoothstep(sAlong, 0, 0.35);
      const w = 0.06 + 0.1 * speedK + 0.12 * bowK * speedK + 0.08 * seaK;
      for (const [k, off] of [[0, -0.015], [1, w]] as const) {
        const [wx, wz] = toWorld(x + nx * off, z + nz * off, place);
        const o = (i * 2 + k) * 3;
        pos[o] = wx;
        pos[o + 1] = heightAt(comps, wx, wz, t) + 0.015;
        pos[o + 2] = wz;
      }
    }
    this.collar.geometry.attributes.position.needsUpdate = true;
    const u = this.collar.material.uniforms;
    u.uTime.value = t;
    u.uFlow.value = this.flow;
    u.uI.value = THREE.MathUtils.clamp(0.25 + 0.45 * speedK + 0.3 * seaK, 0, 1);
    u.uLight.value = s.light;
    u.uDir.value.set(Math.cos(place.yaw), -Math.sin(place.yaw));
    this.shown.collar = u.uI.value;

    // The bow wave and wash in the sea, and the wet line on the hull, from the same speed and sea.
    const [cx, cz] = toWorld(this.wlMid, 0, place);
    this.wash?.set(cx, cz, place.yaw, this.wlLength, 2 * this.wlHalfBeam, s.speed, THREE.MathUtils.clamp(0.2 * seaK + 0.7 * Math.min(speedK, 1.2), 0, 1));
    this.water?.update({ wetH: 0.03 + 0.03 * Math.min(speedK, 1.2) + 0.05 * seaK, foam: THREE.MathUtils.clamp(0.3 + 0.4 * speedK + 0.3 * seaK, 0, 1), light: s.light });

    // Spray: when the bow drops into the water fast, throw a sheet of drops out
    // to both sides; a little steady spray at speed in a rough sea.
    this.splash = 0;
    if (this.n > 0) {
      const sink = dt > 0 ? (this.lastClear - s.bowClearance) / dt : 0; // m/s the bow is going down into the water
      this.lastClear = s.bowClearance;
      let burst = 0;
      if (s.bowClearance < 0.04 && sink > 0.35) burst = Math.min(40, Math.round((sink - 0.35) * 45 * (0.5 + speedK)));
      this.splash = burst / 40; // for the sound of the slap (sound.ts), in step with the spray
      const steady = speedK * seaK * 25 * dt; // drops per frame
      const emit = burst + (Math.random() < steady % 1 ? Math.ceil(steady) : Math.floor(steady));
      const [bx, bz] = this.bow;
      for (let e = 0; e < emit; e++) {
        const i = this.next;
        this.next = (this.next + 1) % this.n;
        const sideSign = Math.random() < 0.5 ? -1 : 1;
        const back = Math.random() * 0.25 * this.spec.length;
        this.sp[i * 3] = bx - back;
        this.sp[i * 3 + 2] = bz + sideSign * (this.beam * 0.3 * Math.min(1, back * 4 + 0.2));
        const [wx, wz] = toWorld(this.sp[i * 3], this.sp[i * 3 + 2], place);
        this.sp[i * 3 + 1] = heightAt(comps, wx, wz, t) + 0.02;
        const power = 0.6 + Math.min(sink, 2.5) * 0.8 + 0.6 * speedK;
        this.sv[i * 3] = -s.speed * 0.4 + (Math.random() - 0.5) * 0.4; // drops fall behind as the boat moves on
        this.sv[i * 3 + 1] = power * (0.8 + 0.6 * Math.random());
        this.sv[i * 3 + 2] = sideSign * power * (0.6 + 0.8 * Math.random());
        this.born[i] = t;
      }
      const ppos = this.spray.geometry.attributes.position.array as Float32Array;
      const alpha = this.spray.geometry.attributes.aAlpha.array as Float32Array;
      const size = this.spray.geometry.attributes.aSize.array as Float32Array;
      let live = 0;
      for (let i = 0; i < this.n; i++) {
        const age = t - this.born[i];
        if (age < 0 || age > SPRAY_LIFE) {
          alpha[i] = 0;
          continue;
        }
        this.sv[i * 3 + 1] -= 9.81 * dt;
        this.sp[i * 3] += this.sv[i * 3] * dt - s.speed * dt; // the water (and drops) slide aft past the boat
        this.sp[i * 3 + 1] += this.sv[i * 3 + 1] * dt;
        this.sp[i * 3 + 2] += this.sv[i * 3 + 2] * dt;
        const [wx, wz] = toWorld(this.sp[i * 3], this.sp[i * 3 + 2], place);
        ppos[i * 3] = wx;
        ppos[i * 3 + 1] = this.sp[i * 3 + 1];
        ppos[i * 3 + 2] = wz;
        const k = age / SPRAY_LIFE;
        alpha[i] = 0.8 * (1 - k) * Math.min(1, age * 10);
        size[i] = 0.035 + 0.09 * k;
        live++;
      }
      this.spray.geometry.attributes.position.needsUpdate = true;
      this.spray.geometry.attributes.aAlpha.needsUpdate = true;
      this.spray.geometry.attributes.aSize.needsUpdate = true;
      this.spray.material.uniforms.uLight.value = s.light;
      this.shown.spray = live;
    }
  }

  dispose(): void {
    this.wash?.release();
    this.collar.geometry.dispose();
    this.collar.material.dispose();
    this.spray.geometry.dispose();
    this.spray.material.dispose();
  }
}
