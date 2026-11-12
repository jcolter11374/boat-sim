// The water a moving hull pushes about (Elena's fix 3): a bow wave that climbs the hull
// at the stem and runs aft along its sides, a dip amidships, a hump at the stern, and the
// foam on them, all growing with speed. One GLSL function, boatWave(xz), gives the
// height (m) the hulls add to the sea at a world point, and boatFoam(xz) its foam; the
// sea shader draws both (water.ts, at its "boat wash" fence), and the hull materials
// use boatWave too (boats/inWater.ts), so the wet line on the hull follows the bow wave.
// Display only: the motion model floats on the open sea (seaSurface.ts).

import * as THREE from "three";

export const MAX_WASH_BOATS = 4;
const G = 9.81;

export const washUniforms = {
  uWashN: { value: 0 },
  /** Per boat: centre x, z (m), and the bow's direction in xz (cos, sin of the heading). */
  uWashPos: { value: Array.from({ length: MAX_WASH_BOATS }, () => new THREE.Vector4()) },
  /** Per boat: half waterline length, half beam (m), bow-wave height (m), foam 0..1. */
  uWashDim: { value: Array.from({ length: MAX_WASH_BOATS }, () => new THREE.Vector4()) },
  /** Per boat: green water over the deck now: height (m), crest centre and half width
   *  along the hull (-1 stern .. 1 bow), and unused. */
  uWashOver: { value: Array.from({ length: MAX_WASH_BOATS }, () => new THREE.Vector4()) },
};

/** Bow-wave height (m) for a hull at this speed: GUESS, 0.6 of the stagnation head
 *  v^2 / 2g, capped at 0.35 m (a fast cruiser's bow wave, not a ship's). */
export function bowWaveHeight(speed: number): number {
  return Math.min(0.35, (0.6 * speed * speed) / (2 * G));
}

const free: boolean[] = Array.from({ length: MAX_WASH_BOATS }, () => true);

/** One boat's slot in the wash uniforms; null when all are taken (it then makes none). */
export class WashSlot {
  private constructor(private readonly i: number) {}

  static take(): WashSlot | null {
    const i = free.indexOf(true);
    if (i < 0) return null;
    free[i] = false;
    washUniforms.uWashN.value = Math.max(washUniforms.uWashN.value, i + 1);
    washUniforms.uWashDim.value[i].set(0, 0, 0, 0);
    washUniforms.uWashOver.value[i].set(0, 0, 1, 0);
    return new WashSlot(i);
  }

  /** x, z: hull centre (m); yaw: three.js rotation.y (bow along (cos yaw, -sin yaw));
   *  length, beam: waterline (m); speed through the water (m/s); foam 0..1. */
  set(x: number, z: number, yaw: number, length: number, beam: number, speed: number, foam: number): void {
    washUniforms.uWashPos.value[this.i].set(x, z, Math.cos(yaw), -Math.sin(yaw));
    washUniforms.uWashDim.value[this.i].set(length / 2, beam / 2, bowWaveHeight(speed), foam);
  }

  /** A crest breaking over the deck: height (m) of water over it, centred at s along
   *  the hull (-1 stern .. 1 bow) with half width w; height 0 for none. pile (m): the sea
   *  heaped against the whole hull side in a gale, climbing it (Elena r10). */
  setOver(height: number, s: number, w = 0.45, pile = 0): void {
    washUniforms.uWashOver.value[this.i].set(height, s, w, pile);
  }

  release(): void {
    washUniforms.uWashDim.value[this.i].set(0, 0, 0, 0);
    washUniforms.uWashOver.value[this.i].set(0, 0, 1, 0);
    free[this.i] = true;
    let n = 0;
    for (let k = 0; k < MAX_WASH_BOATS; k++) if (!free[k]) n = k + 1;
    washUniforms.uWashN.value = n;
  }
}

