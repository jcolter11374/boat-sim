// The sea surface as other things see it: one height and normal for the drawn
// sea, in JavaScript (boat motion, cameras) and in GLSL (boat materials: the
// wet band at the waterline, the fade of parts below the surface).
//
// The sea shader (water.ts) and every material that includes SEA_SURFACE_PARS
// read the SAME uniform objects (seaUniforms), so updating the sea once updates
// them all. The sea mesh sits at the world origin, so world x, z is sea x, z.
//
// v1: the big waves (waves.ts), exactly as drawn: trochoidal Gerstner trains,
// the height at a fixed world point found by fixed-point steps (waves.ts
// heightAt). The FFT wind sea (display detail, capped small) adds a texture
// lookup inside seaHeight() later; the names here stay the same.

import * as THREE from "three";
import { MAX_GPU_WAVES, gpuWaves, heightAt, type WaveComponent } from "./waves";

/** The drawn sea at a fixed world point (m, s): height above still water, and the unit normal. */
export interface SeaSurface {
  heightAt(x: number, z: number, t: number): number;
  normalAt(x: number, z: number, t: number): [number, number, number];
}

/** Central-difference step for normals (m): short against any wave the boats feel. */
const DN = 0.25;

/** The big-wave sea as drawn, from this frame's wave trains (waves.ts). */
export function gerstnerSurface(comps: WaveComponent[], steepness = 0.5): SeaSurface {
  const h = (x: number, z: number, t: number) => heightAt(comps, x, z, t, steepness);
  return {
    heightAt: h,
    normalAt(x, z, t) {
      const sx = (h(x + DN, z, t) - h(x - DN, z, t)) / (2 * DN);
      const sz = (h(x, z + DN, t) - h(x, z - DN, t)) / (2 * DN);
      const l = Math.hypot(sx, 1, sz);
      return [-sx / l, 1 / l, -sz / l];
    },
  };
}

/**
 * Shared uniforms for the sea surface. water.ts writes them every frame
 * (writeSeaUniforms); materials that include SEA_SURFACE_PARS should merge this
 * object into their own uniforms (Object.assign(shader.uniforms, seaUniforms))
 * so they hold the same objects, not copies.
 */
export const seaUniforms = {
  uSeaTime: { value: 0 },
  uSeaN: { value: 0 },
  uSeaQ: { value: 0 },
  uSeaWa: { value: Array.from({ length: MAX_GPU_WAVES }, () => new THREE.Vector4()) }, // amplitude, k, omega, phase
  uSeaWd: { value: Array.from({ length: MAX_GPU_WAVES }, () => new THREE.Vector2()) }, // direction of travel (x, z)
  // The FFT short waves (seaDetail.ts): patches in use (0 = none), whether they
  // move the surface (Medium and High) or only shade it (Low), the patch sizes
  // (m), how far the water has gone by in each (m), and per patch two textures:
  // A = (sideways x, height, sideways z, foam), B = (slope x, slope z, Jacobian, 0).
  uSeaDetN: { value: 0 },
  uSeaDetMove: { value: 0 },
  uSeaDetRes: { value: 64 },
  uSeaDetSize: { value: new THREE.Vector2(1, 1) },
  uSeaDetOff0: { value: new THREE.Vector2() },
  uSeaDetOff1: { value: new THREE.Vector2() },
  uSeaDetA0: { value: null as THREE.Texture | null },
  uSeaDetB0: { value: null as THREE.Texture | null },
  uSeaDetA1: { value: null as THREE.Texture | null },
  uSeaDetB1: { value: null as THREE.Texture | null },
  // The sky the sea mirrors, from whoever draws the clouds (Kai, Hana): rgb is the
  // cloud deck's colour near the horizon (linear), w how much of the sky it hides
  // (0 = clear, reflections from the sky map alone; 1 = a closed deck).
  uSeaSky: { value: new THREE.Vector4(0, 0, 0, 0) },
  // A break in the deck toward the sun (Hana's Clouds.seaBreak): rgb its warm light
  // (linear), w how strong (0..1). The only glitter left under a deck is its column.
  uSeaBreak: { value: new THREE.Vector4(0, 0, 0, 0) },
  // The title's far water takes a little of the sky's warm horizon (Elena, 13 Nov): rgb that
  // colour (linear), w how much (0 everywhere else: no cost, no change).
  uSeaWarm: { value: new THREE.Vector4(0, 0, 0, 0) },
  uSeaGlint: { value: new THREE.Vector4(0, 0, 0, 0) },
};

