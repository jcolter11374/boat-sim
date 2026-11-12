// Foam wake behind a boat: a strip of churned water that streams aft from the
// stern, widening and fading, with brighter lines along its two edges (the
// waves the hull pushes out to the sides). It lies on the waves and its foam
// pattern moves with the water, so it reads as foam on the sea rather than
// floating dots. Cosmetic; driven by the logged speed through the water.

import * as THREE from "three";
import { FOAM_LAMP_GLSL, FOAM_LAMP_UNIFORMS } from "./boats/navlights";
import type { Quality } from "./boats/parts";
import { toWorld, type Placement } from "./standin";
import { displace, type WaveComponent } from "./waves";

const ALONG: Record<Quality, number> = { low: 20, high: 32 };
const ACROSS = 7; // vertices across the strip
const LIFE = 9; // s for foam to fade away
const SPREAD = 0.22; // how fast the wake widens, m per m run

const vert = /* glsl */ `
  attribute vec2 aUV; // x: 0 at the stern .. 1 at the far end; y: -1 port edge .. 1 starboard edge
  varying vec2 vUV;
  varying vec3 vW;
  void main() {
    vUV = aUV;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const frag = /* glsl */ `
  ${FOAM_LAMP_GLSL}
  uniform float uOdo;   // water distance run, m
  uniform float uLen;   // strip length, m
  uniform float uI;     // strength 0..1
  uniform float uLight;
  uniform float uTime;
  varying vec2 vUV;
  varying vec3 vW;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  // Cell noise: distance to the nearest and second-nearest scattered point.
  vec2 cells(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 o = vec2(hash(i + g), hash(i + g + 17.3));
        float d = length(g + o - f);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
    return vec2(d1, d2);
  }
  // Churned foam: soft white blobs with ragged dark holes that open up as it ages (Elena:
  // a broad pale band that breaks up, not fine white hairs). Warped fractal noise, cut at a
  // level that rises with age.
  float fbm(vec2 q) {
    float f = 0.0, amp = 0.5;
    for (int i = 0; i < 4; i++) { f += amp * vnoise(q); q = q * 2.03 + 1.7; amp *= 0.5; }
    return f / 0.9375;
  }
  float lumps(vec2 q, float age) {
    q += (vec2(vnoise(q * 0.8), vnoise(q * 0.8 + 9.2)) - 0.5) * 1.4;
    float f = fbm(q * 2.2);
    float cut = mix(0.38, 0.62, age);
    return smoothstep(cut, cut + mix(0.2, 0.1, age), f);
  }
  void main() {
    // Pattern fixed to the water: a parcel d metres aft left the stern (odo - d) metres ago.
    float d = vUV.x * uLen;
    vec2 q = vec2(uOdo - d, vUV.y * (0.6 + d * ${SPREAD.toFixed(2)}));
    float age = vUV.x;                                   // 0 fresh .. 1 old
    // Ragged edges: the band's width wanders with the water, so it has no straight sides.
    float across = abs(vUV.y) + (vnoise(q * vec2(0.45, 0.9) + 11.0) * 0.7 + vnoise(q * vec2(1.4, 2.6) + 4.0) * 0.3 - 0.5) * 0.75;
    // A broad band of churned water, and the two fainter arms of the waves the hull pushes out.
    float band = (1.0 - smoothstep(0.2, 0.62, across)) * (1.0 - smoothstep(0.1, 1.0, age));
    float arms = smoothstep(0.55, 0.75, across) * (1.0 - smoothstep(0.8, 0.95, across)) * (1.0 - smoothstep(0.05, 0.7, age)) * 0.55;
    float body = max(band, arms) * (1.0 - smoothstep(0.75, 1.0, abs(vUV.y))); // never up to the strip's own edge
    // It breaks into islands as it spreads: big soft blobs, the gaps between them widening with age.
    float isl = vnoise(q * vec2(0.6, 1.3) + 2.0) * 0.65 + vnoise(q * vec2(2.0, 3.2) + uTime * 0.05) * 0.35;
    float keep = smoothstep(0.22 + 0.4 * age, 0.42 + 0.4 * age, isl + 0.18 * (1.0 - age));
    float churn = body * keep;
    float foam = churn * lumps(q + vec2(0.0, uTime * 0.02), age) * (1.0 - 0.5 * age);
    // Fresh foam under the stern is a churned white mass.
    float fresh = (1.0 - smoothstep(0.0, 0.2, age)) * (1.0 - smoothstep(0.3, 0.8, across));
    foam = max(foam, fresh * lumps(q * 1.3 + 5.7, 0.0));
    float a = foam * uI * smoothstep(0.0, 0.04, age);   // soft start under the stern
    // Bubbles just under the surface make the whole band a pale, milky turquoise.
    float milk = churn * uI * 0.22 * (1.0 - 0.6 * age) * (0.6 + 0.4 * isl);
    vec3 col = mix(vec3(0.55, 0.78, 0.8), vec3(0.86, 0.9, 0.91), clamp(a / max(a + milk, 1e-3), 0.0, 1.0));
    float alpha = clamp(max(0.85 * a, milk), 0.0, 0.85);
    gl_FragColor = vec4(col * (uLight + foamLamp(vW)), alpha);
  }
