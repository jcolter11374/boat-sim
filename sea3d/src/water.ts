// The sea surface mesh: the same Gerstner sea as waves.ts, drawn with a grid
// that is fine near the boats and stretches out to the horizon.
//
// Inside the detail patch (SEA_SIZE across) the vertices move with the real
// waves. Further out the waves fade to a flat grid that runs on to HORIZON
// metres, so the sea meets the sky instead of ending in haze. The shader adds
// what the grid is too coarse to carry: small ripples and sun glitter, long
// swell texture in the distance, light glowing through the wave tops, and
// patchy whitecap foam. All of that is looks only; the physics reads waves.ts.
//
// The waves are moved on the graphics card (vertex shader), with the same
// Gerstner maths as waves.ts displace(): the page used to do it in JavaScript
// for every vertex every frame, which made High stutter.

import * as THREE from "three";
import type { Quality } from "./boats/parts";
import { MAX_GPU_WAVES, gpuWaves, type WaveComponent } from "./waves";

const MAX_WAVES = MAX_GPU_WAVES; // wave trains the shader can carry

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
attribute float fade;      // 1 inside the moving patch, 0 on the flat far sea
uniform float uAmp;        // Hs / 2
uniform float uFoamAmt;    // crest foam, 0..1
uniform float uTime;
uniform int uN;            // wave trains in use
uniform float uQ;          // sideways (trochoidal) scale so crests never fold
uniform vec4 uWa[${MAX_WAVES}]; // amplitude, k, omega, phase
uniform vec2 uWd[${MAX_WAVES}]; // direction of travel (x, z)
uniform vec3 uDeep;
uniform vec3 uShallow;
varying vec3 vWPos;
varying float vFoam;
varying float vCrest;
varying float vFade;
vec3 gDisp;
vec3 gNorm;
// Same as waves.ts displace(), plus the surface slope for the normal.
void gerstner(vec2 p, float w) {
  vec3 d = vec3(0.0);
  vec3 tx = vec3(1.0, 0.0, 0.0);
  vec3 tz = vec3(0.0, 0.0, 1.0);
  if (w > 0.0) {
    for (int i = 0; i < ${MAX_WAVES}; i++) {
      if (i >= uN) break;
      vec4 a = uWa[i];
      vec2 u = uWd[i];
      float th = a.y * dot(u, p) - a.z * uTime + a.w;
      float s = sin(th), c = cos(th);
      float qa = uQ * a.x;
      d += vec3(-qa * u.x * s, a.x * c, -qa * u.y * s);
      float k = a.y;
      tx += vec3(-qa * k * u.x * u.x * c, -a.x * k * u.x * s, -qa * k * u.x * u.y * c);
      tz += vec3(-qa * k * u.x * u.y * c, -a.x * k * u.y * s, -qa * k * u.y * u.y * c);
    }
  }
  gDisp = d * w;
  tx = mix(vec3(1.0, 0.0, 0.0), tx, w);
  tz = mix(vec3(0.0, 0.0, 1.0), tz, w);
  gNorm = normalize(cross(tz, tx));
}
`;
const VERT_NORMAL = /* glsl */ `
gerstner(position.xz, fade);
objectNormal = gNorm;
`;
const VERT_POS = /* glsl */ `
transformed += gDisp;
`;
const VERT_BODY = /* glsl */ `
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFade = fade;
float hRel = uAmp > 0.0 ? gDisp.y / uAmp : 0.0; // about -2..2
vCrest = clamp(gDisp.y / max(uAmp, 0.05), -1.0, 1.5);
vFoam = uFoamAmt > 0.0 ? uFoamAmt * smoothstep(0.4, 1.3, hRel) : 0.0;
#ifdef USE_COLOR
  // Deep in the troughs, lighter on the faces.
  vColor.rgb = mix(uDeep, uShallow, clamp(0.5 + 0.3 * hRel, 0.0, 1.0));
