/** Shader pieces shared by the land layers (ground, surf, town, trees). */
import type * as THREE from "three";

export const R_EARTH = 6371000;

/** Drop far things with the earth's curve (world x, z from the boat); goes after <begin_vertex>. */
export const CURVE = `
  vec4 wpC = modelMatrix * vec4(transformed, 1.0);
  transformed.y -= dot(wpC.xz, wpC.xz) / ${(2 * R_EARTH).toFixed(1)};
`;

/** The same for instanced meshes: the instance's own place counts. */
export const CURVE_INSTANCED = `
  vec4 wpC = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
  transformed.y -= dot(wpC.xz, wpC.xz) / ${(2 * R_EARTH).toFixed(1)};
`;

export const NOISE = `
float lhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float lnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(lhash(i), lhash(i + vec2(1, 0)), f.x), mix(lhash(i + vec2(0, 1)), lhash(i + vec2(1, 1)), f.x), f.y);
}
`;

/** Bend a stock material's vertices with the earth (and run any extra hook after). */
export function bendWithEarth<M extends THREE.Material>(mat: M, key: string, instanced = false): M {
  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (sh, r) => {
    sh.vertexShader = sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\n${instanced ? CURVE_INSTANCED : CURVE}`);
    prev(sh, r);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

/** A small seeded random number source (mulberry32), so the same data always builds the same town. */
export function rnd(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Metres per degree of longitude and latitude at a latitude. */
export function metresPerDegree(lat: number): { mx: number; my: number } {
  return { mx: 111320 * Math.cos((lat * Math.PI) / 180), my: 110950 };
}

/**
 * Two-pass chamfer distance on a grid, in cells: 0 on cells where `seed` is true,
 * the distance to the nearest such cell elsewhere.
 */
export function distanceField(w: number, h: number, seed: (k: number) => boolean): Float32Array {
  const BIG = 1e9;
  const d = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) d[k] = seed(k) ? 0 : BIG;
  const D2 = Math.SQRT2;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + 1);
      if (j > 0) {
        v = Math.min(v, d[k - w] + 1);
        if (i > 0) v = Math.min(v, d[k - w - 1] + D2);
        if (i < w - 1) v = Math.min(v, d[k - w + 1] + D2);
      }
      d[k] = v;
    }
  for (let j = h - 1; j >= 0; j--)
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      let v = d[k];
      if (i < w - 1) v = Math.min(v, d[k + 1] + 1);
      if (j < h - 1) {
        v = Math.min(v, d[k + w] + 1);
        if (i < w - 1) v = Math.min(v, d[k + w + 1] + D2);
        if (i > 0) v = Math.min(v, d[k + w - 1] + D2);
      }
      d[k] = v;
    }
  return d;
}
