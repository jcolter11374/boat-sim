/**
 * A real town on the land (?place=annapolis): its buildings and piers from
 * Overture Maps (ODbL; mostly OpenStreetMap), standing on the place's ground.
 *
 * - Buildings: real footprints and heights (a GUESS by footprint where unmapped),
 *   gable or flat roofs, walls with windows. The windows light up, a few at a time,
 *   as the sun goes down.
 * - Reflections: at dusk and at night the lit waterfront windows and the moored
 *   boats' anchor lights throw long broken streaks across the water towards you,
 *   longer in a chop. Generic: anything can add light sources.
 * - Piers, boats on moorings that swing to the wind, and the State House dome (our own model).
 *
 * The town's file (<town>.json, built by landdata.py) is in metres from its own
 * origin, x east and z south; <town>_height.bin is its ground in decimetres.
 * Display only: the boat's physics never sees the town.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Quality } from "../boats/parts";
import type { Place } from "./place";
import { reflectable } from "../mirror";
import { NOISE, R_EARTH, bendWithEarth, distanceField, metresPerDegree, rnd } from "./shader";

export interface Building {
  p: [number, number][];
  b: number; // ground under it, m
  h: number; // height, m
  r: "flat" | "gable";
  c: string; // Overture class
  s: number; // seed
  n?: string;
}

export interface TownFile {
  origin: [number, number]; // lat, lon
  nx: number;
  ny: number;
  x0: number;
  z0: number;
  w: number;
  h: number;
  buildings: Building[];
  piers: [number, number][][];
  stateHouse?: { x: number; z: number; base: number };
}

/** A light that the water reflects: where it is (town frame), how high, how wide, its colour. */
export interface LightSource {
  x: number;
  z: number;
  height: number;
  width: number;
  color: THREE.Color;
}

const WALLS = [0x8a3b2a, 0x9b4a35, 0x7c3426, 0xa65a42, 0xd8cbb0, 0xe9e4d8, 0xc9b79a, 0x8e8a80, 0xb7a58a, 0x6f6a62];
const ROOFS = [0x3a3d42, 0x2f3236, 0x4a3f3a, 0x55504a, 0x3d4a52];
const NO_WINDOWS = new Set(["garage", "garages", "shed", "parking", "carport", "storage_tank", "silo", "roof"]);
const WATER_DM = 4.5; // ground below this (dm) is water in the town's height grid
const FLOOR = 3.2; // m per storey
const BAY = 2.7; // m per window bay

/** Sun elevation (deg) to how far into the evening it is: 0 by day, 1 once it's dark. */
export function nightOf(sunEl: number): number {
  return THREE.MathUtils.smoothstep(-sunEl, -3, 5);
}

