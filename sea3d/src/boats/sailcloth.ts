// Sailcloth (Elena, 12 Nov): sails are thin woven sheets, not painted board. They take
// the sun's own colour, so a low sun turns them gold or orange, and they glow through
// when the sun is behind them, as real cloth does: you see the light through the sail
// from its shady side. At night they go cool and dim with the rest of the boat.
// Atmosphere.set() keeps SAIL_SUN up to date; every sail material shares it.

import * as THREE from "three";

/** Where the sun is (unit, scene), its colour, and how much it's shining (0 at night or under thick cloud). */
export const SAIL_SUN = {
  dir: { value: new THREE.Vector3(0, 1, 0) },
  colour: { value: new THREE.Color(1, 1, 1) },
  strength: { value: 0 },
};

/** How much light a sail lets through when the sun is straight behind it (Dacron passes a few per cent; seen against the sun that glows). */
export const TRANSLUCENCY = 0.55;

/** True for a sail's mesh or material (the Blender models name them sail..., the drawn ones "sail"). */
export function isSail(o: THREE.Object3D, m: THREE.Material): boolean {
  return /^sail/i.test(m.name) || /^sail/i.test(o.name);
}

/** Make a material sailcloth: soft and matt, lit through from behind by the sun. Returns it (patched once). */
export function clothe<M extends THREE.MeshStandardMaterial>(m: M): M {
  if (m.userData.sailcloth) return m;
  m.userData.sailcloth = true;
  m.roughness = Math.max(m.roughness, 0.8);
  m.metalness = 0;
  m.side = THREE.DoubleSide;
  const prev = m.onBeforeCompile.bind(m);
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.uniforms.uSailSunDir = SAIL_SUN.dir;
    sh.uniforms.uSailSunCol = SAIL_SUN.colour;
    sh.uniforms.uSailSun = SAIL_SUN.strength;
    sh.vertexShader = sh.vertexShader
      .replace("void main() {", "varying vec3 vSailWorld;\nvoid main() {")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n  vSailWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", "uniform vec3 uSailSunDir;\nuniform vec3 uSailSunCol;\nuniform float uSailSun;\nvarying vec3 vSailWorld;\nvoid main() {")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
  // Light through the cloth: strongest looking straight at the sun through the sail.
  vec3 sailView = normalize(vSailWorld - cameraPosition);
  float through = pow(max(dot(sailView, uSailSunDir), 0.0), 3.0);
  totalEmissiveRadiance += diffuseColor.rgb * uSailSunCol * (${TRANSLUCENCY.toFixed(2)} * uSailSun * through);`,
      );
  };
  m.customProgramCacheKey = () => `${prevKey()}|boatsim-sailcloth-v1`;
  m.needsUpdate = true;
  return m;
}

/** Clothe every sail in a model. */
export function clotheSails(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (mat instanceof THREE.MeshStandardMaterial && isSail(o, mat)) clothe(mat);
    }
  });
}

/** Called by the atmosphere each time the sky is set. */
export function setSailSun(dir: THREE.Vector3, colour: THREE.Color, strength: number): void {
  SAIL_SUN.dir.value.copy(dir).normalize();
  SAIL_SUN.colour.value.copy(colour);
  SAIL_SUN.strength.value = strength;
}
