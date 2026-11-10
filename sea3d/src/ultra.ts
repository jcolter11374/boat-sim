// The Ultra look (opt-in): lens focus, colour grade, film look and sun shadows
// on top of High. Never the default; the page drops back to High if the
// computer can't keep up (under ~25 frames a second for a few seconds).

import * as THREE from "three";
import type { Quality } from "./boats/parts";

export type Look = Quality | "ultra";

/** Starting look: ?quality=low|high|ultra, else the select's own default. */
export function startLook(select: HTMLSelectElement): Look {
  const q = new URLSearchParams(location.search).get("quality");
  if (q === "low" || q === "high" || q === "ultra") select.value = q;
  return (select.value as Look) || "high";
}

/** Geometry quality for a look (Ultra draws High geometry). */
export const geometryOf = (l: Look): Quality => (l === "ultra" ? "high" : l);

/** Let a boat cast and catch sun shadows (solid meshes only). */
export function shadowsOn(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const solid = mats.every((x) => !x.transparent);
    m.castShadow = solid;
    m.receiveShadow = solid;
  });
}

/** Watches the frame rate while Ultra is on; says when to drop to High. */
export class FpsGuard {
  private frames = 0;
  private start = -1;
  private slow = 0;
  /** ?gl=full (screenshots on a computer without a graphics card) keeps Ultra on however slow. */
  private readonly forced = typeof location !== "undefined" && new URLSearchParams(location.search).get("gl") === "full";
  /** Call once per frame with the time in seconds. True means: too slow, drop to High. */
  tick(t: number, ultra: boolean): boolean {
    if (!ultra || this.forced) {
      this.start = -1;
      this.slow = 0;
      return false;
    }
    if (this.start < 0) {
      this.start = t + 2; // let it settle after switching
      this.frames = 0;
      return false;
    }
    if (t < this.start) return false;
    this.frames++;
    if (t - this.start < 2) return false;
    const fps = this.frames / (t - this.start);
    this.start = t;
    this.frames = 0;
    this.slow = fps < 25 ? this.slow + 1 : 0;
    return this.slow >= 2; // two slow 2-second windows in a row
  }
}
