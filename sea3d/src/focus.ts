// A camera moment: ease to the boat, hold, ease back. Built once for two callers (Elena, 12 Nov):
// Watch a voyage, when an equipment icon turns red at 1 h/s or slower, and Iris's cinematic
// Knockdown sequence, which passes its own framing and carries on from there (returnTo "none").
// No page globals: the page ticks update(dt) from its frame loop and skips its own camera
// control (OrbitControls.update) while update returns true.
import * as THREE from "three";

export interface Framing {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  fov: number;
}

export interface FocusOpts {
  /** How long it holds on the boat, ms (default 2000). */
  holdMs?: number;
  /** Each ease, in and out, ms (default 800). */
  easeMs?: number;
  /** Where to look from, worked out each frame from where the boat is. Default: closer in, from where the camera already is. */
  framing?: (target: THREE.Vector3) => Framing;
  /** "start" eases back to where the camera was (default); "none" stops on the framing and hands over. */
  returnTo?: "start" | "none";
}

export interface Focus {
  /** Move the camera; true while it is driving it, false once it has finished (or was cancelled). */
  update(dt: number): boolean;
  cancel(): void;
  done: Promise<void>;
}

const ease = (x: number) => x * x * (3 - 2 * x);
const look = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** Look at `target` from `pos`, as a camera does (it looks down its -z). */
export function lookQuat(pos: THREE.Vector3, target: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
  look.lookAt(pos, target, UP);
  return out.setFromRotationMatrix(look);
}

/** Closer in along the line the camera already looks down, a little higher, the boat in the middle. */
export function closeIn(cam: THREE.PerspectiveCamera, target: THREE.Vector3, near = 0.6, min = 4): (t: THREE.Vector3) => Framing {
  const dir = cam.position.clone().sub(target);
  const dist = Math.max(min, dir.length() * near);
  dir.y = Math.max(dir.y, dir.length() * 0.25);
  dir.setLength(dist);
  const fov = cam.fov;
  return (t) => {
    const pos = t.clone().add(dir);
    return { pos, quat: lookQuat(pos, t), fov };
  };
}

export function focusBoat(cam: THREE.PerspectiveCamera, target: () => THREE.Vector3, opts: FocusOpts = {}): Focus {
  const holdMs = opts.holdMs ?? 2000;
  const easeMs = Math.max(1, opts.easeMs ?? 800);
  const back = (opts.returnTo ?? "start") === "start";
  const t0 = target().clone();
  // Where it started, as an offset from the boat, so it comes back to the same view of a boat that moved.
  const from: Framing = { pos: cam.position.clone().sub(t0), quat: cam.quaternion.clone(), fov: cam.fov };
  const frame = opts.framing ?? closeIn(cam, t0);
  const total = easeMs + holdMs + (back ? easeMs : 0);
  let ms = 0;
  let over = false;
  let finish: () => void = () => {};
  const done = new Promise<void>((ok) => (finish = ok));
  const end = () => {
    if (over) return;
    over = true;
    finish();
  };
  const pose = new THREE.Vector3();
  const q = new THREE.Quaternion();
  return {
    done,
    cancel: end,
    update(dt: number): boolean {
      if (over) return false;
      ms += dt * 1000;
      const t = target();
      const f = frame(t);
      const start = { pos: pose.copy(from.pos).add(t), quat: from.quat, fov: from.fov };
      // 0 = where it started, 1 = on the framing.
      let k: number;
      if (ms < easeMs) k = ease(ms / easeMs);
      else if (ms < easeMs + holdMs || !back) k = 1;
      else k = 1 - ease(Math.min(1, (ms - easeMs - holdMs) / easeMs));
      cam.position.lerpVectors(start.pos, f.pos, k);
      cam.quaternion.copy(q.copy(start.quat).slerp(f.quat, k));
      const fov = THREE.MathUtils.lerp(start.fov, f.fov, k);
      if (Math.abs(cam.fov - fov) > 1e-6) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
      if (ms >= total) {
        end();
        return false;
      }
      return true;
    },
  };
}