/** Hand this frame's wave trains to every sea-reading shader. */
export function writeSeaUniforms(comps: WaveComponent[], t: number, steepness = 0.5): void {
  const w = gpuWaves(comps, steepness);
  const u = seaUniforms;
  u.uSeaTime.value = t;
  u.uSeaQ.value = w.q;
  u.uSeaN.value = w.n;
  for (let i = 0; i < w.n; i++) {
    u.uSeaWa.value[i].fromArray(w.wa, i * 4);
    u.uSeaWd.value[i].fromArray(w.wd, i * 2);
  }
}

/**
 * GLSL for any material: the uniforms above and
 *   vec3  seaDisplace(vec2 p)  the surface point that started at p (sideways x, up, sideways z)
 *   float seaHeight(vec2 xz)   height of the drawn sea at a fixed world point (m)
 * Same maths as waves.ts displace() / heightAt() (tests/seasurface.test.ts).
 */
export const SEA_SURFACE_PARS = /* glsl */ `
uniform float uSeaTime;
uniform int uSeaN;
uniform float uSeaQ;
uniform vec4 uSeaWa[${MAX_GPU_WAVES}];
uniform vec2 uSeaWd[${MAX_GPU_WAVES}];
vec3 seaDisplace(vec2 p) {
  vec3 d = vec3(0.0);
  for (int i = 0; i < ${MAX_GPU_WAVES}; i++) {
    if (i >= uSeaN) break;
    vec4 a = uSeaWa[i];
    vec2 u = uSeaWd[i];
    float th = a.y * dot(u, p) - a.z * uSeaTime + a.w;
    float qa = uSeaQ * a.x;
    d += vec3(-qa * u.x * sin(th), a.x * cos(th), -qa * u.y * sin(th));
  }
  return d;
}
uniform int uSeaDetN;
uniform float uSeaDetMove;
uniform float uSeaDetRes;
uniform vec2 uSeaDetSize;
uniform vec2 uSeaDetOff0;
uniform vec2 uSeaDetOff1;
uniform sampler2D uSeaDetA0;
uniform sampler2D uSeaDetB0;
uniform sampler2D uSeaDetA1;
uniform sampler2D uSeaDetB1;
uniform vec4 uSeaSky; // the cloud deck the sea mirrors: colour, cover
uniform vec4 uSeaBreak; // a break in the deck toward the sun: its light, strength
uniform vec4 uSeaWarm; // the title's far water warmed toward the sky's horizon: colour, how much
uniform vec4 uSeaGlint; // the title, sun behind the lens: warm light on the far ripples: colour, how much
// Texture coordinates of a sea point in each patch (texel centres sit on the grid points).
vec2 seaDetUv0(vec2 p) { return (p + uSeaDetOff0) / uSeaDetSize.x + 0.5 / uSeaDetRes; }
vec2 seaDetUv1(vec2 p) { return (p + uSeaDetOff1) / uSeaDetSize.y + 0.5 / uSeaDetRes; }
// The short waves' movement of the surface point that started at p (sideways x, up, sideways z); 0 on Low.
vec3 seaDetDisplace(vec2 p) {
  if (uSeaDetN == 0 || uSeaDetMove < 0.5) return vec3(0.0);
  vec3 d = texture2D(uSeaDetA0, seaDetUv0(p)).xyz;
  if (uSeaDetN > 1) d += texture2D(uSeaDetA1, seaDetUv1(p)).xyz;
  return d;
}
float seaHeight(vec2 xz) {
  vec2 p = xz;
  // Two fixed-point steps find the surface point that has drifted onto xz.
  for (int j = 0; j < 2; j++) {
    vec3 d = seaDisplace(p) + seaDetDisplace(p);
    p = xz - d.xz;
  }
  return seaDisplace(p).y + seaDetDisplace(p).y;
}
`;
