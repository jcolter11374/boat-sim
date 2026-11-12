// Sailcloth (Iris, then Yuki; Elena, 12 Nov): sails are thin woven sheets, not
// painted board.
// - Colour: Dacron is a warm off-white, never paper white.
// - They take the sun's own colour, so a low sun turns them gold or orange.
// - Lit through from behind, as real cloth is: from the shady side you see the
//   light through the sail, strongest looking towards the sun. The seams, the
//   tapes along the edges and the corner patches are double cloth, so against the
//   light they show as darker lines (and very faintly in front light too).
// - Woven cloth has a soft sheen at grazing angles and no hard highlight.
// - The front edge (luff) flutters when the sail is under-trimmed and the whole
//   sail shakes head to wind: setSailLuff(), driven by the wheel's trim (Rosa).
// At night they go cool and dim with the rest of the boat (Iris's night look).
// Atmosphere.set() keeps SAIL_SUN up to date; every sail material shares it.
// Cosmetic only. Numbers are GUESS, set by eye against photos of sails.

import * as THREE from "three";

/** Where the sun is (unit, scene), its colour, and how much it's shining (0 at night or under thick cloud). */
export const SAIL_SUN = {
  dir: { value: new THREE.Vector3(0, 1, 0) },
  colour: { value: new THREE.Color(1, 1, 1) },
  strength: { value: 0 },
};
/** The ripple's clock (s), advanced by tickSails (the stock rig calls it each frame). */
const SAIL_TIME = { value: 0 };

/** How much light a sail lets through when the sun is straight behind it (Dacron passes a few per cent; seen against the sun that glows). */
export const TRANSLUCENCY = 2.2;
/** Dacron: warm off-white (sRGB). */
export const DACRON = 0xe8e3d6;
/** Cross-cut panel height, m (sails are sewn from horizontal strips about a metre wide). */
const PANEL = 0.9;

/** True for a sail's mesh or material (the Blender models name them sail..., the drawn ones "sail"). */
export function isSail(o: THREE.Object3D, m: THREE.Material): boolean {
  return /^sail/i.test(m.name) || /^sail/i.test(o.name);
}

interface SailUniforms {
  uLuff: { value: number };
  /** Sail's foot and height, m (seam spacing, ripple size). */
  uSize: { value: THREE.Vector2 };
}

/**
 * Make a material sailcloth (patched once; returns the material to use, which is
 * a physical copy when the input wasn't physical, for the cloth sheen).
 * Give it the sail's size so seams land a panel apart; without UVs on the mesh
 * the seams and the luff ripple simply don't show.
 */
