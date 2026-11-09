// The sea surface mesh: the same Gerstner sea as waves.ts, drawn with a grid
// that is fine near the boats and stretches out to the horizon.
//
// Inside the detail patch (SEA_SIZE across) the vertices move with the real
// waves. Further out the waves fade to a flat grid that runs on to HORIZON
// metres, so the sea meets the sky instead of ending in haze. The shader adds
// what the grid is too coarse to carry: small ripples and sun glitter, long
// swell texture in the distance, light glowing through the wave tops, and
// patchy whitecap foam. All of that is looks only; the physics reads waves.ts.

import * as THREE from "three";
import type { Quality } from "./boats/parts";
import { displace, type WaveComponent } from "./waves";

export const SEA_SIZE = 400; // m, side of the patch of moving sea
export const HORIZON = 3000; // m, half-width of the whole sea out to the horizon
const GRID: Record<Quality, { n: number; centre: number }> = {
  low: { n: 110, centre: 0.45 }, // segments per side, grid spacing at the centre (m)
  high: { n: 220, centre: 0.22 },
};
// Waves fade out between these distances from the centre (m), where the grid
// starts to stretch towards the horizon.
const FADE_IN = 100;
const FADE_OUT = 170;

const DEEP = new THREE.Color(0x041d33);
const SHALLOW = new THREE.Color(0x135a7e);

const VERT_HEAD = /* glsl */ `
attribute float foam;
uniform float uAmp;
varying vec3 vWPos;
varying float vFoam;
varying float vCrest;
`;
const VERT_BODY = /* glsl */ `
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFoam = foam;
vCrest = clamp(transformed.y / max(uAmp, 0.05), -1.0, 1.5);
`;

const FRAG_HEAD = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform float uSunI;
uniform vec3 uGlow;
uniform float uRough;
uniform float uCover;
uniform vec2 uWind;
varying vec3 vWPos;
varying float vFoam;
varying float vCrest;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
// Slope (d height / dx, d height / dz) of one deep-water ripple train.
vec2 ripple(vec2 p, float L, float ang, float slope, float t) {
  float k = 6.2831853 / L;
  vec2 d = vec2(cos(ang), sin(ang));
  float ph = k * dot(d, p) - sqrt(9.81 * k) * t;
  return d * (slope * cos(ph));
}
// Sum of ripple trains, each faded out once it is too small for the pixel
// (so the distance doesn't shimmer), plus long swell texture far out where the
// grid itself is flat.
vec2 rippleSlope(vec2 p, float t, float fp, float far) {
  vec2 g = vec2(0.0);
  float patchy = 0.55 + 0.9 * vnoise(p * 0.035 + t * 0.02);
  g += ripple(p, 0.33, 0.4, 0.035, t) * smoothstep(1.5, 5.0, 0.33 / fp);
  g += ripple(p, 0.57, 2.1, 0.032, t) * smoothstep(1.5, 5.0, 0.57 / fp);
  g += ripple(p, 0.91, 3.9, 0.03, t) * smoothstep(1.5, 5.0, 0.91 / fp);
  g += ripple(p, 1.63, 5.3, 0.028, t) * smoothstep(1.5, 5.0, 1.63 / fp);
  g += ripple(p, 2.71, 1.2, 0.025, t) * smoothstep(1.5, 5.0, 2.71 / fp);
  g += ripple(p, 4.30, 4.6, 0.022, t) * smoothstep(1.5, 5.0, 4.30 / fp);
  g *= patchy * uRough;
  vec2 s = ripple(p, 13.0, 0.9, 0.05, t) + ripple(p, 23.0, 2.6, 0.045, t) + ripple(p, 41.0, 5.6, 0.04, t);
  return g + s * far * uRough;
}
`;

const FRAG_COLOUR = /* glsl */ `
float distXZ = length(vWPos.xz - cameraPosition.xz);
float farMix = smoothstep(${FADE_IN.toFixed(1)}, ${FADE_OUT.toFixed(1)}, length(vWPos.xz)) ;
// Whitecaps: scattered by the wind everywhere (uCover is the share of sea
// that is white), more on high crests (vFoam), drawn out into streaks along
// the wind.
vec2 wd = uWind;
vec2 q = vec2(dot(vWPos.xz, wd), dot(vWPos.xz, vec2(-wd.y, wd.x)));
float fn = vnoise(vec2(q.x * 0.5, q.y * 1.4) + vec2(uTime * 0.05, 0.0)) * 0.5
         + vnoise(vec2(q.x * 1.6, q.y * 4.0) - uTime * 0.08) * 0.3
         + vnoise(vWPos.xz * 7.0 + uTime * 0.2) * 0.2;