#endif
`;

const FRAG_HEAD = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform float uSunI;
uniform vec3 uGlow;
uniform float uRough;
uniform float uCover;
uniform vec2 uWind;
uniform float uChop;
uniform int uN;
uniform float uQ;
uniform vec4 uWa[${MAX_WAVES}];
uniform vec2 uWd[${MAX_WAVES}];
varying vec3 vWPos;
varying float vFoam;
varying float vCrest;
varying float vFade;

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
  // Wind chop (High and up): short-crested waves a few metres long, spread
  // round the wind, so the swell's long regular lines break up like real sea.
  if (uChop > 0.0) {
    float wa = atan(uWind.y, uWind.x);
    vec2 c = ripple(p, 2.3, wa + 0.35, 0.05, t) * smoothstep(1.5, 5.0, 2.3 / fp)
           + ripple(p, 3.1, wa - 0.62, 0.05, t) * smoothstep(1.5, 5.0, 3.1 / fp)
           + ripple(p, 4.4, wa + 0.95, 0.045, t)
           + ripple(p, 5.9, wa - 0.18, 0.045, t)
           + ripple(p, 7.7, wa + 1.25, 0.04, t)
           + ripple(p, 9.6, wa - 1.05, 0.04, t);
    float gust = 0.6 + 0.8 * vnoise(p * 0.02 + uWind * t * 0.03); // patches of stronger wind
    g += c * uChop * gust * (1.0 - far);
  }
  return g;
}
// Out where the grid is flat, the same wave trains the near sea moves with,
// carried on in the shading only: their slopes, each faded out once it is too
// short for the pixel. So the sea keeps its real, irregular pattern to the
// horizon instead of a few regular bands, and there is no seam where the
// moving patch ends. Wave groups: the trains beat against each other already;
// a slow patchiness on top keeps big stretches from looking the same.
vec2 swellSlope(vec2 p, float t, float fp) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < ${MAX_WAVES}; i++) {
    if (i >= uN) break;
    vec4 a = uWa[i];
    vec2 u = uWd[i];
    float th = a.y * dot(u, p) - a.z * t + a.w;
    float L = 6.2831853 / a.y;
    g -= u * (a.x * a.y * sin(th)) * smoothstep(1.5, 6.0, L / fp);
  }
  return g * (0.75 + 0.5 * vnoise(p * 0.004 + t * 0.003));
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
  if (vFade < 0.999) s += swellSlope(vWPos.xz, uTime, fp) * (1.0 - vFade);
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
  private colours = new Float32Array();
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
    uChop: { value: 0 },
    uFoamAmt: { value: 0 },
    uN: { value: 0 },
    uQ: { value: 0 },
    uWa: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
    uWd: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector2()) },
    uDeep: { value: new THREE.Vector3(DEEP.r, DEEP.g, DEEP.b) },
    uShallow: { value: new THREE.Vector3(SHALLOW.r, SHALLOW.g, SHALLOW.b) },
  };
  private detail = 0; // wind chop on (High) or off (Low)

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
      sh.vertexShader =
        VERT_HEAD +
        sh.vertexShader
          .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\n" + VERT_NORMAL)
          .replace("#include <begin_vertex>", "#include <begin_vertex>\n" + VERT_POS)
          .replace("#include <project_vertex>", "#include <project_vertex>\n" + VERT_BODY);
      sh.fragmentShader = (FRAG_HEAD + sh.fragmentShader)
        .replace("#include <color_fragment>", "#include <color_fragment>\n" + FRAG_COLOUR)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n" + FRAG_ROUGH)
        .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + FRAG_NORMAL)
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" + FRAG_GLOW);
    };
    material.customProgramCacheKey = () => "boatsim-sea-v5";
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.renderOrder = 10; // after the hulls, so keels show through
    this.mesh.frustumCulled = false;
    this.setQuality(quality);
  }

  /** Grid that is fine near the middle and reaches the horizon at the edge:
   *  x = a u + b u^3 + c u^25 for u in [-1, 1]. */
  setQuality(quality: Quality): void {
    const { n, centre } = GRID[quality];
    this.detail = quality === "high" ? 1 : 0;
    this.uniforms.uChop.value = this.detail * this.chopFor(this.wind);
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
    this.colours = new Float32Array(p.length);
    geo.setAttribute("color", new THREE.BufferAttribute(this.colours, 3));
    geo.setAttribute("fade", new THREE.BufferAttribute(fade, 1));
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
    this.wind = u;
    this.uniforms.uChop.value = this.detail * this.chopFor(u);
  }

  private wind = 6;
  /** Chop strength from the wind (m/s): faint in a light air, full in a gale. */
  private chopFor(u: number): number {
    return THREE.MathUtils.clamp(0.25 + u / 14, 0.25, 1.3); // GUESS display tuning
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

  /** Move the waves: hands this frame's wave trains to the shader. */
  update(comps: WaveComponent[], t: number): void {
    const u = this.uniforms;
    u.uTime.value = t;
    // Packed by waves.ts so the shader uses exactly displace()'s numbers.
    const w = gpuWaves(comps, this.steepness);
    u.uQ.value = w.q;
    for (let i = 0; i < w.n; i++) {
      u.uWa.value[i].fromArray(w.wa, i * 4);
      u.uWd.value[i].fromArray(w.wd, i * 2);
    }
    const n = w.n;
    u.uN.value = n;
    u.uAmp.value = this.hs / 2;
    u.uFoamAmt.value = this.foamAmount;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
