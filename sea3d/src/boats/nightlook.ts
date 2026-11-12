// The boat at night (Elena, 12 Nov: "the Pearson is a black shape"): a boat on a dark
// sea still reads, because the sky behind it is a little brighter than the sea and the
// moon (or just the starlit sky) catches its edges. So every boat material gets a cool
// rim of light along its silhouette after dark, stronger under a bright moon, and the
// cockpit has a faint warm light, as a crew's red/white cockpit lamp would show.
// Atmosphere.set() drives both through setNightLook(). Display only.

import * as THREE from "three";

/** The rim's colour and strength now (0 by day). Shared by every boat material. */
export const RIM = {
  colour: { value: new THREE.Color(0x9fb6e8) },
  strength: { value: 0 },
};

/**
 * Backlight (the title hero, Ines 12 Nov): filmed into a low sun, the boat's near side is in
 * its own shadow, the sun catches her edges, and her sails glow where the sun shines through
 * the cloth. dir: towards the sun (scene, unit); strength 0 = off (everywhere but the title).
 */
export const BACK = {
  dir: { value: new THREE.Vector3(0, 1, 0) },
  strength: { value: 0 },
  colour: { value: new THREE.Color(0xffc68a) },
};

/** Rim strength on a moonless night, and added under a full moon. */
export const RIM_DARK = 0.12;
export const RIM_MOON = 0.6;

const cockpits = new Set<THREE.PointLight>();
/** The cockpit lamp's brightness at full night (candela-ish, three.js units). */
export const COCKPIT_CD = 0.9;

/** Give a material the night rim (patched once; works alongside other patches such as sailcloth). */
export function rimLit<M extends THREE.MeshStandardMaterial>(m: M, cloth = false): M {
  if (m.userData.nightRim) return m;
  m.userData.nightRim = true;
  const prev = m.onBeforeCompile.bind(m);
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.uniforms.uRimCol = RIM.colour;
    sh.uniforms.uRim = RIM.strength;
    sh.uniforms.uBackDir = BACK.dir;
    sh.uniforms.uBack = BACK.strength;
    sh.uniforms.uBackCol = BACK.colour;
    sh.vertexShader = sh.vertexShader
      .replace("void main() {", "varying vec3 vRimN;\nvarying vec3 vRimW;\nvoid main() {")
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\n  vRimN = normalize(mat3(modelMatrix) * objectNormal);\n  vRimW = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", "uniform vec3 uRimCol;\nuniform float uRim;\nuniform vec3 uBackDir;\nuniform float uBack;\nuniform vec3 uBackCol;\nvarying vec3 vRimN;\nvarying vec3 vRimW;\nvoid main() {")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
  // The night rim: the boat's edges catch the sky's light.
  float rimF = pow(1.0 - abs(dot(normalize(vRimN), normalize(cameraPosition - vRimW))), 3.0);
  totalEmissiveRadiance += uRimCol * (uRim * rimF) * (0.35 + 0.65 * diffuseColor.rgb);
  if (uBack > 0.0) {
    // Into the sun: how directly the sun is behind this point, seen from the camera.
    vec3 toPt = normalize(vRimW - cameraPosition);
    float behind = max(dot(toPt, uBackDir), 0.0);
    vec3 n = normalize(vRimN);
    // The sun's edge light: strong where the surface turns away from us towards the sun.
    float edge = pow(1.0 - abs(dot(n, -toPt)), 3.0) * smoothstep(-0.1, 0.7, dot(n, uBackDir) + 0.55);
    totalEmissiveRadiance += uBackCol * (uBack * 6.0 * edge * pow(behind, 2.0));
    ${cloth ? "// Sailcloth: the sun shines through it, warm, brightest straight down the sun's line.\n    totalEmissiveRadiance += uBackCol * diffuseColor.rgb * (uBack * (0.1 + 0.5 * pow(behind, 40.0) + 1.4 * pow(behind, 400.0)));" : ""}
  }`,
      );
  };
  m.customProgramCacheKey = () => `${prevKey()}|boatsim-nightrim-v2${cloth ? "c" : ""}`;
  m.needsUpdate = true;
  return m;
}

/** Rim-light every standard material in a boat model. */
export function nightLook(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (mat instanceof THREE.MeshStandardMaterial) rimLit(mat, /^(sail|batten|jib|main|genoa)/i.test(mesh.name) || /sail/i.test(mat.name));
    }
  });
}

/** A faint warm cockpit lamp at `at` (the group's frame), reaching about `reach` metres. */
export function addCockpitLight(group: THREE.Object3D, at: THREE.Vector3, reach: number): THREE.PointLight {
  const l = new THREE.PointLight(0xffc98a, 0, reach, 2);
  l.name = "cockpit_light";
  l.position.copy(at);
  group.add(l);
  cockpits.add(l);
  return l;
}

/** The title hero's backlight: towards the sun (scene, unit), strength 0..1 (0 off). */
export function setBacklight(sunDir: THREE.Vector3, strength: number, colour?: THREE.Color): void {
  BACK.dir.value.copy(sunDir).normalize();
  BACK.strength.value = strength;
  if (colour) BACK.colour.value.copy(colour);
}

/** Called by the atmosphere each time the sky is set: night 0..1, moonlight 0..1. */
export function setNightLook(night: number, moonlight: number, moonColour?: THREE.Color): void {
  RIM.strength.value = night * (RIM_DARK + RIM_MOON * moonlight);
  if (moonColour) RIM.colour.value.copy(moonColour);
  for (const l of cockpits) {
    // Lights of boats no longer in a scene are forgotten.
    let top: THREE.Object3D = l;
    while (top.parent) top = top.parent;
    if (!(top instanceof THREE.Scene)) {
      if (!l.userData.seen) continue; // not added yet: keep it
      cockpits.delete(l);
      continue;
    }
    l.userData.seen = true;
    l.intensity = COCKPIT_CD * night;
  }
}