float thr = 0.8 - 1.4 * uCover - 0.35 * vFoam;
float foamMask = smoothstep(thr, thr + 0.1, fn) * step(0.002, uCover + vFoam) * (1.0 - 0.6 * farMix);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.96, 0.98), foamMask);
`;

const FRAG_ROUGH = /* glsl */ `
roughnessFactor = mix(roughnessFactor, 0.75, foamMask);
`;

const FRAG_NORMAL = /* glsl */ `
{
  float fp = max(length(fwidth(vWPos.xz)), 1e-4);
  vec2 s = rippleSlope(vWPos.xz, uTime, fp, farMix) * (1.0 - 0.7 * foamMask);
  vec3 nW = (vec4(normal, 0.0) * viewMatrix).xyz; // view -> world
  nW = normalize(nW + vec3(-s.x, 0.0, -s.y));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}
`;

const FRAG_GLOW = /* glsl */ `
{
  // Light shining through the thin tops of waves: strongest looking towards a
  // low sun, on crests, never on foam.
  vec3 V = normalize(cameraPosition - vWPos);
  vec2 vh = normalize(V.xz + 1e-5);
  vec2 sh = normalize(-uSunDir.xz + 1e-5);
  float back = max(dot(vh, sh), 0.0);
  float crest = smoothstep(-0.2, 1.2, vCrest);
  float lowSun = 1.0 - 0.6 * smoothstep(0.3, 0.9, uSunDir.y);
  totalEmissiveRadiance += vec3(0.9, 0.95, 1.0) * foamMask * (0.06 + 0.25 * uSunI);
  totalEmissiveRadiance += uGlow * uSunI * crest * (0.35 + 0.65 * back * back) * lowSun * (1.0 - foamMask) * (1.0 - farMix);
}
`;

export class Sea {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  private base = new Float32Array();
  private fade = new Float32Array();
  private colours = new Float32Array();
  private foams = new Float32Array();
  private foamAmount = 0;
  private hs = 1;
  readonly steepness = 0.5;
  /** Shader inputs: set sunDir/sunIntensity from the scene's light. */
  readonly uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunI: { value: 1 },
    uGlow: { value: new THREE.Color(0x0d6f6a).multiplyScalar(0.55) },
    uRough: { value: 1 },
    uAmp: { value: 0.5 },
    uCover: { value: 0 },
    uWind: { value: new THREE.Vector2(1, 0) },
  };

  constructor(quality: Quality) {
    const material = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.05,
      metalness: 0,
      ior: 1.333,
      specularIntensity: 1,
      envMapIntensity: 0.7,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
    });
    material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = VERT_HEAD + sh.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\n" + VERT_BODY);
      sh.fragmentShader = (FRAG_HEAD + sh.fragmentShader)
        .replace("#include <color_fragment>", "#include <color_fragment>\n" + FRAG_COLOUR)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n" + FRAG_ROUGH)
        .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + FRAG_NORMAL)
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" + FRAG_GLOW);
    };
    material.customProgramCacheKey = () => "boatsim-sea-v2";
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.renderOrder = 10; // after the hulls, so keels show through
    this.mesh.frustumCulled = false;
    this.setQuality(quality);
  }

  /** Grid that is fine near the middle and reaches the horizon at the edge:
   *  x = a u + b u^3 + c u^25 for u in [-1, 1]. */
  setQuality(quality: Quality): void {
    const { n, centre } = GRID[quality];
    const half = SEA_SIZE / 2;
    const a = (centre * n) / 2;
    const b = half - a;
    const c = HORIZON - half;
    const geo = new THREE.PlaneGeometry(2, 2, n, n);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position.array as Float32Array;
    const fade = new Float32Array(p.length / 3);
    for (let i = 0; i < p.length; i += 3) {
      const u = p[i];
      const v = p[i + 2];
      p[i] = a * u + b * u ** 3 + c * u ** 25;
      p[i + 2] = a * v + b * v ** 3 + c * v ** 25;
      const r = Math.hypot(p[i], p[i + 2]);
      fade[i / 3] = 1 - THREE.MathUtils.smoothstep(r, FADE_IN, FADE_OUT);
    }
    this.base = Float32Array.from(p);
    this.fade = fade;
    this.colours = new Float32Array(p.length);
    this.foams = new Float32Array(p.length / 3);
    geo.setAttribute("color", new THREE.BufferAttribute(this.colours, 3));
    geo.setAttribute("foam", new THREE.BufferAttribute(this.foams, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.paintFlat();
  }

  get vertexCount(): number {
    return this.base.length / 3;
  }

  /** Sea state for the looks: Hs (m), and the wind if known (m/s, and the
   *  scene direction it blows towards). Without a wind, one that would raise
   *  this sea is assumed (fully developed sea, Hs = 0.0246 U^2). */
  setSea(hs: number, windMs?: number, towards?: THREE.Vector2): void {
    this.hs = hs;
    // Crest foam starts around a fresh breeze; none on a calm sea.
    this.foamAmount = THREE.MathUtils.clamp((hs - 0.8) / 3.2, 0, 1); // GUESS display tuning
    this.uniforms.uAmp.value = hs / 2;
    this.uniforms.uRough.value = THREE.MathUtils.clamp(0.6 + hs / 5, 0.6, 1.4); // GUESS display tuning
    const u = windMs ?? Math.sqrt(hs / 0.0246);
    // Share of the sea covered by whitecaps (Monahan & O'Muircheartaigh 1980).
    this.uniforms.uCover.value = THREE.MathUtils.clamp(3.84e-6 * u ** 3.41, 0, 0.2);
    if (towards && towards.lengthSq() > 0) this.uniforms.uWind.value.copy(towards).normalize();
  }

  setSeeThrough(on: boolean): void {
    this.mesh.material.opacity = on ? 0.45 : 0.95;
  }

  /** Point the glitter and the glow at the scene's sun (world direction towards it). */
  setSun(dir: THREE.Vector3, intensity: number): void {
    this.uniforms.uSunDir.value.copy(dir).normalize();
    this.uniforms.uSunI.value = intensity;
  }

  private paintFlat(): void {
    const col = this.colours;
    const mid = DEEP.clone().lerp(SHALLOW, 0.5);
    for (let i = 0; i < col.length; i += 3) {
      col[i] = mid.r;
      col[i + 1] = mid.g;
      col[i + 2] = mid.b;
    }
  }

  update(comps: WaveComponent[], t: number): void {
    this.uniforms.uTime.value = t;
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position;
    const arr = pos.array as Float32Array;
    const col = this.colours;
    const foams = this.foams;
    const amp = this.hs / 2;
    const foam = this.foamAmount;
    for (let i = 0, j = 0; i < arr.length; i += 3, j++) {
      const w = this.fade[j];
      if (w <= 0) continue; // flat far sea, already in place
      const x0 = this.base[i];
      const z0 = this.base[i + 2];
      const [dx, y, dz] = displace(comps, x0, z0, t, this.steepness);
      arr[i] = x0 + dx * w;
      arr[i + 1] = y * w;
      arr[i + 2] = z0 + dz * w;
      // Colour: deep in the troughs, lighter on the faces; foam on high crests.
      const h = amp > 0 ? (y * w) / amp : 0; // about -2..2
      const lift = THREE.MathUtils.clamp(0.5 + 0.3 * h, 0, 1);
      col[i] = DEEP.r + (SHALLOW.r - DEEP.r) * lift;
      col[i + 1] = DEEP.g + (SHALLOW.g - DEEP.g) * lift;
      col[i + 2] = DEEP.b + (SHALLOW.b - DEEP.b) * lift;
      foams[j] = foam > 0 ? foam * THREE.MathUtils.smoothstep(h, 0.4, 1.3) : 0;
    }
    pos.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.foam.needsUpdate = true;
    geo.computeVertexNormals();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