/** GLSL: boatWave(xz) on the open water, boatWaveOnHull(xz) on a hull's skin, boatFoam(xz, t). */
export const BOAT_WASH_PARS = /* glsl */ `
uniform int uWashN;
uniform vec4 uWashPos[${MAX_WASH_BOATS}];
uniform vec4 uWashDim[${MAX_WASH_BOATS}];
uniform vec4 uWashOver[${MAX_WASH_BOATS}];
float washHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float washNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(washHash(i), washHash(i + vec2(1, 0)), u.x), mix(washHash(i + vec2(0, 1)), washHash(i + vec2(1, 1)), u.x), u.y);
}
// Hull half-width at a fraction s (-1 stern .. 1 bow) of its half length: fine at the
// ends, full amidships (GUESS: one shape for every hull).
float washHalfWidth(float s, float hb) {
  float e = clamp(1.0 - pow(abs(s), 2.2), 0.0, 1.0);
  return hb * pow(e, 0.45);
}
// For boat i at world xz: x along (bow +), y across, z the hull's own half width there,
// w how far that point is out from the hull side (m).
vec4 washLocal(int i, vec2 xz) {
  vec4 p = uWashPos[i];
  vec2 d = xz - p.xy;
  float a = dot(d, p.zw);
  float b = dot(d, vec2(-p.w, p.z));
  float hl = max(uWashDim[i].x, 0.01);
  float hw = washHalfWidth(clamp(a / hl, -1.0, 1.0), uWashDim[i].y);
  float out_ = abs(b) - (abs(a) <= hl ? hw : 0.0);
  if (abs(a) > hl) out_ = length(vec2(abs(a) - hl, abs(b)));
  return vec4(a, b, hw, out_);
}
// Boat i's green water at a point (local frame l, s along): metres, 0 when none.
float washOverK(int i, vec4 l, float s) {
  vec4 ov = uWashOver[i];
  if (ov.x <= 0.001) return 0.0;
  return ov.x * exp(-pow((s - ov.y) / ov.z, 2.0)) * (1.0 - smoothstep(0.0, 0.8, l.w));
}
/** Green water over any hull at xz (m above the local waterline), for the hull's skin. */
float washOverAt(vec2 xz) {
  float y = 0.0;
  for (int i = 0; i < ${MAX_WASH_BOATS}; i++) {
    if (i >= uWashN) break;
    if (uWashOver[i].x <= 0.001) continue;
    vec4 l = washLocal(i, xz);
    y = max(y, washOverK(i, l, l.x / max(uWashDim[i].x, 0.01)));
  }
  return y;
}
float boatWaveK(vec2 xz, float onHull) {
  float y = 0.0;
  for (int i = 0; i < ${MAX_WASH_BOATS}; i++) {
    if (i >= uWashN) break;
    vec4 dim = uWashDim[i];
    float H = dim.z;
    if (H <= 0.0005 && uWashOver[i].x <= 0.001 && uWashOver[i].w <= 0.001) continue;
    // Cheap reject first: nothing reaches more than a few crest widths past the hull ends.
    vec2 dd = xz - uWashPos[i].xy;
    float rr = dim.x + 0.6 + 0.4 * dim.x;
    if (dot(dd, dd) > rr * rr) continue;
    vec4 l = washLocal(i, xz);
    float hl = dim.x;
    float s = l.x / hl;
    float w = 0.12 + 0.1 * hl; // crest width (m)
    float side = exp(-pow(max(l.w, 0.0) / w, 2.0)); // on the hull side, falling away outside
    float bow = smoothstep(-0.1, 0.75, s) * (1.0 - smoothstep(1.0, 1.0 + 0.6 * w / hl, s));
    float mid = exp(-pow((s + 0.25) / 0.35, 2.0));
    float stern = exp(-pow((s + 1.0) / 0.2, 2.0));
    float k = side * (bow - 0.35 * mid + 0.45 * stern);
    // The sea keeps its full rise a little way inside the hull outline, so a mesh triangle
    // spanning the hull side still reaches it; deeper inside, none (the hull hides it).
    k *= max(onHull, smoothstep(-0.2, -0.03, l.w));
    y += H * k;
    // The sea heaped against the hull side in a gale (on the skin too, so the hull's wet
    // line climbs with it); only outside the outline on the open water.
    float pileW = 0.3;
    y += uWashOver[i].w * exp(-pow(max(l.w, 0.0) / pileW, 2.0)) * max(onHull, smoothstep(-0.2, -0.03, l.w));
    // Green water is not drawn by lifting the sea (a smooth mound through or beside the
    // hull, Ines r5): it's a white sheet on the hull's skin (washOverAt, inWater.ts) and
    // the drops pouring off (contact.ts).
  }
  return y;
}
/** Where along its hull a point on a hull's skin is: -1 stern .. 1 bow (the nearest hull); -2 if none. */
float washAlong(vec2 xz) {
  float best = 1e9, s = -2.0;
  for (int i = 0; i < ${MAX_WASH_BOATS}; i++) {
    if (i >= uWashN) break;
    if (uWashDim[i].x <= 0.0) continue;
    vec4 l = washLocal(i, xz);
    if (l.w < best) { best = l.w; s = clamp(l.x / uWashDim[i].x, -1.0, 1.0); }
  }
  return s;
}
/** How much of the sky a hull hides from the water right beside it, 0..1: the sea along
 *  the hull is darker (it mirrors the dark topsides, not the bright sky), the contact
 *  line that seats a boat in the water at any sea state (Ines: no "sticker" on the sea). */
float washShade(vec2 xz) {
  float o = 0.0;
  for (int i = 0; i < ${MAX_WASH_BOATS}; i++) {
    if (i >= uWashN) break;
    vec4 dim = uWashDim[i];
    if (dim.x <= 0.0) continue;
    vec2 dd = xz - uWashPos[i].xy;
    float rr = dim.x + dim.y + 1.0;
    if (dot(dd, dd) > rr * rr) continue;
    vec4 l = washLocal(i, xz);
    float reach = 0.25 + 0.5 * dim.y; // GUESS: about the freeboard, a bit more on a beamy hull
    o = max(o, exp(-pow(max(l.w, 0.0) / reach, 2.0)));
  }
  return o;
}
/** The hulls' waves on the open water (none inside a hull). */
float boatWave(vec2 xz) { return boatWaveK(xz, 0.0); }
/** The same, read from the hull's own skin: the height the water climbs to there. */
float boatWaveOnHull(vec2 xz) { return boatWaveK(xz, 1.0); }
float boatFoam(vec2 xz, float t) {
  float f = 0.0;
  for (int i = 0; i < ${MAX_WASH_BOATS}; i++) {
    if (i >= uWashN) break;
    vec4 dim = uWashDim[i];
    if (dim.w <= 0.001) continue;
    // Cheap reject first (most of the screen is far from any hull): skip the noise there.
    vec2 dd = xz - uWashPos[i].xy;
    float rr = dim.x + dim.y + 1.25 * (0.06 + 0.3 * dim.w + 2.0 * dim.z) + 0.2;
    if (dot(dd, dd) > rr * rr) continue;
    vec4 l = washLocal(i, xz);
    float hl = dim.x;
    float s = l.x / hl;
    if (l.w > 1.25 * (0.06 + 0.3 * dim.w + 2.0 * dim.z)) continue;
    // Thick where the bow wave breaks, thinning aft, with gaps along the sides (Elena, WIP 2).
    float bowK = smoothstep(-0.6, 0.85, s);
    float reach = (0.06 + 0.3 * dim.w + 2.0 * dim.z) * mix(0.4, 1.25, bowK); // m out from the hull
    float band = 1.0 - smoothstep(0.0, reach, max(l.w, 0.0));
    float along = smoothstep(-1.2, 0.9, s) * (1.0 - smoothstep(1.0, 1.15, s));
    // Foam streams aft past the hull: noise in the hull frame, slid aft with time.
    float slide = t * 2.5 * (0.3 + dim.w);
    vec2 q = vec2(l.x * 2.2 + slide, l.y * 6.0);
    float n = washNoise(q) * 0.6 + washNoise(q * 2.3 + 7.0) * 0.4;
    float gaps = smoothstep(0.3, 0.6, washNoise(vec2((l.x + slide / 2.2) * 0.8, sign(l.y) * 3.1 + 1.7)));
    float patchy = mix(gaps, 1.0, smoothstep(0.55, 0.9, s));
    f = max(f, band * along * patchy * smoothstep(0.62 - 0.35 * dim.w * (0.5 + 0.5 * bowK), 0.85, n) * dim.w * (0.55 + 0.4 * bowK));
  }
  return clamp(f, 0.0, 1.0);
}
`;

/** Sea vertex shader: lift the sea by the hulls' waves (after the open-sea displacement). */
export const BOAT_WASH_VERTEX = /* glsl */ `
transformed.y += boatWave((modelMatrix * vec4(transformed, 1.0)).xz);
`;

/** Sea fragment shader, at water.ts's "boat wash" fence: the hulls' foam, as whitecaps are drawn. */
export const BOAT_WASH_FRAGMENT = /* glsl */ `
{
  float wash = boatFoam(vWPos.xz, uTime);
  foamMask = max(foamMask, wash);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.9, 0.91), 0.85 * wash);
}
`;
