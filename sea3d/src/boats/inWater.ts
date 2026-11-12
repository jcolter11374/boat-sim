// A boat IN the water, not on it (Elena's fix 3): every hull material learns where the
// drawn sea surface is (seaSurface.ts, the same waves the sea shader draws), and
//  - below it, fades into the water's colour with depth: a faint green-blue hint of the
//    keel just under the surface, nothing by about 2 m down (no "stilts" from above);
//  - just above it, a wet sheen a few cm high that comes and goes with the waves;
//  - right at it, a thin broken line of foam that flickers.
// Display only: reads the sea, changes nothing the simulator or the motion model sees.

import * as THREE from "three";
import { BOAT_WASH_PARS, washUniforms } from "../boatWash";
import { SEA_SURFACE_PARS, seaUniforms } from "../seaSurface";

/** One boat's water look; update() every frame. */
export interface InWaterLook {
  /** Wet band height (m) above the surface: higher with speed and waves. */
  wetH: number;
  /** Foam line strength 0..1. */
  foam: number;
  /** Scene light for the water's own colour and the foam (atmosphere ambient, 0..1). */
  light: number;
}

const PARS = /* glsl */ `
${SEA_SURFACE_PARS}
${BOAT_WASH_PARS}
uniform float uWetH;
uniform float uWetFoam;
uniform float uWetLight;
uniform vec3 uWaterTint;
varying vec3 vSeaW;
float iwHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float iwNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(iwHash(i), iwHash(i + vec2(1, 0)), u.x), mix(iwHash(i + vec2(0, 1)), iwHash(i + vec2(1, 1)), u.x), u.y);
}
`;

const BODY = /* glsl */ `
{
  float h = vSeaW.y - seaHeight(vSeaW.xz) - boatWaveOnHull(vSeaW.xz); // + above the water (with the bow wave), - below
  vec3 water = uWaterTint * uWetLight;
  if (h < 0.0) {
    // GUESS (by eye): half gone at 0.5 m, 94 % gone at 2 m; the clearest part green-blue.
    float k = 1.0 - exp(h / 0.7);
    // Just under the surface it reads as wet hull; the green-blue cast comes in with depth.
    vec3 under = mix(gl_FragColor.rgb * 0.62, gl_FragColor.rgb * vec3(0.5, 0.68, 0.72), smoothstep(0.0, 0.3, -h));
    gl_FragColor.rgb = mix(under, water, k);
  } else {
    // Gelcoat: surfaces facing down sit in the hull's own shade; a faint water mark
    // just above the waterline.
    vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
    gl_FragColor.rgb *= 1.0 - 0.45 * clamp(-nW.y, 0.0, 1.0); // seen mostly in the reflection: dark, not a pale gap (Ines r5)
    float mark = (1.0 - smoothstep(0.02, 0.18, h)) * (0.6 + 0.4 * iwNoise(vSeaW.xz * vec2(1.3, 9.0)));
    gl_FragColor.rgb *= 1.0 - 0.08 * mark;
    vec2 q = vSeaW.xz * 7.0 + vec2(uSeaTime * 0.9, -uSeaTime * 0.6);
    float n = iwNoise(q) * 0.6 + iwNoise(q * 2.7) * 0.4;
    float band = uWetH * (0.5 + n);
    float wet = 1.0 - smoothstep(0.0, max(band, 1e-3), h);
    gl_FragColor.rgb *= mix(1.0, 0.62, wet); // darker where it's wet
    float line = 1.0 - smoothstep(0.0, 0.015 + 0.015 * n, h);
    float bits = smoothstep(0.42, 0.7, iwNoise(vSeaW.xz * 18.0 + uSeaTime * 2.3));
    // More at the bow, thin and broken aft (none read where no hull is known).
    float sAl = washAlong(vSeaW.xz);
    float bowK = sAl < -1.5 ? 0.6 : smoothstep(-0.6, 0.85, sAl);
    float gaps = smoothstep(0.3, 0.6, iwNoise(vSeaW.xz * 1.6 + vec2(uSeaTime * 0.7, 0.0)));
    bits *= mix(gaps, 1.0, bowK) * (0.45 + 0.55 * bowK);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.78, 0.83, 0.86) * uWetLight, line * bits * uWetFoam * 0.5);
    // Green water coming aboard (Ines r5): a broken white sheet climbing the side and over
    // the deck, streaming down and off as it drains; the hull stays solid under it.
    float ovh = washOverAt(vSeaW.xz);
    if (ovh > 0.01) {
      vec2 qs = vec2((vSeaW.x + vSeaW.z) * 1.4, vSeaW.y * 3.0 + uSeaTime * 3.0); // streams down
      float sn = iwNoise(qs) * 0.55 + iwNoise(qs * 2.3 + 3.1) * 0.3 + iwNoise(vSeaW.xz * 9.0) * 0.15;
      float edge = (iwNoise(vec2((vSeaW.x + vSeaW.z) * 2.5, uSeaTime * 1.5)) - 0.5) * 0.5 * ovh; // ragged top
      float cover = 1.0 - smoothstep(0.7 * ovh, ovh, h + edge);
      float sheet = cover * smoothstep(0.42, 0.52, sn);
      gl_FragColor.rgb *= mix(1.0, 0.75, cover); // wet and darker under it
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.92, 0.95, 0.97) * uWetLight, 0.95 * sheet);
    }
  }
}
`;

const TINT = new THREE.Color(0x0b3a52); // GUESS: about the sea's own colour looking down into it

/**
 * Teach every lit material under `root` where the water is. Returns the uniforms to
 * drive each frame. Materials are patched once (a flag stops a second patch).
 */
export function putInWater(root: THREE.Object3D): { update(look: InWaterLook): void } {
  const u = {
    uWetH: { value: 0.05 },
    uWetFoam: { value: 0.5 },
    uWetLight: { value: 1 },
    uWaterTint: { value: new THREE.Vector3(TINT.r, TINT.g, TINT.b) },
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (/^(sail|batten)/.test(o.name)) return; // sails are Yuki's (their own shader); never in the water
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (!std || !(std.isMeshStandardMaterial || (m as THREE.MeshLambertMaterial).isMeshLambertMaterial || (m as THREE.MeshPhongMaterial).isMeshPhongMaterial)) continue;
      if (m.userData.inWater) continue;
      m.userData.inWater = true;
      const prev = m.onBeforeCompile.bind(m);
      m.onBeforeCompile = (sh, r) => {
        prev(sh, r);
        Object.assign(sh.uniforms, seaUniforms, washUniforms, u);
        sh.vertexShader = sh.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vSeaW;")
          .replace("#include <project_vertex>", "#include <project_vertex>\nvSeaW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
        sh.fragmentShader = sh.fragmentShader
          .replace("#include <common>", "#include <common>\n" + PARS)
          .replace("#include <opaque_fragment>", "#include <opaque_fragment>\n" + BODY);
      };
      const key = m.customProgramCacheKey.bind(m);
      m.customProgramCacheKey = () => key() + "|in-water-v1";
      m.needsUpdate = true;
    }
  });
  return {
    update(look: InWaterLook): void {
      u.uWetH.value = look.wetH;
      u.uWetFoam.value = look.foam;
      u.uWetLight.value = look.light;
    },
  };
}