`;

export class Wake {
  /** The wake's mesh (add it to the scene). */
  readonly points: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly nAlong: number;
  private odo = 0; // water distance the boat has run, m
  private lastT = -1;

  /**
   * speed: water going past, m/s (the boat's cruising speed).
   * beam: hull width, m; sternX: stern position in the boat frame (negative).
   */
  constructor(
    quality: Quality,
    private readonly speed: number,
    private readonly beam: number,
    private readonly sternX: number,
  ) {
    this.nAlong = ALONG[quality];
    const nv = (this.nAlong + 1) * ACROSS;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    const uv = new Float32Array(nv * 2);
    const idx: number[] = [];
    for (let i = 0; i <= this.nAlong; i++) {
      for (let j = 0; j < ACROSS; j++) {
        // Finer near the stern, where the foam is busiest.
        uv.set([(i / this.nAlong) ** 1.4, (j / (ACROSS - 1)) * 2 - 1], (i * ACROSS + j) * 2);
        if (i < this.nAlong && j < ACROSS - 1) {
          const a = i * ACROSS + j;
          const b = a + ACROSS;
          idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
    }
    geo.setAttribute("aUV", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uOdo: { value: 0 }, uLen: { value: 1 }, uI: { value: 0 }, uLight: { value: 1 }, uTime: { value: 0 }, ...FOAM_LAMP_UNIFORMS },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.points = new THREE.Mesh(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 11; // on top of the sea
    this.points.name = "wake";
  }

  /** Foam brightness, 0..1: dimmer at dusk and night. */
  setLight(l: number): void {
    this.points.material.uniforms.uLight.value = l;
  }

  /** The drawn water's height under a point, if the page hands over the sea's own
   *  (Sea.surfaceAt); otherwise the big waves' height near enough. */
  surface: ((comps: WaveComponent[], x: number, z: number, t: number) => number) | null = null;

  /** Wake strength 0..1.3 by the hull's Froude number (speed / sqrt(g L)): a thin trail at a
   *  kayak's 2 kt (Fn 0.16), a broad foamy one near hull speed (Sam's checklist 5). */
  private strength(speed: number): number {
    const fn = speed / Math.sqrt(9.81 * Math.max(2 * Math.abs(this.sternX), 0.5));
    return Math.min(1.3, Math.max(0, (fn - 0.05) / 0.3));
  }

  reset(): void {
    this.odo = 0;
    this.lastT = -1;
  }

  /** speed: water going past now, m/s (defaults to the constructor's). */
  update(comps: WaveComponent[], t: number, place: Placement, speed = this.speed): void {
    if (this.lastT >= 0 && t > this.lastT) this.odo += speed * Math.min(t - this.lastT, 0.1);
    this.lastT = t;
    // The strip is as long as the water runs in the foam's lifetime (at least a boat's width).
    const len = Math.max(speed * LIFE, this.beam * 1.5);
    const k = this.strength(speed);
    const pos = this.points.geometry.attributes.position.array as Float32Array;
    const uv = this.points.geometry.attributes.aUV.array as Float32Array;
    for (let i = 0; i <= this.nAlong; i++) {
      const u = uv[i * ACROSS * 2];
      const d = u * len;
      const hw = 1.25 * (this.beam * 0.42 + d * SPREAD) * (0.45 + 0.55 * Math.min(1, k)); // a margin past the band, so its ragged edge never meets the strip's
      for (let j = 0; j < ACROSS; j++) {
        const k = i * ACROSS + j;
        const [x, z] = toWorld(this.sternX - d, uv[k * 2 + 1] * hw, place);
        // Height of the wave crossing this point (close enough for a foam sheet; the exact
        // inverse in heightAt costs several times more and this runs ~200 times a frame).
        const y = this.surface ? this.surface(comps, x, z, t) : displace(comps, x, z, t)[1];
        pos[k * 3] = x;
        pos[k * 3 + 1] = y + 0.02;
        pos[k * 3 + 2] = z;
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    const un = this.points.material.uniforms;
    un.uOdo.value = this.odo;
    un.uLen.value = len;
    un.uTime.value = t;
    un.uI.value = this.strength(speed);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
