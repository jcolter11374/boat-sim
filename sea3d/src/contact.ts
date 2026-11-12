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
import { WashSlot, bowWaveHeight } from "./boatWash";
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
  uniform vec3 uWindC;  // xy: hull centre (world xz), z unused
  uniform vec2 uWindD;  // unit direction the wind blows towards (world xz), 0 if calm
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
    // Never a solid rim: even at the bow under half of it is foam (Ines r5: no white skirt).
    // Thicker on the windward side, where the sea piles up against the hull (Elena r10).
    float windward = smoothstep(0.0, 0.7, -dot(normalize(vW.xz - uWindC.xy + 1e-4), uWindD));
    float a = smoothstep(0.56 - (0.32 + 0.2 * windward) * sqrt(edge) * uI * bow, 0.66, n) * pow(edge, 0.8 - 0.4 * windward) * min(1.0, 1.3 * uI) * (1.0 + 0.4 * windward);
    // Thick at the bow, thinning aft and breaking into patches with gaps (Elena, WIP 2).
    float aft = smoothstep(0.15, 0.9, vUV.x);
    float gaps = smoothstep(0.3, 0.6, vnoise(q * vec2(0.9, 2.5) + 3.7));
    a *= mix(1.0, gaps, aft) * (1.0 - 0.45 * aft);
    // At night a faint grey shape at most, even under the deck lamp (Ines, night check).
    gl_FragColor = vec4(vec3(0.97, 0.99, 1.0) * (1.2 * uLight + 0.45 * foamLamp(vW)), clamp(a, 0.0, 0.95) * mix(0.6, 1.0, smoothstep(0.1, 0.4, uLight)));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const sprayVert = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  attribute vec3 aVel;
  varying float vAlpha;
  varying vec3 vW;
  varying vec2 vDir;     // the drop's motion on screen (unit)
  varying float vStretch; // streak length over width
  void main() {
    vAlpha = aAlpha;
    vW = (modelMatrix * vec4(position, 1.0)).xyz;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // A drop drawn as a streak along its motion (Ines r8: streaks, not dots): where it
    // will be 1/30 s on, on screen, sets the streak's direction and length.
    vec4 c0 = projectionMatrix * mv;
    vec4 c1 = projectionMatrix * (mv + viewMatrix * vec4(aVel * 0.033, 0.0));
    vec2 sd = c1.xy / c1.w - c0.xy / c0.w;
    float base = max(aSize * (320.0 / -mv.z), 1.5);
    float lenPx = length(sd) * 0.5 * 900.0; // GUESS: about the screen height in px
    vStretch = clamp(1.0 + lenPx / base, 1.0, 3.5);
    vDir = length(sd) > 1e-6 ? normalize(sd) : vec2(0.0, 1.0);
    gl_PointSize = base * vStretch;
    gl_Position = c0;
  }