export function clothe<M extends THREE.MeshStandardMaterial>(m: M, size = new THREE.Vector2(4, 10)): THREE.MeshPhysicalMaterial | M {
  if (m.userData.sailcloth) return m;
  let p: THREE.MeshStandardMaterial = m;
  if (!(m instanceof THREE.MeshPhysicalMaterial)) {
    const q = new THREE.MeshPhysicalMaterial();
    q.name = m.name;
    q.color.copy(m.color);
    q.map = m.map;
    q.roughness = m.roughness;
    p = q;
  }
  const pm = p as THREE.MeshPhysicalMaterial;
  pm.userData.sailcloth = true;
  pm.roughness = Math.max(pm.roughness, 0.8);
  pm.metalness = 0;
  pm.clearcoat = 0;
  pm.sheen = 0.6;
  pm.sheenRoughness = 0.85;
  pm.sheenColor.set(0xfff6ea);
  pm.side = THREE.DoubleSide;
  const u: SailUniforms = { uLuff: { value: 0 }, uSize: { value: size.clone() } };
  pm.userData.sail = u;
  const prev = pm.onBeforeCompile.bind(pm);
  const prevKey = pm.customProgramCacheKey.bind(pm);
  pm.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.uniforms.uSailSunDir = SAIL_SUN.dir;
    sh.uniforms.uSailSunCol = SAIL_SUN.colour;
    sh.uniforms.uSailSun = SAIL_SUN.strength;
    sh.uniforms.uSailTime = SAIL_TIME;
    sh.uniforms.uLuff = u.uLuff;
    sh.uniforms.uSize = u.uSize;
    sh.vertexShader = sh.vertexShader
      .replace(
        "void main() {",
        `uniform float uSailTime;
uniform float uLuff;
uniform vec2 uSize;
varying vec3 vSailWorld;
varying vec2 vSailUv;
varying float vFlog;
void main() {`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
  vSailUv = uv;
  // Luff flutter: ripples run aft from the luff (u = 0, held by the mast or stay,
  // so no movement right at it), reaching further back as the sail is let go;
  // at 1 (head to wind) the whole sail shakes. Size scales with the sail's foot.
  float reach = 0.3 + 0.7 * uLuff * uLuff;
  float wLuff = smoothstep(0.0, 0.05, uv.x) * (1.0 - smoothstep(0.0, reach, uv.x));
  float wave = sin(uv.x * 26.0 - uSailTime * (14.0 + 10.0 * uLuff) + uv.y * 7.0)
             * (0.6 + 0.4 * sin(uv.y * 11.0 + uSailTime * 4.3));
  vFlog = uLuff * wLuff;
  transformed += objectNormal * (vFlog * wave * uSize.x * 0.035 * (1.0 - 0.5 * uv.y));`,
      )
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n  vSailWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "void main() {",
        `uniform vec3 uSailSunDir;
uniform vec3 uSailSunCol;
uniform float uSailSun;
uniform vec2 uSize;
varying vec3 vSailWorld;
varying vec2 vSailUv;
varying float vFlog;
// The sail's layers: x = seam (two strips overlapping), y = tapes along the
// edges and corner patches (several layers). 0 on single cloth.
vec2 sailLayers(vec2 uv) {
  float chord = uSize.x * (1.0 - uv.y);      // the chord narrows towards the head
  // A point on the sail in metres, tack at the origin, luff up the y axis.
  vec2 p = vec2(uv.x * chord, uv.y * uSize.y);
  // Cross-cut seams run square to the leech (clew to head), so they fan a little
  // rather than lie flat. Thin, double-stitched, and faded out where a pixel is
  // wider than a few centimetres (far away), so they never shimmer.
  vec2 leech = normalize(vec2(-uSize.x, uSize.y));
  float rowY = dot(p - vec2(uSize.x, 0.0), leech) / ${PANEL.toFixed(2)};
  float d = abs(fract(rowY + 0.5) - 0.5) * ${PANEL.toFixed(2)};
  float px = fwidth(rowY) * ${PANEL.toFixed(2)};
  float seam = (1.0 - smoothstep(0.008, 0.02 + px, d)) * (1.0 - smoothstep(0.025, 0.08, px));
  float luffTape = 1.0 - smoothstep(0.04, 0.07, p.x);
  float leechTape = 1.0 - smoothstep(0.03, 0.05, (1.0 - uv.x) * chord);
  float footTape = 1.0 - smoothstep(0.04, 0.07, p.y);
  // Corner patches, layered: tack, clew and head (two layers, the outer one fainter).
  float tack = 0.6 * (1.0 - smoothstep(0.32, 0.36, length(p)))
             + 0.4 * (1.0 - smoothstep(0.18, 0.22, length(p)));
  float clew = 0.6 * (1.0 - smoothstep(0.36, 0.4, length(vec2((1.0 - uv.x) * chord, p.y))))
             + 0.4 * (1.0 - smoothstep(0.2, 0.24, length(vec2((1.0 - uv.x) * chord, p.y))));
  float head = 0.6 * (1.0 - smoothstep(0.28, 0.32, (1.0 - uv.y) * uSize.y))
             + 0.4 * (1.0 - smoothstep(0.14, 0.18, (1.0 - uv.y) * uSize.y));
  float edges = max(max(luffTape, leechTape), max(footTape, max(tack, max(clew, head))));
  return clamp(vec2(seam, edges), 0.0, 1.0);
}
void main() {`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
  vec2 sailDbl = sailLayers(vSailUv);
  diffuseColor.rgb *= 1.0 - 0.02 * sailDbl.x - 0.04 * sailDbl.y; // barely there in front light`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
  // A flogging luff creases: use the moved surface's own facets there.
  if (vFlog > 0.01) {
    vec3 fn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    if (dot(fn, normal) < 0.0) fn = -fn;
    normal = normalize(mix(normal, fn, clamp(vFlog * 1.5, 0.0, 0.8)));
  }`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
  // Light through the cloth. Only from the side away from the sun (the face we
  // see must face away from it), a broad glow from any angle, plus a strong
  // forward glow looking towards the sun. Brightest mid-sail, falling off to the
  // luff and leech (more cloth edge-on, the boltrope and tapes); seams let
  // through about two thirds, tapes and corner patches about half. The light
  // keeps half the sun's tint, the rest is the cloth's own off-white.
  vec3 sunV = normalize((viewMatrix * vec4(uSailSunDir, 0.0)).xyz);
  float behind = max(-dot(normal, sunV), 0.0);
  vec3 sailView = normalize(vSailWorld - cameraPosition);
  float through = pow(max(dot(sailView, uSailSunDir), 0.0), 3.0);
  float pass = (1.0 - 0.3 * sailDbl.x) * (1.0 - 0.5 * sailDbl.y);
  float body = 0.55 + 0.45 * sin(3.14159 * clamp(vSailUv.x, 0.0, 1.0)) * (1.0 - 0.4 * vSailUv.y);
  float sunLum = dot(uSailSunCol, vec3(0.2126, 0.7152, 0.0722));
  vec3 tint = mix(vec3(sunLum), uSailSunCol, 0.5);
  totalEmissiveRadiance += diffuseColor.rgb * tint
    * (${TRANSLUCENCY.toFixed(2)} * uSailSun * pass * body * smoothstep(0.0, 0.2, behind) * (0.45 * behind + through));`,
      );
  };
  pm.customProgramCacheKey = () => `${prevKey()}|boatsim-sailcloth-v2`;
  pm.needsUpdate = true;
  return pm as THREE.MeshPhysicalMaterial | M;
}

