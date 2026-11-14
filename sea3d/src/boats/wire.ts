// Thin wires (stays, shrouds, lifelines) that hold together on screen. A 6 mm forestay is
// far narrower than a pixel from a chase camera, so the rasteriser catches it only here and
// there and it breaks into a dotted line (Ines, 12 Nov). Here the wire's skin is pushed out
// along its normals until it is at least about one pixel across at its distance, so it
// reads as a fine continuous line at any range, and is its true size up close.

import * as THREE from "three";

/** The drawing buffer's height in pixels (set by each wire material just before it draws). */
const VIEW_H = { value: 720 };
const size = new THREE.Vector2();

/** Make a wire material hold at least `px` pixels across; `radius` is the wire's own (m). */
export function holdWidth(mat: THREE.Material, radius: number, px = 1.1): void {
  if (mat.userData.holdWidth) return;
  mat.userData.holdWidth = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.uniforms.uWireViewH = VIEW_H;
    sh.uniforms.uWireR = { value: radius };
    sh.uniforms.uWirePx = { value: px };
    sh.vertexShader = sh.vertexShader
      .replace("void main() {", "uniform float uWireViewH;\nuniform float uWireR;\nuniform float uWirePx;\nvoid main() {")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          // Metres per pixel at this vertex's depth; half the wanted width, less the wire's own radius.
          float depth = -(modelViewMatrix * vec4(transformed, 1.0)).z;
          float mpp = 2.0 * depth / (projectionMatrix[1][1] * uWireViewH);
          float grow = max(0.0, 0.5 * uWirePx * mpp - uWireR);
          vec3 n = normalize(objectNormal);
          // The model may be scaled: grow in world metres.
          float s = length((modelMatrix * vec4(n, 0.0)).xyz);
          transformed += n * grow / max(s, 1e-6);
        }`,
      );
  };
  // Keep the screen height current (the render target's when drawing into one).
  mat.onBeforeRender = (r) => wireViewHeight(r);
  const key = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => (key ? key() : "") + "|wire-hold";
}

function wireViewHeight(renderer: THREE.WebGLRenderer): void {
  VIEW_H.value = renderer.getRenderTarget()?.height ?? (renderer.getDrawingBufferSize(size).y || 720);
}

/** Every mesh in `root` whose material is named `name` (the Blender models' "wire"). */
export function holdWires(root: THREE.Object3D, name = "wire", radius = 0.004): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (!mats.some((x) => x.name === name)) return;
    for (const x of mats) if (x.name === name) holdWidth(x, radius);
  });
}

/**
 * Every hair-thin part of a model (both short sides under `under` m: an aerial, a rod, a stay) held to at
 * least a pixel across. Each gets its own copy of its material, so thicker parts sharing it stay as they
 * are. The Blender kayak's AIS whip tapers from 10 mm to 6 mm: on the title's long lens it broke into
 * dashes and its top came and went (John, 13 Nov). At 1.1 px a slanted line still stair-stepped into
 * dashes on a real graphics card; 1.8 px reads as one fine line. Returns how many parts it held.
 */
export function holdThinParts(root: THREE.Object3D, under = 0.03, px = 1.8): number {
  let n = 0;
  const box = new THREE.Vector3();
  const scale = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    m.geometry.boundingBox!.getSize(box).multiply(m.getWorldScale(scale));
    const [a, b] = [box.x, box.y, box.z].sort((x, y) => x - y);
    if (a >= under || b >= under || a <= 0) return;
    const radius = 0.3 * a; // about the radius at its thin end, for a tapered part
    const own = (x: THREE.Material) => {
      const c = x.clone();
      holdWidth(c, radius, px);
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(own) : own(m.material);
    n++;
  });
  return n;
}
