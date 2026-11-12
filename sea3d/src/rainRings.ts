// Rain on the sea: small rings spreading from where drops land, and a pinprick splash
// at each one's start, close to the camera. Driven by the logged rain (rainFromRate)
// and the shower passing over (rainbands' local strength). Cosmetic.
//
// A GLSL chunk for the sea shader (water.ts): rainSlope() adds to the sea's near
// normal, faded out by the pixel's footprint so rings never shimmer in the distance.
// Each ring lives in its own cell, centred well inside it and never wider than half
// of it, so one cell is all a pixel needs to look at; which cells have a drop is
// re-drawn every cycle, and two layers of different sizes, one turned, hide the grid.

import * as THREE from "three";

export const rainUniforms = {
  /** x: how hard it rains here 0..1; y: Low quality (1) draws one layer only. */
  uRain: { value: new THREE.Vector2(0, 0) },
  /** The passing showers (rainbands.ts), for the sea under them: world x, z (m), width (m),
   *  and how hard it rains there 0..1 (0 when no showers show). Fixed at RAIN_SHOWERS. */
  uShowers: { value: Array.from({ length: 10 }, () => new THREE.Vector4()) },
};
export const RAIN_SHOWERS = 10;

/** Per frame: rate 0..1 (rainFromRate) and the shower over the boat 0..1 (bands.local). */
export function setRainOnSea(rate: number, local: number, low: boolean): void {
  rainUniforms.uRain.value.set(THREE.MathUtils.clamp(Math.max(rate * 0.6, local), 0, 1), low ? 1 : 0);
}

export const RAIN_RINGS = /* glsl */ `
uniform vec2 uRain;
uniform vec4 uShowers[10]; // x, z, width, dense: weight = dense * (1 - smoothstep(0.4, 1.1, dist / (width / 2)))
float rrHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
// One layer of rings: cell size in metres, a seed, how many cells have a drop (0..1).
vec2 rainLayer(vec2 p, float cell, float t, float dens, float seed) {
  vec2 q = p / cell;
  vec2 id = floor(q);
  float h0 = rrHash(id + seed);
  float period = 0.7 + 0.6 * h0;                  // s, each cell its own beat
  float cyc = t / period + rrHash(id + seed + 3.1);
  float age = fract(cyc);
  float n = floor(cyc);
  if (rrHash(id + seed + n * 1.73) > dens) return vec2(0.0); // no drop here this time
  vec2 c = id + 0.25 + 0.5 * vec2(rrHash(id + seed + n * 0.37 + 7.0), rrHash(id + seed + n * 0.91 + 13.0));
  vec2 d = q - c;
  float dl = max(length(d), 1e-4);
  float size = 0.6 + 0.4 * rrHash(id + seed + n * 2.3); // big and small drops
  float r = age * 0.24 * size;                    // the ring spreads to under half the cell
  float w = 0.025 + 0.035 * age;
  float x = (dl - r) / w;
  float amp = 0.55 * size * (1.0 - age) * (1.0 - age);
  // Slope of a ring-shaped bump (a gaussian round the circle), outwards.
  float g = -2.0 * x * exp(-x * x) * amp / w;
  // The splash: a sharp little spike as the drop lands.
  float sx = dl / 0.03;
  g += -2.0 * sx * exp(-sx * sx) * 0.4 * size * (1.0 - smoothstep(0.0, 0.12, age)) / 0.03;
  return (d / dl) * g * 0.02 / cell;
}
vec2 rainSlope(vec2 p, float t, float fp) {
  if (uRain.x < 0.01) return vec2(0.0);
  float near = 1.0 - smoothstep(0.02, 0.07, fp);  // gone before a ring is smaller than a pixel
  if (near <= 0.0) return vec2(0.0);
  float dens = 0.3 + 0.6 * uRain.x;
  vec2 s = rainLayer(p, 0.9, t, dens, 0.0);
  if (uRain.y < 0.5) {
    // A second, smaller layer, turned and shifted, so no grid shows.
    vec2 p2 = mat2(0.8, -0.6, 0.6, 0.8) * p + vec2(17.3, 5.1);
    s += mat2(0.8, 0.6, -0.6, 0.8) * rainLayer(p2, 0.62, t, dens * 0.8, 31.7);
  }
  return s * near * smoothstep(0.0, 0.2, uRain.x);
}
`;