/** A sail mesh's foot and height (m), from its geometry. */
function sizeOf(mesh: THREE.Mesh): THREE.Vector2 {
  const g = mesh.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const b = g.boundingBox!;
  return new THREE.Vector2(Math.max(0.3, b.max.x - b.min.x), Math.max(0.3, b.max.y - b.min.y));
}

/**
 * Clothe every sail in a model. Each sail gets its own material (its own luff
 * and size), so call this on each boat's copy, not on a shared template.
 */
export function clotheSails(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const one = (mat: THREE.Material): THREE.Material => {
      if (!(mat instanceof THREE.MeshStandardMaterial) || !isSail(o, mat)) return mat;
      if (mat.userData.sailcloth && mat.userData.owner === mesh.uuid) return mat;
      const fresh = mat.clone();
      fresh.userData = { ...mat.userData, sailcloth: false, sail: undefined };
      const c = clothe(fresh, sizeOf(mesh));
      c.userData.owner = mesh.uuid;
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
  });
}

/**
 * How much a sail's luff is fluttering: 0 drawing well (no-op) .. 1 head to wind,
 * flogging. obj is a sail mesh or anything holding sails (its pivot). Jibs luff
 * first, so they show a little more for the same amount.
 */
export function setSailLuff(obj: THREE.Object3D, amount: number): void {
  const a = THREE.MathUtils.clamp(amount || 0, 0, 1);
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const u = mat.userData.sail as SailUniforms | undefined;
      if (u) u.uLuff.value = /jib/i.test(o.name) ? Math.min(1, a * 1.15) : a;
    }
  });
}

/** Advance the ripple clock (s). */
export function tickSails(dt: number): void {
  SAIL_TIME.value = (SAIL_TIME.value + dt) % 1000;
}

/** Called by the atmosphere each time the sky is set. */
export function setSailSun(dir: THREE.Vector3, colour: THREE.Color, strength: number): void {
  SAIL_SUN.dir.value.copy(dir).normalize();
  SAIL_SUN.colour.value.copy(colour);
  SAIL_SUN.strength.value = strength;
}
