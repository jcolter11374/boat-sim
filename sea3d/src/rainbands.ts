// Rain bands: in showery or stormy weather the rain falls in grey curtains under the
// heavier clouds, a few hundred metres to a kilometre or more across, that drift with
// the wind. You see them on the horizon, and when one passes over the boat the rain
// there comes down harder, then eases as it moves on. Driven by how hard it rains
// (the replay's logged rain, or the storm without it), so the hour's mean is about
// what was logged; the bands only gather it into showers. Cosmetic.

import * as THREE from "three";
import { R_EARTH } from "./land/shader";

const SHAFTS = 10;
const FIELD = 6000; // m, the square of sky the bands drift through, kept round the camera
const TOP = 420; // m, where a curtain meets its cloud

const vert = /* glsl */ `
attribute vec2 aUv;    // across -1..1, up 0..1
attribute vec2 aShaft; // seed, how dense it looks from here
varying vec2 vUv;
varying vec2 vShaft;
varying float vDist;
void main() {
  vUv = aUv;
  vShaft = aShaft;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDist = length(wp.xz - cameraPosition.xz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const frag = /* glsl */ `
uniform float uAmount, uFar, uTime, uSlant;
uniform vec3 uColor, uHaze;
varying vec2 vUv;
varying vec2 vShaft;
varying float vDist;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  float edge = 1.0 - smoothstep(0.35, 1.0, abs(vUv.x));
  // Thick under the cloud, ragged where it meets the sea, lost in the cloud at the top.
  float up = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.7, 1.0, vUv.y));
  // Streaks of heavier rain, leaning with the wind, slowly shifting.
  float s = vn(vec2(vUv.x * 7.0 + vUv.y * uSlant + vShaft.x * 50.0, vUv.y * 1.5 - uTime * 0.05));
  s = 0.45 + 0.55 * s + 0.25 * vn(vec2(vUv.x * 23.0 + vUv.y * uSlant * 3.0, vShaft.x * 9.0));
  float near = smoothstep(30.0, 150.0, vDist);
  float far = 1.0 - smoothstep(0.7 * uFar, 1.05 * uFar, vDist); // lost in the haze
  float a = uAmount * vShaft.y * edge * up * s * near * far * 0.75;
  if (a < 0.003) discard;
  gl_FragColor = vec4(mix(uColor, uHaze, clamp(vDist / uFar, 0.0, 1.0) * 0.6), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface Shaft {
  x: number;
  z: number;
  width: number;
  dense: number;
  seed: number;
}

export class RainBands {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** How hard it rains round the boat now, 0..1: more under a band, less between them. */
  local = 0;
  /** Bands in view, and the nearest band's distance (m) and compass bearing (for tests and pictures). */
  shown = 0;
  nearest = { m: Infinity, bearing: 0 };
  private shafts: Shaft[] = [];
  private pos: Float32Array;
  private look: Float32Array;

  constructor() {
    let s = 777;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < SHAFTS; i++) this.shafts.push({ x: rnd() * FIELD, z: rnd() * FIELD, width: 350 + 1300 * rnd() ** 2, dense: 0.5 + 0.5 * rnd(), seed: rnd() });
    const n = SHAFTS * 4;
    this.pos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const shaft = new Float32Array(n * 2);
    this.look = shaft;
    const index: number[] = [];
    for (let i = 0; i < SHAFTS; i++) {
      uv.set([-1, 0, 1, 0, 1, 1, -1, 1], i * 8);
      for (let k = 0; k < 4; k++) shaft.set([this.shafts[i].seed, this.shafts[i].dense], (i * 4 + k) * 2);
      const b = i * 4;
      index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("aUv", new THREE.BufferAttribute(uv, 2));
    g.setAttribute("aShaft", new THREE.BufferAttribute(shaft, 2));
    g.setIndex(index);
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uAmount: { value: 0 },
        uFar: { value: 3000 },
        uTime: { value: 0 },
        uSlant: { value: 0 },
        uColor: { value: new THREE.Color() },
        uHaze: { value: new THREE.Color() },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11; // after the sea, so crests hide their feet
    this.mesh.visible = false;
  }

  /**
   * Per frame. amount 0..1, how hard it rains on average (as Rain takes it); wind in
   * m/s towards +x (east) and +z (south); haze is the fog, whose far edge hides them.
   */
  update(t: number, camera: THREE.Camera, amount: number, windX: number, windZ: number, fog: THREE.Fog, light: number): void {
    const cx = camera.position.x;
    const cz = camera.position.z;
    const right = new THREE.Vector3();
    let under = 0;
    let shown = 0;
    this.nearest.m = Infinity;
    for (const [i, sh] of this.shafts.entries()) {
      // Drift with the wind (showers move with the wind a little above the sea), wrapped round the camera.
      const wrap = (v: number, c: number) => ((((v - c + FIELD / 2) % FIELD) + FIELD) % FIELD) - FIELD / 2 + c;
      const x = wrap(sh.x + windX * 0.9 * t, cx);
      const z = wrap(sh.z + windZ * 0.9 * t, cz);
      const d = Math.hypot(x - cx, z - cz);
      // Under a band: full in its middle, easing off over its edge.
      const r = d / (sh.width / 2);
      under = Math.max(under, sh.dense * (1 - THREE.MathUtils.smoothstep(r, 0.4, 1.1)));
      // Seen from inside, a curtain is the rain round the boat (Rain), not a wall.
      for (let k = 0; k < 4; k++) this.look[(i * 4 + k) * 2 + 1] = sh.dense * THREE.MathUtils.smoothstep(r, 0.7, 1.4);
      if (d < Math.max(fog.far * 1.6, 2000)) shown++;
      if (d < this.nearest.m) this.nearest = { m: d, bearing: (THREE.MathUtils.radToDeg(Math.atan2(x - cx, -(z - cz))) + 360) % 360 };
      // A curtain turned to face the camera, standing on the curved sea.
      right.set(-(z - cz), 0, x - cx).normalize().multiplyScalar(sh.width / 2);
      const drop = (d * d) / (2 * R_EARTH);
      const p = this.pos;
      const o = i * 12;
      p.set([x - right.x, -drop, z - right.z, x + right.x, -drop, z + right.z, x + right.x, TOP - drop, z + right.z, x - right.x, TOP - drop, z - right.z], o);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.aShaft.needsUpdate = true;
    // Heavier under a band, a little lighter between, never far below what was logged
    // at the boat: the logged rain is the hour's rain right here (GUESS display tuning).
    this.local = THREE.MathUtils.clamp(amount * (0.75 + 0.5 * under), 0, 1);
    this.shown = amount > 0.02 ? shown : 0;
    this.mesh.visible = amount > 0.02;
    if (!this.mesh.visible) return;
    const u = this.mesh.material.uniforms;
    u.uAmount.value = THREE.MathUtils.smoothstep(amount, 0.02, 0.5);
    // A dark curtain shows through haze that hides the paler sea under it, so they reach a little past the fog.
    u.uFar.value = Math.max(fog.far * 1.6, 2000);
    u.uTime.value = t;
    u.uSlant.value = THREE.MathUtils.clamp(Math.hypot(windX, windZ) / 15, 0, 1.5);
    const l = 0.2 + 0.8 * light;
    u.uColor.value.copy(fog.color).multiplyScalar(0.55 * l + 0.1);
    u.uHaze.value.copy(fog.color);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