`;
const sprayFrag = /* glsl */ `
  ${FOAM_LAMP_GLSL}
  uniform float uLight;
  varying float vAlpha;
  varying vec3 vW;
  varying vec2 vDir;
  varying float vStretch;
  void main() {
    vec2 c = (gl_PointCoord - 0.5) * 2.0;
    c.y = -c.y; // gl_PointCoord runs down the screen
    float along = dot(c, vDir);
    // Tapered: full at the head, thinning to a point at the tail (Ines r10).
    float across = dot(c, vec2(-vDir.y, vDir.x)) * vStretch * (1.0 + 1.6 * max(-along, 0.0));
    float r = along * along + across * across;
    if (r > 1.0) discard;
    // White to pale cool grey, lit by the sky (Ines r9: never beige); the freshest streaks
    // near the stem a little brighter.
    gl_FragColor = vec4(vec3(0.9, 0.96, 1.04) * (uLight + foamLamp(vW)) * (1.05 + 0.4 * vAlpha), min(1.0, 1.3 * vAlpha * exp(-1.8 * r) * (1.0 - r) * (0.55 + 0.45 * smoothstep(-1.0, 0.6, along))));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SPRAY: Record<Quality, number> = { low: 0, high: 600 };
const SPRAY_LIFE = 0.6; // s: a drop is gone in about half a second (Elena r10)
const MIST_LIFE = 1.0; // s: the fine mist behind it hangs a little longer
/** Water rising at the bow faster than this (m/s) meets it as a steep face (GUESS, by eye). */
const CREST_RISE = 0.8;

/** What the boat is doing this frame. */
export interface ContactState {
  speed: number; // m/s through the water (logged)
  /** Bow height above the water surface under it, m (from the motion model's pose). */
  bowClearance: number;
  light: number; // 0..1 for unlit foam
  /** True wind in the scene, m/s blowing towards (x, z); spray drifts downwind with it. */
  wind?: [number, number];
}

export class Contact {
  /** This frame's splash for the sound (sound.ts), 0..1: a slam's sheet or the bow meeting a steep face; 0 most frames. */
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
  private lastBowSea = 0;
  private pending = 0;
  /** Green water over the deck: when it hit (s), how long the deck stays wet and foamy
   *  (s), how hard (0..1), and where along the hull (s, -1 stern .. 1 bow, and half width). */
  private over = { t: -1e9, dur: 2.5, h: 0, at: 0.5, w: 0.8 };
  /** The hull pushed down into the crest as it comes aboard (m, display only): the sea
   *  itself hides the low hull for a moment, then she pops back up (Ines r7). */
  sink = 0;
  /** How far the sea piles up against the hull's side (m). */
  private pile = 0;
  private wetBoost = 0;

  /** A crest comes aboard now, strength h (0..1). */
  private greenWater(t: number, h: number): void {
    const small = this.spec.length < 5;
    // A small boat is swept end to end; a yacht takes it over the bow (GUESS by eye).
    this.over = small ? { t, dur: 2.5, h: Math.min(1, h), at: 0.3, w: 0.9 } : { t, dur: 2.0, h: Math.min(1, h), at: 0.75, w: 0.35 };
    this.pending = Math.max(this.pending, 0.6 * Math.min(1, h)); // the hit throws spray
  }

  /** A breaking crest hits the boat now (a knockdown): a big sheet of spray next frame, 0..1. */
  slam(strength = 1): void {
    this.pending = Math.max(this.pending, strength);
  }
  /** The drawn water's height under a point: the big waves unless the page hands over the
   *  sea's own (Sea.surfaceAt, with the short waves), so the collar and spray sit on what's drawn. */
  surface: (comps: WaveComponent[], x: number, z: number, t: number) => number = heightAt;
  /** Per drop: 1 for a soft puff of mist, 0 for a drop. */
  private readonly mist: Uint8Array;
  /** Each drop's own size (mixed sizes, Elena r10). */
  private readonly szk: Float32Array;
  private readonly av: Float32Array;
  private risePeak = 0;
  /** Bigger boats throw bigger sheets of spray (GUESS: by length^0.7 against the kayak's 3.05 m). */
  private readonly sprayScale: number;
  // spray pool, boat frame x/z with world y
  private readonly n: number;
  private readonly low: boolean;
  private readonly sp: Float32Array; // x, y, z
  private readonly sv: Float32Array; // vx, vy, vz
  private readonly born: Float32Array;
  private next = 0;
  /** For the test hook: how much is showing. */
  readonly shown = { collar: 0, spray: 0, bursts: 0, lastBurst: 0 };

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
    // Low quality: no wash in the sea shader and a plain hull look (inWater.ts lite) (Ravi's frame budget: the sea alone fills
    // Low's +15%); its wash foam is skipped per pixel when its strength is 0. The collar
    // stays: a thin strip hugging the hull costs next to nothing, and without it the boat
    // sits on the sea like a sticker (Ines, opening frame).
    this.low = quality === "low";
    this.water = root ? putInWater(root, this.low) : null;
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
        uniforms: { uTime: { value: 0 }, uFlow: { value: 0 }, uI: { value: 0 }, uLight: { value: 1 }, uDir: { value: new THREE.Vector2(1, 0) }, uWindC: { value: new THREE.Vector3() }, uWindD: { value: new THREE.Vector2() }, ...FOAM_LAMP_UNIFORMS },
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
    this.mist = new Uint8Array(this.n);
    this.szk = new Float32Array(this.n).fill(1);
    this.av = new Float32Array(this.n).fill(1);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    sg.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(this.n), 1));
    sg.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(this.n), 1));
    sg.setAttribute("aVel", new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    this.spray = new THREE.Points(
      sg,
      new THREE.ShaderMaterial({ vertexShader: sprayVert, fragmentShader: sprayFrag, uniforms: { uLight: { value: 1 }, ...FOAM_LAMP_UNIFORMS }, transparent: true, depthWrite: false }),
    );
    this.spray.frustumCulled = false;
    this.spray.renderOrder = 12;
    this.spray.name = "bow_spray";
    this.bowX = this.ring[0][0];
    this.beam = Math.max(...this.ring.map((p) => Math.abs(p[1]))) * 2;
    this.sprayScale = Math.min(2.5, Math.max(1, spec.length / 3.05)) ** 0.7;
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
    // How hard the hull is pushing water about: by its Froude number (speed / sqrt(g L)), so
    // a 3 m kayak at 2 kt (Fn 0.16) makes a ripple and a 31 ft yacht at 6 kt (Fn 0.35) a
    // clear bow and quarter wave (Sam's checklist 5). 1 at Fn 0.36, near hull speed.
    const fn = s.speed / Math.sqrt(9.81 * Math.max(this.wlLength, 0.5));
    const speedK = THREE.MathUtils.clamp((fn - 0.08) / 0.28, 0, 1.6);
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
      // In a gale a broken white ring 0.2-0.5 m wide hugs the hull (Ines r11), wider at the bow.
      // A bigger hull pushes a wider band of white (Yuki: a 31 footer's collar vanished at 30 m).
      const w = (0.06 + 0.1 * speedK + 0.12 * bowK * speedK + seaK * seaK * (0.45 + 0.3 * bowK)) * this.sprayScale ** 1.4;
      for (const [k, off] of [[0, -0.015], [1, w]] as const) {
        const [wx, wz] = toWorld(x + nx * off, z + nz * off, place);
        const o = (i * 2 + k) * 3;
        pos[o] = wx;
        pos[o + 1] = this.surface(comps, wx, wz, t) + 0.015 + 0.02 * seaK + this.pile * Math.exp(-((Math.max(off, 0) / 0.3) ** 2));
        pos[o + 2] = wz;
      }
    }
    this.collar.geometry.attributes.position.needsUpdate = true;
    const u = this.collar.material.uniforms;
    u.uTime.value = t;
    u.uFlow.value = this.flow;
    // Broken, never a solid rim (Ines), but clearly white along the contact in a gale (Elena r10).
    // Some water always slaps the hull once there's a sea running: a thin broken lap at the
    // bow and to windward from about half a metre (Ines, opening frame).
    u.uI.value = THREE.MathUtils.clamp(0.15 + 0.4 * THREE.MathUtils.smoothstep(hs, 0.3, 1.0) + 0.4 * speedK + 0.6 * seaK * seaK, 0, 1);
    {
      const [wwx0, wwz0] = s.wind ?? [0, 0];
      const wl0 = Math.hypot(wwx0, wwz0);
      u.uWindD.value.set(wl0 > 0.1 ? wwx0 / wl0 : 0, wl0 > 0.1 ? wwz0 / wl0 : 0);
      const [hx, hz] = toWorld(this.wlMid, 0, place);
      u.uWindC.value.set(hx, hz, 0);
    }
    u.uLight.value = s.light;
    u.uDir.value.set(Math.cos(place.yaw), -Math.sin(place.yaw));
    this.shown.collar = u.uI.value;

    // The bow wave and wash in the sea, and the wet line on the hull, from the same speed and sea.
    const [cx, cz] = toWorld(this.wlMid, 0, place);
    {
      // Wet and foamy at once, draining away over the next couple of seconds; the hull
      // dips into the crest and comes back up in about a second.
      const x = t - this.over.t;
      const o = this.over;
      const env = x < 0 || x > o.dur ? 0 : o.h * Math.min(1, x / 0.12) * Math.exp(-2.2 * x / o.dur);
      this.wash?.setOver(env, o.at, o.w, this.pile);
      const small = this.spec.length < 5;
      // Down fast as the crest lands, back up within the second (so the foam shows after).
      this.sink = small && x >= 0 && x < 0.9 ? 0.22 * o.h * (x < 0.25 ? Math.sin((Math.PI / 2) * (x / 0.25)) : 0.5 + 0.5 * Math.cos((Math.PI * (x - 0.25)) / 0.65)) : 0;
    }
    // The sea piles up against the hull in a gale, more as a crest lands (Elena r10: water
    // climbs the hull, never a flat cut). GUESS by eye, display only.
    {
      const x = t - this.over.t;
      const hit = x >= 0 && x < 1.5 ? this.over.h * Math.exp(-2.5 * x) : 0;
      this.pile = this.low ? 0 : 0.06 * seaK * seaK + 0.12 * hit;
      // A wet band up the topsides after a burial, drying over a few seconds.
      this.wetBoost = x >= 0 && x < 6 ? 0.3 * this.over.h * Math.exp(-x / 2.5) : 0;
    }
    this.wash?.set(cx, cz, place.yaw, this.wlLength, 2 * this.wlHalfBeam, s.speed, this.low ? 0 : THREE.MathUtils.clamp(0.2 * seaK + 0.7 * Math.min(speedK, 1.2), 0, 1));
    this.water?.update({ wetH: 0.05 + 0.03 * Math.min(speedK, 1.2) + 0.12 * seaK + this.wetBoost, foam: THREE.MathUtils.clamp(0.3 + 0.4 * speedK + 0.3 * seaK, 0, 1), light: s.light, rough: THREE.MathUtils.smoothstep(hs, 1.5, 4.5), plane: this.low ? this.seaPlane(comps, t, place, cx, cz) : undefined });

    // Spray: when the bow drops into the water fast, throw a sheet of drops out
    // to both sides; a little steady spray at speed in a rough sea.
    this.splash = 0;
    if (this.n > 0) {
      const sink = dt > 0 ? (this.lastClear - s.bowClearance) / dt : 0; // m/s the bow is going down into the water
      this.lastClear = s.bowClearance;
      let burst = 0;
      let crest = 0; // how fast the face the bow just met was rising (m/s), 0 if none
      // A slam throws a sheet of spray, big from force 6 (Hs ~3 m) up, a few drops below that.
      const slamK = 0.25 + 0.75 * THREE.MathUtils.smoothstep(hs, 1.5, 3.5);
      if (s.bowClearance < 0.04 && sink > 0.35) burst = Math.min(90, Math.round((sink - 0.35) * 45 * (0.5 + speedK) * slamK));
      // The bow driving into a steep face: the motion rides the long waves too smoothly to
      // slam on its own, so meet each fast-rising face with a sheet (GUESS, display only):
      // when the water at the bow is rising faster than CREST_RISE m/s, throw it at the peak.
      const [bwx, bwz] = toWorld(this.bow[0], this.bow[1], place);
      const bowSea = heightAt(comps, bwx, bwz, t);
      const rise = dt > 0 && dt < 0.2 ? (bowSea - this.lastBowSea) / dt : 0;
      this.lastBowSea = bowSea;
      if (rise < CREST_RISE) this.risePeak = 0;
      else if (this.risePeak >= 0) {
        if (rise >= this.risePeak) this.risePeak = rise;
        else {
          // just past the steepest part of the face: throw the sheet once for this face
          crest = this.risePeak;
          // From force 6 a fast-rising face breaks over a low deck (Sam's checklist 3).
          const gw = THREE.MathUtils.smoothstep(hs, 2.0, 4.5) * Math.min(1, 4 / Math.max(this.spec.length, 1)) * Math.min(1, 0.4 + 0.8 * (crest - CREST_RISE)); // a gale's steep faces
          if (gw > 0.05 && t - this.over.t > 0.8 * this.over.dur) this.greenWater(t, gw);
          burst += Math.min(220, Math.round((this.risePeak - CREST_RISE) * 150 * (0.4 + speedK) * slamK * slamK));
          this.risePeak = -1;
        }
      }
      // Between the big faces a small low deck in a gale is still awash: the short crests
      // slop over it every few seconds (Sam's checklist 3; GUESS by eye, display only).
      const awashK = THREE.MathUtils.smoothstep(hs, 3.5, 5.5) * Math.min(1, 4 / Math.max(this.spec.length, 1)) ** 2;
      if (awashK > 0.05 && t - this.over.t > this.over.dur + 1.0 && Math.random() < dt * 0.2 * awashK) {
        this.greenWater(t, (0.5 + 0.5 * Math.random()) * awashK);
      }
      if (this.pending > 0) {
        if (t - this.over.t > 0.5) this.greenWater(t, this.pending);
        burst += Math.round(200 * this.pending);
        crest = Math.max(crest, 1.6 * this.pending);
        this.pending = 0;
      }
      if (burst >= 10) { this.shown.bursts++; this.shown.lastBurst = burst; }
      this.splash = Math.min(1, burst / 40);
      const steady = speedK * seaK * 25 * dt; // drops per frame
      const emit = burst + (Math.random() < steady % 1 ? Math.ceil(steady) : Math.floor(steady));
      const [bx, bz] = this.bow;
      for (let e = 0; e < emit; e++) {
        const i = this.next;
        this.next = (this.next + 1) % this.n;
        const sideSign = Math.random() < 0.5 ? -1 : 1;
        const back = Math.random() ** 2.5 * 0.25 * this.spec.length; // most of it right at the stem
        this.sp[i * 3] = bx - back;
        this.sp[i * 3 + 2] = bz + sideSign * (this.beam * 0.3 * Math.min(1, back * 4 + 0.2));
        const [wx, wz] = toWorld(this.sp[i * 3], this.sp[i * 3 + 2], place);
        this.sp[i * 3 + 1] = this.surface(comps, wx, wz, t) + 0.02 + bowWaveHeight(s.speed); // on the bow wave
        const power = (0.6 + Math.min(Math.max(sink, 1.3 * crest), 3) * 0.8 + 0.6 * speedK) * (0.8 + 0.4 * slamK) * Math.sqrt(this.sprayScale);
        // A slam's drops leave together, close to one speed, so they fly as a sheet that
        // fans out from the flare: highest at the stem, lower further aft (Elena: a visible
        // sheet from force 6). The steady drops at speed scatter more.
        const sheet = burst > 0 ? 1 : 0;
        const jit = sheet ? 0.25 : 0.7;
        const aftK = 1 - 0.5 * Math.min(1, back / (0.25 * this.spec.length));
        this.sv[i * 3] = -s.speed * 0.4 + (Math.random() - 0.5) * 0.4; // drops fall behind as the boat moves on
        this.sv[i * 3 + 1] = power * (1.0 + jit * Math.random()) * (sheet ? aftK * 1.25 : 1) + Math.max(rise, 0); // thrown off water that is itself rising
        this.sv[i * 3 + 2] = sideSign * power * (0.7 + jit * Math.random());
        this.born[i] = t;
        this.mist[i] = Math.random() < 0.4 ? 1 : 0; // a fine mist behind the streaks
        this.szk[i] = 0.45 + 1.6 * Math.random() ** 2;
        this.av[i] = 0.3 + 0.7 * Math.random() ** 1.5; // most streaks faint, a few bright
      }
      // Green water pouring off the gunwale: drops spill out over both sides where the
      // water on deck is, falling back into the sea (Ines r5: runs off broken and white).
      {
        const o = this.over;
        const x = t - o.t;
        if (x >= 0.1 && x <= 1.6) {
          const pour = Math.round(4 * o.h * Math.exp(-1.5 * x) + Math.random() * 0.6);
          for (let e = 0; e < pour; e++) {
            const i = this.next;
            this.next = (this.next + 1) % this.n;
            const side = Math.random() < 0.5 ? -1 : 1;
            const sx = this.wlMid + (o.at + (Math.random() * 2 - 1) * o.w) * this.wlLength / 2;
            this.sp[i * 3] = sx;
            this.sp[i * 3 + 2] = side * this.wlHalfBeam * 1.05;
            const [wx, wz] = toWorld(sx, this.sp[i * 3 + 2], place);
            this.sp[i * 3 + 1] = this.surface(comps, wx, wz, t) + 0.25 + 0.1 * Math.random();
            this.sv[i * 3] = (Math.random() - 0.5) * 0.6;
            this.sv[i * 3 + 1] = 0.3 * Math.random();
            this.sv[i * 3 + 2] = side * (0.6 + 0.9 * Math.random());
            this.born[i] = t;
            this.mist[i] = Math.random() < 0.1 ? 1 : 0;
            this.szk[i] = 0.5 + Math.random();
          }
        }
      }
      // The wind in the boat's frame (x forward, z to starboard as toWorld has it), relative to the water.
      const [wwx, wwz] = s.wind ?? [0, 0];
      const cy = Math.cos(place.yaw), sy = Math.sin(place.yaw);
      const windB: [number, number] = [wwx * cy - wwz * sy, wwx * sy + wwz * cy];
      // Spray carries at most a couple of boat lengths downwind before it's gone (Ines r8).
      {
        const wl = Math.hypot(windB[0], windB[1]);
        const cap = (2.2 * this.spec.length) / MIST_LIFE;
        if (wl > cap) { windB[0] *= cap / wl; windB[1] *= cap / wl; }
      }
      const ppos = this.spray.geometry.attributes.position.array as Float32Array;
      const alpha = this.spray.geometry.attributes.aAlpha.array as Float32Array;
      const size = this.spray.geometry.attributes.aSize.array as Float32Array;
      const vel = this.spray.geometry.attributes.aVel.array as Float32Array;
      let live = 0;
      for (let i = 0; i < this.n; i++) {
        const age = t - this.born[i];
        const life = this.mist[i] ? MIST_LIFE : SPRAY_LIFE;
        if (age < 0 || age > life) {
          alpha[i] = 0;
          continue;
        }
        this.sv[i * 3 + 1] -= 9.81 * dt;
        // Air drag pulls each drop towards the wind's speed: drops in about a second, mist
        // at once (GUESS), so the cloud falls within a boat length and drifts downwind (Sam 7).
        const drag = Math.min(1, (this.mist[i] ? 3.5 : 1.0) * dt);
        this.sv[i * 3] += (windB[0] - this.sv[i * 3]) * drag;
        this.sv[i * 3 + 2] += (windB[1] - this.sv[i * 3 + 2]) * drag;
        this.sp[i * 3] += this.sv[i * 3] * dt - s.speed * dt; // the water (and drops) slide aft past the boat
        this.sp[i * 3 + 1] += this.sv[i * 3 + 1] * dt;
        this.sp[i * 3 + 2] += this.sv[i * 3 + 2] * dt;
        const [wx, wz] = toWorld(this.sp[i * 3], this.sp[i * 3 + 2], place);
        ppos[i * 3] = wx;
        ppos[i * 3 + 1] = this.sp[i * 3 + 1];
        ppos[i * 3 + 2] = wz;
        const vbx = this.sv[i * 3] - s.speed, vbz = this.sv[i * 3 + 2];
        vel[i * 3] = vbx * cy + vbz * sy;
        vel[i * 3 + 1] = this.sv[i * 3 + 1];
        vel[i * 3 + 2] = -vbx * sy + vbz * cy;
        const k = age / life;
        // Drops spread into a mist as they fly: bigger, softer and fainter with age.
        // A sheet is many small drops and a few soft puffs of mist that hang a little longer.
        const m = this.mist[i];
        // The fine mist carries most of the volume; the streaks vary, most of them faint.
        alpha[i] = (m ? 0.22 * (1 - k) : 0.95 * this.av[i] * (1 - k) ** 1.5) * Math.min(1, age * 10);
        size[i] = (m ? 0.28 + 0.8 * k : 0.06 + 0.1 * k) * this.szk[i] * (0.6 + 0.6 * slamK) * this.sprayScale;
        if (m) vel[i * 3] = vel[i * 3 + 1] = vel[i * 3 + 2] = 0; // mist is soft puffs, not streaks
        live++;
      }
      this.spray.geometry.attributes.position.needsUpdate = true;
      this.spray.geometry.attributes.aAlpha.needsUpdate = true;
      this.spray.geometry.attributes.aSize.needsUpdate = true;
      this.spray.geometry.attributes.aVel.needsUpdate = true;
      this.spray.material.uniforms.uLight.value = s.light;
      this.shown.spray = live;
    }
  }

  /** Low: the sea under the hull as a plane (inWater.ts lite), from its height at the
   *  waterline's middle, ends and sides. */
  private seaPlane(comps: WaveComponent[], t: number, place: Placement, cx: number, cz: number) {
    const hl = this.wlLength / 2, hb = Math.max(this.wlHalfBeam, 0.2);
    const [bx, bz] = toWorld(this.wlMid + hl, 0, place);
    const [sx, sz] = toWorld(this.wlMid - hl, 0, place);
    const [px, pz] = toWorld(this.wlMid, hb, place);
    const [qx, qz] = toWorld(this.wlMid, -hb, place);
    const along = (this.surface(comps, bx, bz, t) - this.surface(comps, sx, sz, t)) / (2 * hl);
    const across = (this.surface(comps, px, pz, t) - this.surface(comps, qx, qz, t)) / (2 * hb);
    const [ux, uz] = [(bx - sx) / (2 * hl), (bz - sz) / (2 * hl)];
    const [vx, vz] = [(px - qx) / (2 * hb), (pz - qz) / (2 * hb)];
    return { x: cx, z: cz, y: this.surface(comps, cx, cz, t), gx: along * ux + across * vx, gz: along * uz + across * vz };
  }

  dispose(): void {
    this.wash?.release();
    this.collar.geometry.dispose();
    this.collar.material.dispose();
    this.spray.geometry.dispose();
    this.spray.material.dispose();
  }
}