/** Signed area of a ring in x east, z south (negative = anticlockwise seen from above). */
export function ringArea(p: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, z1] = p[i];
    const [x2, z2] = p[(i + 1) % p.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

export function insideRing(p: [number, number][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i];
    const [xj, zj] = p[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Walls with windows: aWin is (m along the wall, m above the base, building seed or 0 for none). */
function wallMaterial(night: { value: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = night;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 aWin;\nvarying vec3 vWin;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWin = aWin;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uNight;
varying vec3 vWin;
float h11(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
{
  vec2 cell = vec2(floor(vWin.x / ${BAY.toFixed(1)}), floor(vWin.y / ${FLOOR.toFixed(1)}));
  vec2 f = vec2(fract(vWin.x / ${BAY.toFixed(1)}), fract(vWin.y / ${FLOOR.toFixed(1)}));
  float win = step(0.28, f.x) * step(f.x, 0.72) * step(0.3, f.y) * step(f.y, 0.82) * step(1.0, vWin.y) * step(0.5, vWin.z);
  float r = h11(cell + vWin.z * 0.013);
  // More of the windows come on as the evening goes on.
  float lit = step(1.0 - (0.1 + 0.45 * uNight), r);
  vec3 warm = mix(vec3(1.0, 0.62, 0.3), vec3(1.0, 0.85, 0.6), h11(cell + 7.1));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.07, 0.09), win * 0.85);
  totalEmissiveRadiance += warm * win * lit * (0.8 + 1.2 * h11(cell + 3.3)) * uNight;
}`,
      );
  };
  return bendWithEarth(m, "boatsim-town-walls-v1");
}

/** Lights nearer than this throw their full streak (m): the harbour view, where the look was set. */
export const REFLECT_FULL_M = 1400;
/**
 * How bright a light's streak is at d metres, against one close by: the light reaching the water
 * near you thins with the square of the distance. (From the practice course, 3.5 km out, the town's
 * streaks were as bright as from the harbour mouth: bars of gold hundreds of metres long under a
 * row of pin-prick lights.)
 */
export function reflectFade(d: number): number {
  return Math.min(1, Math.max(REFLECT_FAR, (REFLECT_FULL_M / Math.max(d, 1)) ** 2));
}
/** ...but never fainter than this: a calm bay at night does show short glints under a far town's brightest lights (Elena, 14 Nov: about a third of the harbour's). */
export const REFLECT_FAR = 0.33;
/** A far light's glints are short: the streak's spread narrows to this much of the harbour's, from REFLECT_FULL_M out to three times it. */
export const REFLECT_SHORT = 0.6;

/**
 * Reflections of lights on the water: one flat streak per light, lying on the sea and
 * running from near the light towards the viewer (the glitter path), brightest where a
 * calm sea would mirror it, longer in a chop and broken into moving dashes by the waves.
 * Added on top of the sea (additive), only at dusk and night.
 */
export class Reflections {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor(sources: LightSource[]) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    const src = new Float32Array(sources.length * 4);
    const col = new Float32Array(sources.length * 4);
    sources.forEach((s, i) => {
      src.set([s.x, s.z, s.height, s.width], i * 4);
      col.set([s.color.r, s.color.g, s.color.b, (i * 0.6180339) % 1], i * 4);
    });
    g.setAttribute("aSrc", new THREE.InstancedBufferAttribute(src, 4));
    g.setAttribute("aCol", new THREE.InstancedBufferAttribute(col, 4));
    g.instanceCount = sources.length;
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uNight: { value: 0 }, uRough: { value: 0.2 }, uLift: { value: 0.12 } }]),
      vertexShader: `
        attribute vec4 aSrc; // x, z (model frame), height above the water, half-width at the source
        attribute vec4 aCol; // colour, seed
        uniform float uRough;
        uniform float uLift;
        varying float vR;     // m from the viewer, along the streak
        varying float vAcross;
        varying vec3 vTh;     // viewer height, mirror angle, slope spread
        varying vec4 vCol;
        varying vec2 vEnd;    // how bright for its distance (reflectFade), and 0 far end .. 1 near end
        #include <fog_pars_vertex>
        void main() {
          vec3 src = (modelMatrix * vec4(aSrc.x, 0.0, aSrc.y, 1.0)).xyz;
          vec2 to = src.xz - cameraPosition.xz;
          float D = max(length(to), 2.0);
          vec2 dir = to / D;
          vec2 side = vec2(-dir.y, dir.x);
          float Hc = max(cameraPosition.y - uLift, 0.3);
          // A calm sea mirrors the light at depression angle th0 below the horizon. Wave
          // facets tilted up to a couple of slopes either way catch it at nearby angles,
          // so the glitter runs from near the light towards the viewer, longer in a chop.
          float th0 = atan((aSrc.z + Hc) / D);
          // Far lights throw short glints, not long bars: a narrower spread past the harbour's range.
          float sig = (0.03 + 0.12 * uRough) * mix(1.0, ${REFLECT_SHORT.toFixed(2)}, smoothstep(${REFLECT_FULL_M.toFixed(1)}, ${(3 * REFLECT_FULL_M).toFixed(1)}, D));
          float rNear = Hc / tan(th0 + 2.5 * sig);
          float rFar = min(Hc / tan(max(th0 - 2.5 * sig, 1e-4)), D - 0.5);
          float r = mix(rFar, rNear, position.y);
          float hw = aSrc.w + r * (0.0006 + 0.002 * uRough);
          vec2 xz = cameraPosition.xz + dir * r + side * position.x * hw;
          vec3 transformed = vec3(xz.x, uLift, xz.y);
          transformed.y -= dot(xz, xz) / ${(2 * R_EARTH).toFixed(1)};
          vR = r;
          vAcross = position.x;
          vTh = vec3(Hc, th0, sig);
          vCol = aCol;
          float fade = ${REFLECT_FULL_M.toFixed(1)} / max(D, 1.0);
          vEnd = vec2(min(1.0, max(${REFLECT_FAR.toFixed(2)}, fade * fade)), position.y);
          vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform float uTime;
        uniform float uNight;
        varying float vR;
        varying float vAcross;
        varying vec3 vTh;
        varying vec4 vCol;
        varying vec2 vEnd;
        #include <fog_pars_fragment>
        ${NOISE}
        void main() {
          // Brightest where the calm-sea mirror would be, fading as the facets needed get steeper.
          float th = atan(vTh.x / max(vR, 0.1));
          float k = (th - vTh.y) / vTh.z;
          float core = exp(-0.5 * k * k);
          float across = 1.0 - vAcross * vAcross;
          // Dashes: each wave face catching the light, moving with the sea. Finer near, coarser far.
          float scale = 1.2 / (1.0 + vR * 0.01);
          float dash = lnoise(vec2(vR * scale + vCol.a * 40.0, vAcross * 1.5 + uTime * 1.3));
          dash = smoothstep(0.45, 0.85, dash);
          // Thinner with distance, and the end nearest the viewer fades out (it stopped at a hard edge).
          float a = 0.22 * core * across * dash * uNight * vEnd.x * smoothstep(1.0, 0.75, vEnd.y);
          if (a < 0.003) discard;
          vec3 c = vCol.rgb * a;
          #ifdef USE_FOG
            #ifdef FOG_EXP2
              float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
            #else
              float fogF = smoothstep(fogNear, fogFar, vFogDepth);
            #endif
            c *= 1.0 - fogF;
          #endif
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = "reflections";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12; // over the sea and the surf
  }

  get count(): number {
    return (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
  }

  update(t: number, night: number, hs: number): void {
    const u = this.mat.uniforms;
    u.uTime.value = t;
    u.uNight.value = night;
    u.uRough.value = THREE.MathUtils.clamp(hs / 1.2, 0.05, 1);
    u.uLift.value = 0.08 + 0.3 * hs; // over most of the chop near the boat
    this.mesh.visible = night > 0.01;
  }
}

export class Town {
  readonly group = new THREE.Group();
  /** Buildings drawn, light sources on the water, moored boats (for tests). */
  readonly shown = { buildings: 0, lights: 0, moorings: 0 };
  private readonly night = { value: 0 };
  private reflections: Reflections | null = null;
  private lampMat: THREE.MeshBasicMaterial | null = null;
  private moorings: THREE.InstancedMesh[] = [];
  private mooringSpots: { x: number; z: number; L: number }[] = [];
  private swing = 0;
  /** Footprints of buildings and piers on a 2 m grid, a little widened (town frame). */
  private blockedMask: Uint8Array | null = null;
  private d!: TownFile;
  private hgt!: Int16Array;

  private constructor() {
    this.group.name = "town";
  }

  /** Load the place's town; null when it has none or its files aren't on this copy of the site. */
  static async load(place: Place, quality: Quality, base = "./land"): Promise<Town | null> {
    if (!place.town) return null;
    const get = async (f: string) => {
      const r = await fetch(`${base}/${f}`);
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) throw new Error(f);
      return r;
    };
    let d: TownFile;
    let hgt: Int16Array;
    try {
      d = await (await get(`${place.town}.json`)).json();
      hgt = new Int16Array(await (await get(`${place.town}_height.bin`)).arrayBuffer());
    } catch {
      return null;
    }
    const town = new Town();
    town.build(d, hgt, place, quality);
    return town;
  }

  /** Put the buildings, piers, dome and moored boats in the sea's mirror (not the night reflections). */
  mirrored(): void {
    for (const o of this.group.children) if (o !== this.reflections?.mesh) reflectable(o);
  }

  /** True where a tree mustn't stand (inside or right next to a building or pier); world x, z. */
  blocked(x: number, z: number): boolean {
    const m = this.blockedMask;
    if (!m) return false;
    const d = this.d;
    const tx = x - this.group.position.x;
    const tz = z - this.group.position.z;
    const i = Math.floor((tx - d.x0) / 2);
    const j = Math.floor((tz - d.z0) / 2);
    const W = Math.ceil(d.w / 2);
    const H = Math.ceil(d.h / 2);
    return i >= 0 && j >= 0 && i < W && j < H && m[j * W + i] === 1;
  }

  private build(d: TownFile, hgt: Int16Array, place: Place, quality: Quality): void {
    this.d = d;
    this.hgt = hgt;
    // The town's frame from the boat's: metres east and south of the place.
    const { mx, my } = metresPerDegree(place.lat);
    this.group.position.set((d.origin[1] - place.lon) * mx, 0, -(d.origin[0] - place.lat) * my);
    const cell = d.w / (d.nx - 1);
    const toWater = distanceField(d.nx, d.ny, (k) => hgt[k] < WATER_DM);
    const toLand = distanceField(d.nx, d.ny, (k) => hgt[k] >= WATER_DM);
    const gridAt = (f: Float32Array, x: number, z: number) => {
      const i = Math.round(((x - d.x0) / d.w) * (d.nx - 1));
      const j = Math.round(((z - d.z0) / d.h) * (d.ny - 1));
      if (i < 0 || j < 0 || i >= d.nx || j >= d.ny) return 1e9;
      return f[j * d.nx + i] * cell;
    };
    const lights: LightSource[] = [];
    this.buildings(d, (x, z) => gridAt(toWater, x, z), lights, quality);
    this.piers(d);
    if (d.stateHouse) this.stateHouse(d.stateHouse);
    this.mooringsBuild(d, (x, z) => gridAt(toLand, x, z), lights, quality);
    this.mask(d);
    this.reflections = new Reflections(lights);
    this.group.add(this.reflections.mesh);
    this.shown.lights = lights.length;
  }

  private buildings(d: TownFile, toWater: (x: number, z: number) => number, lights: LightSource[], quality: Quality): void {
    const wp: number[] = [];
    const wn: number[] = [];
    const wc: number[] = [];
    const ww: number[] = [];
    const rp: number[] = [];
    const rn: number[] = [];
    const rc: number[] = [];
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const tri = (P: number[], N: number[], C: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, col: THREE.Color) => {
      const n = e1.subVectors(b, a).cross(e2.subVectors(c, a)).normalize();
      for (const v of [a, b, c]) {
        P.push(v.x, v.y, v.z);
        N.push(n.x, n.y, n.z);
        C.push(col.r, col.g, col.b);
      }
    };
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const maxLights = quality === "low" ? 1200 : 3000;
    const warm = [new THREE.Color(1.0, 0.62, 0.3), new THREE.Color(1.0, 0.78, 0.5), new THREE.Color(0.95, 0.9, 0.8)];
    for (const b of d.buildings) {
      // Anticlockwise seen from above (x east, z south: negative signed area), so walls face out.
      const p = ringArea(b.p) > 0 ? b.p.slice().reverse() : b.p;
      if (p.length < 3) continue;
      const r = rnd(b.s);
      const wall = new THREE.Color(WALLS[Math.floor(r() * WALLS.length)]).multiplyScalar(0.85 + 0.3 * r());
      const roof = new THREE.Color(ROOFS[Math.floor(r() * ROOFS.length)]);
      const y0 = b.b - 3; // down into the ground, whose grid is coarser than the footprints
      const eave = b.b + b.h * (b.r === "gable" ? 0.78 : 1);
      const windows = NO_WINDOWS.has(b.c) ? 0 : 1;
      const seed = (b.s % 997) + 1;
      const near = windows && toWater(p[0][0], p[0][1]) < 60;
      let u = 0;
      for (let i = 0; i < p.length; i++) {
        const [x1, z1] = p[i];
        const [x2, z2] = p[(i + 1) % p.length];
        const len = Math.hypot(x2 - x1, z2 - z1);
        const a = V(x1, y0, z1);
        const bb = V(x2, y0, z2);
        const c = V(x2, eave, z2);
        const dd = V(x1, eave, z1);
        tri(wp, wn, wc, a, bb, c, wall);
        tri(wp, wn, wc, a, c, dd, wall);
        const top = eave - b.b;
        for (const [uu, vv] of [
          [u, -3],
          [u + len, -3],
          [u + len, top],
          [u, -3],
          [u + len, top],
          [u, top],
        ])
          ww.push(uu, vv, windows * seed);
        // A wall that looks out over the water throws its lit windows' light across it.
        if (near && len > 2 && lights.length < maxLights) {
          const nx = -(z2 - z1) / len; // outward for an anticlockwise ring (x east, z south), as the wall faces
          const nz = (x2 - x1) / len;
          const mxp = (x1 + x2) / 2;
          const mzp = (z1 + z2) / 2;
          const here = toWater(mxp, mzp);
          if (here < 45 && toWater(mxp + nx * 10, mzp + nz * 10) < here - 4) {
            const floors = Math.max(1, Math.floor(top / FLOOR));
            for (let s = BAY / 2; s < len; s += BAY * 1.5)
              if (r() < 0.45) {
                const f = Math.floor(r() * floors);
                lights.push({
                  x: x1 + ((x2 - x1) * s) / len + nx * 0.3,
                  z: z1 + ((z2 - z1) * s) / len + nz * 0.3,
                  height: b.b + f * FLOOR + 1.8,
                  width: 0.25,
                  color: warm[Math.floor(r() * warm.length)].clone().multiplyScalar(0.5 + 0.6 * r()),
                });
              }
          }
        }
        u += len;
      }
      if (b.r === "gable" && p.length === 4) {
        // Ridge along the longer pair of sides.
        const s0 = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
        const s1 = Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1]);
        const q = s0 >= s1 ? p : [p[1], p[2], p[3], p[0]];
        const m1 = [(q[1][0] + q[2][0]) / 2, (q[1][1] + q[2][1]) / 2];
        const m2 = [(q[3][0] + q[0][0]) / 2, (q[3][1] + q[0][1]) / 2];
        const top = b.b + b.h;
        const A = V(q[0][0], eave, q[0][1]);
        const B = V(q[1][0], eave, q[1][1]);
        const C = V(q[2][0], eave, q[2][1]);
        const D = V(q[3][0], eave, q[3][1]);
        const R1 = V(m1[0], top, m1[1]);
        const R2 = V(m2[0], top, m2[1]);
        tri(rp, rn, rc, A, B, R1, roof);
        tri(rp, rn, rc, A, R1, R2, roof);
        tri(rp, rn, rc, C, D, R2, roof);
        tri(rp, rn, rc, C, R2, R1, roof);
        tri(wp, wn, wc, B, C, R1, wall);
        tri(wp, wn, wc, D, A, R2, wall);
        for (let k = 0; k < 6; k++) ww.push(0, 0, 0);
      } else {
        const flat = new THREE.Color(0x4b4d50).lerp(roof, 0.4);
        const shape = p.map(([x, z]) => new THREE.Vector2(x, z));
        for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(shape, [])) {
          const a = V(p[i][0], eave, p[i][1]);
          const bb = V(p[j][0], eave, p[j][1]);
          const c = V(p[k][0], eave, p[k][1]);
          const up = e1.subVectors(bb, a).cross(e2.subVectors(c, a)).y > 0;
          if (up) tri(rp, rn, rc, a, bb, c, flat);
          else tri(rp, rn, rc, a, c, bb, flat);
        }
      }
      this.shown.buildings++;
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute("position", new THREE.Float32BufferAttribute(wp, 3));
    wg.setAttribute("normal", new THREE.Float32BufferAttribute(wn, 3));
    wg.setAttribute("color", new THREE.Float32BufferAttribute(wc, 3));
    wg.setAttribute("aWin", new THREE.Float32BufferAttribute(ww, 3));
    const walls = new THREE.Mesh(wg, wallMaterial(this.night));
    walls.name = "walls";
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.Float32BufferAttribute(rp, 3));
    rg.setAttribute("normal", new THREE.Float32BufferAttribute(rn, 3));
    rg.setAttribute("color", new THREE.Float32BufferAttribute(rc, 3));
    const roofs = new THREE.Mesh(
      rg,
      bendWithEarth(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide }), "boatsim-town-roofs-v1"),
    );
    roofs.name = "roofs";
    walls.frustumCulled = roofs.frustumCulled = false; // the curve moves vertices after culling's bounds
    this.group.add(walls, roofs);
  }

  /** Timber decks a little above the water. */
  private piers(d: TownFile): void {
    if (!d.piers.length) return;
    const geos = d.piers
      .filter((ring) => ring.length >= 3)
      .map((ring) => {
        const g = new THREE.ExtrudeGeometry(new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z))), { depth: 0.35, bevelEnabled: false });
        g.rotateX(-Math.PI / 2);
        g.translate(0, 0.75, 0);
        return g;
      });
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, bendWithEarth(new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.9 }), "boatsim-town-piers-v1"));
    mesh.name = "piers";
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  /** The Maryland State House dome: our own model, from photos and published heights (top about 55 m). */
  private stateHouse(sh: { x: number; z: number; base: number }): void {
    const white = bendWithEarth(new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.6 }), "boatsim-town-dome-v1");
    const g = new THREE.Group();
    g.name = "stateHouse";
    const y0 = sh.base;
    const add = (geo: THREE.BufferGeometry, y: number) => {
      const m = new THREE.Mesh(geo, white);
      m.position.y = y;
      m.frustumCulled = false;
      g.add(m);
    };
    add(new THREE.BoxGeometry(12, 3, 12), y0 + 1.5); // square base stage
    add(new THREE.CylinderGeometry(5.4, 5.6, 7, 8), y0 + 6.5); // octagonal drum
    add(new THREE.CylinderGeometry(6.2, 6.2, 0.6, 8), y0 + 10.3); // cornice
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      prof.push(new THREE.Vector2(5.6 * Math.cos((t * Math.PI) / 2.15) + 0.0001, 7.5 * Math.sin((t * Math.PI) / 2)));
    }
    add(new THREE.LatheGeometry(prof, 8), y0 + 10.6); // the dome, eight-sided like the real one
    add(new THREE.CylinderGeometry(2.3, 2.5, 5, 8), y0 + 19.5); // first lantern
    add(new THREE.CylinderGeometry(2.8, 2.8, 0.4, 8), y0 + 22.2);
    add(new THREE.LatheGeometry([new THREE.Vector2(2.5, 0), new THREE.Vector2(1.8, 1.6), new THREE.Vector2(0.9, 2.6), new THREE.Vector2(0.01, 3)], 8), y0 + 22.4);
    add(new THREE.CylinderGeometry(1.1, 1.2, 4, 8), y0 + 26.5); // second lantern
    add(new THREE.SphereGeometry(1.1, 12, 8), y0 + 29.6); // acorn
    add(new THREE.CylinderGeometry(0.08, 0.12, 6, 6), y0 + 33.5); // lightning rod
    g.position.set(sh.x, 0, sh.z);
    this.group.add(g);
  }

  /**
   * Sailboats on moorings: in sheltered water near the shore, clear of the player's boat
   * and of each other, all lying head to the wind. Each shows a white anchor light at night.
   */
  private mooringsBuild(d: TownFile, toLand: (x: number, z: number) => number, lights: LightSource[], quality: Quality): void {
    const r = rnd(11);
    const want = quality === "low" ? 40 : 80;
    const me = this.group.position; // the player's boat is at the world origin: -me in the town frame
    const spots: { x: number; z: number; L: number }[] = [];
    for (let tries = 0; tries < 6000 && spots.length < want; tries++) {
      const x = d.x0 + r() * d.w;
      const z = d.z0 + r() * d.h;
      const shore = toLand(x, z);
      if (shore < 15 || shore > 160) continue;
      if (Math.hypot(x + me.x, z + me.z) < 70) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 28)) continue;
      spots.push({ x, z, L: 8 + r() * 6 });
    }
    this.mooringSpots = spots;
    this.shown.moorings = spots.length;
    if (!spots.length) return;
    // One boat 1 m long; each instance is scaled to its length.
    const plan = new THREE.Shape();
    plan.moveTo(-0.5, -0.13);
    plan.lineTo(0.15, -0.16);
    plan.quadraticCurveTo(0.42, -0.12, 0.5, 0);
    plan.quadraticCurveTo(0.42, 0.12, 0.15, 0.16);
    plan.lineTo(-0.5, 0.13);
    plan.closePath();
    const hull = new THREE.ExtrudeGeometry(plan, { depth: 0.1, bevelEnabled: false });
    hull.rotateX(-Math.PI / 2);
    hull.translate(0, -0.02, 0);
    const cabin = new THREE.BoxGeometry(0.3, 0.05, 0.16);
    cabin.translate(-0.05, 0.105, 0);
    const mast = new THREE.CylinderGeometry(0.005, 0.007, 1.3, 5);
    mast.translate(0.08, 0.73, 0);
    const paint = (g: THREE.BufferGeometry, c: number) => {
      g.deleteAttribute("uv");
      const col = new THREE.Color(c);
      const n = g.getAttribute("position").count;
      g.setAttribute("color", new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => [col.r, col.g, col.b][i % 3]), 3));
      return g.index ? g.toNonIndexed() : g;
    };
    const boat = mergeGeometries([paint(hull, 0xe8e8e2), paint(cabin, 0xd0d2d4), paint(mast, 0xb8bcc0)]);
    if (!boat) return;
    const boats = new THREE.InstancedMesh(
      boat,
      bendWithEarth(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }), "boatsim-town-moorings-v1", true),
      spots.length,
    );
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xfff2d0 });
    const lamp = new THREE.SphereGeometry(0.009, 6, 4);
    lamp.translate(0.08, 1.39, 0);
    const lamps = new THREE.InstancedMesh(lamp, bendWithEarth(this.lampMat, "boatsim-town-lamps-v1", true), spots.length);
    boats.name = "moorings";
    lamps.name = "anchorLights";
    boats.frustumCulled = lamps.frustumCulled = false;
    this.moorings = [boats, lamps];
    this.group.add(boats, lamps);
    this.swingTo(2.4);
    for (const s of spots)
      lights.push({ x: s.x, z: s.z, height: s.L * 1.4, width: 0.12, color: new THREE.Color(1, 0.95, 0.85).multiplyScalar(0.9) });
  }

  /** Turn the moored boats to lie with their bows at yaw (scene radians). */
  private swingTo(yaw: number): void {
    this.swing = yaw;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const sc = new THREE.Vector3();
    this.mooringSpots.forEach((s, i) => {
      q.setFromAxisAngle(up, yaw + ((i * 0.37) % 0.3) - 0.15);
      m.compose(pos.set(s.x, 0, s.z), q, sc.setScalar(s.L));
      for (const im of this.moorings) im.setMatrixAt(i, m);
    });
    for (const im of this.moorings) im.instanceMatrix.needsUpdate = true;
  }

  /** Footprints of buildings and piers on a 2 m grid, widened by a cell, for keeping trees out. */
  private mask(d: TownFile): void {
    const W = Math.ceil(d.w / 2);
    const H = Math.ceil(d.h / 2);
    const m = new Uint8Array(W * H);
    const rings = [...d.buildings.map((b) => b.p), ...d.piers];
    for (const p of rings) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const [x, z] of p) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      const i0 = Math.max(Math.floor((x0 - d.x0) / 2) - 1, 0);
      const i1 = Math.min(Math.ceil((x1 - d.x0) / 2) + 1, W - 1);
      const j0 = Math.max(Math.floor((z0 - d.z0) / 2) - 1, 0);
      const j1 = Math.min(Math.ceil((z1 - d.z0) / 2) + 1, H - 1);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const cx = d.x0 + i * 2 + 1;
          const cz = d.z0 + j * 2 + 1;
          // Inside, or within a cell of an edge (crowns overhang a little, trunks don't).
          let hit = insideRing(p, cx, cz);
          for (let k = 0; !hit && k < 8; k++) hit = insideRing(p, cx + 2.5 * Math.cos(k * 0.785), cz + 2.5 * Math.sin(k * 0.785));
          if (hit) m[j * W + i] = 1;
        }
    }
    this.blockedMask = m;
  }

  /**
   * Each frame: the sun's elevation (deg) for the lights, the sea's size (m) for
   * the reflections, and the wind (m/s east, north) that the moored boats lie to.
   */
  update(t: number, sunEl: number, hs: number, wu: number, wv: number): void {
    const night = nightOf(sunEl);
    this.night.value = night;
    this.reflections?.update(t, night, hs);
    this.lampMat?.color.setRGB(1, 0.95, 0.82).multiplyScalar(0.25 + 2.5 * night);
    if (this.moorings.length && Math.hypot(wu, wv) > 0.5) {
      // Bow into the wind: the air moves towards (wu, -wv) in x east, z south.
      // Bow along (cos yaw, -sin yaw) pointing at (-wu, wv); they swing round slowly.
      const yaw = Math.atan2(-wv, -wu);
      const dy = Math.atan2(Math.sin(yaw - this.swing), Math.cos(yaw - this.swing));
      if (Math.abs(dy) > 0.02) this.swingTo(this.swing + dy * 0.02);
    }
  }

  /** The town's ground height (m) at a point in the town frame, for anything else that stands on it. */
  groundAt(x: number, z: number): number {
    const d = this.d;
    const i = Math.round(((x - d.x0) / d.w) * (d.nx - 1));
    const j = Math.round(((z - d.z0) / d.h) * (d.ny - 1));
    if (i < 0 || j < 0 || i >= d.nx || j >= d.ny) return 0;
    return this.hgt[j * d.nx + i] / 10;
  }
}
