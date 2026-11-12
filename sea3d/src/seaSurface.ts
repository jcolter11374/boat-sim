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
float seaHeight(vec2 xz) {
  vec2 p = xz;
  // Two fixed-point steps find the surface point that has drifted onto xz.
  for (int j = 0; j < 2; j++) {
    vec3 d = seaDisplace(p);
    p = xz - d.xz;
  }
  return seaDisplace(p).y;
}
`;
