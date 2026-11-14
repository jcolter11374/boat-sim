// Prop wash: the short churned white trail a running motor leaves on the water astern of
// its propeller. The propellers themselves turn under the sea where nobody sees them, so
// this is how a motor shows it is running, and how a dead one shows it has stopped (M5:
// a dead motor visibly stops): its trail dies away as the propeller runs down.
// Cosmetic, GUESS by eye; driven by the gear's own propeller speed (boats/gear.ts).

import * as THREE from "three";

const ALONG = 10; // segments along each trail
const ACROSS = 3; // vertices across it
const START = 0.2; // m aft of the propeller, where the wash comes out from under the stern
const SPIN_FULL = 24; // rad/s: the gear's propeller speed at about three quarters of cruising

function smooth(x: number, a: number, b: number): number {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/**
 * How strong a motor's trail is, 0..1. spin: its propeller's speed (rad/s, the gear's);
 * speed: the boat's speed through the water over her cruising speed; hs: the sea's
 * significant wave height (m). A stopped propeller leaves none; a boat standing still
 * leaves none (nothing carries it aft); a rough sea breaks most of it up.
 */
export function washStrength(spin: number, speed: number, hs = 0): number {
  return Math.min(1, Math.max(0, spin / SPIN_FULL)) * smooth(speed, 0.05, 0.5) * (1 - 0.6 * smooth(hs, 1.5, 4));
}

const vert = /* glsl */ `
  attribute vec2 aUV; // x: 0 at the stern .. 1 at the trail's end; y: -1 .. 1 across
  attribute float aI; // which motor
  varying vec2 vUV;
  varying float vI;
  void main() {
    vUV = aUV;
    vI = aI;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;
const frag = /* glsl */ `
  uniform vec4 uK;     // each motor's strength
  uniform float uOdo;  // water distance run, m
  uniform float uLen;  // trail length, m
  uniform float uLight;
  varying vec2 vUV;
  varying float vI;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  void main() {
    float k = vI < 0.5 ? uK.x : vI < 1.5 ? uK.y : vI < 2.5 ? uK.z : uK.w;
    // The pattern is fixed to the water: it streams aft as the boat moves on.
    vec2 q = vec2((uOdo - vUV.x * uLen) * 7.0, vUV.y * 1.6 + vI * 7.3);
    float n = 0.6 * vnoise(q) + 0.4 * vnoise(q * 2.7 + 3.1);
    float body = (1.0 - smoothstep(0.3, 1.0, abs(vUV.y))) * pow(1.0 - vUV.x, 1.5) * smoothstep(0.0, 0.1, vUV.x);
    float a = k * body * smoothstep(0.25, 0.7, n + 0.4 * (1.0 - vUV.x));
    gl_FragColor = vec4(vec3(0.88, 0.93, 0.94) * uLight, 0.7 * a * mix(0.6, 1.0, smoothstep(0.1, 0.4, uLight)));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class PropWash {
  /** The trails' mesh (add it to the scene; its vertices are in world space). */
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** The drawn water's height at a point (the page hands over the sea's own). */
  surface: ((x: number, z: number) => number) | null = null;
  /** Each motor's trail strength now, 0..1 (for tests and pictures). */
  readonly shown = { strength: [] as number[] };
  private odo = 0;
  private lastT = -1;

  /** motors: how many propellers (up to 4). */
  constructor(private readonly motors: number) {
    const per = (ALONG + 1) * ACROSS;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(motors * per * 3), 3));
    const uv = new Float32Array(motors * per * 2);
    const which = new Float32Array(motors * per);
    const idx: number[] = [];
    for (let m = 0; m < motors; m++)
      for (let i = 0; i <= ALONG; i++)
        for (let j = 0; j < ACROSS; j++) {
          const k = m * per + i * ACROSS + j;
          uv.set([i / ALONG, (j / (ACROSS - 1)) * 2 - 1], k * 2);
          which[k] = m;
          if (i < ALONG && j < ACROSS - 1) idx.push(k, k + ACROSS, k + 1, k + ACROSS, k + ACROSS + 1, k + 1);
        }
    geo.setAttribute("aUV", new THREE.BufferAttribute(uv, 2));
    geo.setAttribute("aI", new THREE.BufferAttribute(which, 1));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uK: { value: new THREE.Vector4() }, uOdo: { value: 0 }, uLen: { value: 1 }, uLight: { value: 1 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12; // on top of the sea and the hull's own wake
    this.mesh.name = "propwash";
  }

  /**
   * props: each propeller's place in the world now; aftX, aftZ: the way astern (unit, world);
   * spin: each propeller's speed (rad/s, the gear's shown.spin); speedMs: water going past (m/s);
   * cruiseMs: her cruising speed; hs: the sea's height (m); light: foam brightness 0..1.
   */
  update(t: number, props: THREE.Vector3[], aftX: number, aftZ: number, spin: number[], speedMs: number, cruiseMs: number, hs: number, light: number): void {
    if (this.lastT >= 0 && t > this.lastT) this.odo += speedMs * Math.min(t - this.lastT, 0.1);
    this.lastT = t;
    const len = Math.min(2.2, Math.max(0.5, speedMs * 1.6));
    const pos = this.mesh.geometry.attributes.position.array as Float32Array;
    const per = (ALONG + 1) * ACROSS;
    const k = this.mesh.material.uniforms.uK.value as THREE.Vector4;
    for (let m = 0; m < this.motors; m++) {
      const s = washStrength(spin[m] ?? 0, cruiseMs > 0 ? speedMs / cruiseMs : 0, hs);
      this.shown.strength[m] = Math.round(s * 100) / 100;
      k.setComponent(m, s);
      const p = props[m];
      if (!p) continue;
      for (let i = 0; i <= ALONG; i++) {
        const d = START + (i / ALONG) * len;
        const hw = 0.07 + 0.16 * (i / ALONG); // widens aft
        for (let j = 0; j < ACROSS; j++) {
          const side = ((j / (ACROSS - 1)) * 2 - 1) * hw;
          const x = p.x + aftX * d - aftZ * side;
          const z = p.z + aftZ * d + aftX * side;
          const o = (m * per + i * ACROSS + j) * 3;
          pos[o] = x;
          pos[o + 1] = (this.surface ? this.surface(x, z) : 0) + 0.03;
          pos[o + 2] = z;
        }
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    const un = this.mesh.material.uniforms;
    un.uOdo.value = this.odo;
    un.uLen.value = len;
    un.uLight.value = light;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
