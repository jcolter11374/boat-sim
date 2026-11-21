import type * as THREE from "three";

/**
 * A page draws nothing while its canvas has no size: in a hidden pane or a zero-size frame the
 * renderer kept drawing every frame into a zero-size picture (GL_INVALID_FRAMEBUFFER_OPERATION, "Attachment
 * has zero size"), and the page stopped answering (the Randolph team, #50, 13 Nov). Hidden tabs already
 * stop: the browser holds back their frames. Frames resume by themselves when the canvas gets a size.
 */
export function pauseWhileUnsized(renderer: THREE.WebGLRenderer): void {
  const set = renderer.setAnimationLoop.bind(renderer);
  const c = renderer.domElement;
  renderer.setAnimationLoop = (cb) =>
    set(cb ? (time, frame) => (c.clientWidth > 0 && c.clientHeight > 0 && c.width > 0 && c.height > 0 ? cb(time, frame) : undefined) : null);
}
