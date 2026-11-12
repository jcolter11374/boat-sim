// The ghost of your best practice run (Rosa; Elena approved 12 Nov): the same boat, a cool
// pale see-through cyan-white with a soft bright rim (Ines), with no wake, no sound and no
// tag, sailing the line you sailed. It thins out close by, so it never smothers your boat, and
// fades out far off, so it never competes with the mark. Display only.

import * as THREE from "three";
import type { BoatModel } from "../boats/model";

/** Seen within this (m), fading over the last third. */
export const GHOST_FADE_M = 900;
/** Thinned out inside this (m), gone inside NEAR_GONE_M: it can't swamp her (Ines: about 15 m). */
const NEAR_FULL_M = 15;
const NEAR_GONE_M = 4;
const OPACITY = 0.45;

const VERT = `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
uniform vec3 tint;
uniform float alpha;
varying vec3 vN;
varying vec3 vV;
void main() {
  // A soft bright rim where the surface turns away (a fresnel edge): it carries at a distance.
  float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
  vec3 c = tint * (0.75 + 0.6 * rim);
  gl_FragColor = vec4(c, min(1.0, alpha * (0.8 + 0.8 * rim)));
}`;

export class Ghost {
  readonly group = new THREE.Group();
  private model: BoatModel | null = null;
  private readonly mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { tint: { value: new THREE.Color(0xbfe9f2) }, alpha: { value: OPACITY } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  constructor() {
    this.group.name = "practice-ghost";
    this.group.visible = false;
  }

  /** Dress a freshly built model of the player's boat as the ghost. */
  set(model: BoatModel | null): void {
    if (this.model) {
      this.group.remove(this.model.root);
      this.model.dispose();
    }
    this.model = model;
    if (!model) return;
    model.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) {
        if ((o as THREE.Light).isLight) o.visible = false;
        return;
      }
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.material = this.mat;
      mesh.renderOrder = 11; // after the sea (10): drawn before it, the see-through ghost was painted over
    });
    this.group.add(model.root);
  }

  /** How strong the ghost is at a distance (0..1 of full). */
  static strength(d: number): number {
    const far = d > GHOST_FADE_M ? 0 : Math.min(1, (GHOST_FADE_M - d) / (GHOST_FADE_M / 3));
    const near = Math.min(1, Math.max(0, (d - NEAR_GONE_M) / (NEAR_FULL_M - NEAR_GONE_M)));
    return far * near;
  }

  /**
   * Pose it: (dx, dz) metres from your boat (x east, z south), the water's height there, its yaw
   * (radians, the page's convention) and roll (+ to starboard). night: 0..1, dims it to suit.
   */
  update(dx: number, dz: number, y: number, yaw: number, roll: number, flow: { x: number; z: number }, dt: number, night: number): void {
    const m = this.model;
    const a = OPACITY * Ghost.strength(Math.hypot(dx, dz)) * (1 - 0.5 * night);
    this.group.visible = !!m && a > 0.01;
    if (!m || !this.group.visible) return;
    this.mat.uniforms.alpha.value = a;
    m.root.position.set(dx, y - m.spec.cgBelowWaterline, dz);
    m.root.rotation.set(roll, yaw, 0, "YZX");
    m.rig?.update(dt, { flow, plan: null, rudder: 0 });
  }

  hide(): void {
    this.group.visible = false;
  }
}
