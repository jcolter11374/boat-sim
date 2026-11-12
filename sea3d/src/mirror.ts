// Reflections of the land, the town and the boats in the sea by day: a planar
// mirror. The scene's reflectable things (on MIRROR_LAYER) are drawn once more
// each frame, upside down from a camera mirrored in the sea surface, into a
// small texture; the sea shader (water.ts) looks it up where each pixel of sea
// is, nudged by the wave slopes so it wobbles and breaks up.
//
// Calm water mirrors; a chop smears and dims it; open ocean doesn't reflect at
// all, and then the extra pass is skipped. The sky's own reflection is the sea
// material's, so only things on the layer are drawn here (on a clear
// background), and the sea mixes them in where they are.

import * as THREE from "three";

/** Layer of the things the sea mirrors (land, town, trees, boats). Lights join it too. */
export const MIRROR_LAYER = 1;

/** Put an object and everything under it in the sea's mirror. */
export function reflectable(o: THREE.Object3D): void {
  o.traverse((c) => {
    // Hair-thin parts (an antenna, a stay) alias into dashes in the small mirror: leave them out.
    const g = (c as THREE.Mesh).geometry;
    if ((c as THREE.Mesh).isMesh && g) {
      if (!g.boundingBox) g.computeBoundingBox();
      const d = g.boundingBox!.getSize(new THREE.Vector3()).multiply(c.getWorldScale(new THREE.Vector3()));
      const [a, b] = [d.x, d.y, d.z].sort((x, y) => x - y);
      if (a < 0.03 && b < 0.03) return;
    }
    c.layers.enable(MIRROR_LAYER);
  });
}

/** How strongly a sea of this height (m) mirrors: fully in a flat calm, a third at 0.4 m, gone by 0.6 m. */
export function mirrorStrength(hs: number): number {
  return 1 - THREE.MathUtils.smoothstep(hs, 0.05, 0.6);
}

export class Mirror {
  readonly target: THREE.WebGLRenderTarget;
  /** World position -> mirror texture coordinates (with the w divide). */
  readonly textureMatrix = new THREE.Matrix4();
  private readonly cam = new THREE.PerspectiveCamera();
  private readonly plane = new THREE.Plane();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();
  private readonly clear = new THREE.Color();
  /** 0 (off) .. 1 (a mirror calm), for the sea shader. */
  strength = 0;
  /** Height (m) of the mirror plane: the water at the focused boat, so its reflection meets
   *  its waterline (Ines r5: a plane at y = 0 left a gap under a boat on a swell). */
  level = 0;
  /** Passes drawn (for tests). */
  frames = 0;

  /** Fraction of the drawing buffer the mirror is drawn at. */
  constructor(public scale: number) {
    this.target = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples: 0 });
    this.target.texture.name = "sea mirror";
    this.cam.layers.set(MIRROR_LAYER);
  }

  /** Match the drawing buffer (pixels), at this mirror's fraction of it. */
  setSize(w: number, h: number): void {
    this.target.setSize(Math.max(1, Math.round(w * this.scale)), Math.max(1, Math.round(h * this.scale)));
  }

  /** Draw the mirror for this frame (before the scene itself), for a sea of height hs (m). */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, hs: number, level = 0): void {
    this.strength = mirrorStrength(hs);
    this.level = level;
    if (this.strength < 0.02 || camera.position.y <= level) {
      this.strength = 0;
      return;
    }
    // Lights must be on the layer to light what it draws.
    scene.traverse((o) => {
      if ((o as THREE.Light).isLight) o.layers.enable(MIRROR_LAYER);
    });
    // The camera mirrored in the plane y = level (three's Reflector, for a fixed horizontal plane).
    const c = this.cam;
    camera.updateMatrixWorld();
    c.position.copy(camera.position).setY(2 * level - camera.position.y);
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).add(camera.position);
    look.y = 2 * level - look.y;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    c.up.set(up.x, -up.y, up.z);
    c.lookAt(look);
    c.far = camera.far;
    c.updateMatrixWorld();
    c.projectionMatrix.copy(camera.projectionMatrix);
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(c.projectionMatrix).multiply(c.matrixWorldInverse);
    // Oblique near plane at the sea surface, so nothing below the water (keels) is mirrored.
    this.plane.set(new THREE.Vector3(0, 1, 0), -level).applyMatrix4(c.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = c.projectionMatrix.elements;
    this.q.set((Math.sign(this.clip.x) + p[8]) / p[0], (Math.sign(this.clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    p[2] = this.clip.x;
    p[6] = this.clip.y;
    p[10] = this.clip.z + 1;
    p[14] = this.clip.w;
    c.projectionMatrixInverse.copy(c.projectionMatrix).invert();

    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear();
    renderer.render(scene, c);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(this.clear, prevAlpha);
    renderer.shadowMap.autoUpdate = prevShadow;
    this.frames++;
  }

  dispose(): void {
    this.target.dispose();
  }
}
