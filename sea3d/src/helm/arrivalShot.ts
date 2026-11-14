/**
 * The finish scene's shot (M5, Hana): the boat low in the frame on a third, and beyond her the
 * coast she was headed for, with Cabo da Roca and its lighthouse on the horizon. A long lens from
 * a chase boat's height, so the cape stands up off the horizon instead of lying on it as a thin
 * line, and a slow push in. Composed, never random; display only (it moves no clock).
 */
import * as THREE from "three";
import { boatAt, compose, type Composed, type FramingHost, type Look } from "../framing";

/** Cabo da Roca lighthouse (the westernmost point of mainland Europe). */
export const CABO_DA_ROCA = { lat: 38.7804, lon: -9.4989 };
/**
 * Where the finish scene is set: about 7 km south-west of the cape, on the way in from the open
 * Atlantic. From there the cliff and its lighthouse stand clear on the horizon with the Sintra
 * hills behind (from off Cascais, 14 km round the corner, the cape was a low line).
 */
export const ARRIVAL_AT: [number, number] = [38.74, -9.56];
/** How long the scene plays before the results (s); a click or a key ends it sooner. */
export const ARRIVAL_S = 12;
/** The frame: a 16 degree lens 1.6 m off the water, the horizon two fifths up, the boat a fifth of the width. */
export const ARRIVAL: Look = { az: 180, f: 0.2, H: -0.2, B: 0, fov: 16, h: 1.6, x: 0.45 };
/** How far across the frame the cape sits from the boat (in half-widths), so it is beside her, not behind her. */
export const CAPE_APART = 0.6;

const D2R = Math.PI / 180;

/** Where a far point in direction `dir` (x, z) lands across the frame (-1 left .. 1 right) for a composed camera. */
export function acrossOf(c: Pick<Composed, "pos" | "quat" | "fov">, aspect: number, dir: THREE.Vector2): number {
  const cam = new THREE.PerspectiveCamera(c.fov, aspect, 0.1, 1e6);
  cam.position.copy(c.pos);
  cam.quaternion.copy(c.quat);
  cam.updateMatrixWorld();
  return new THREE.Vector3(c.pos.x + dir.x * 14000, 100, c.pos.z + dir.y * 14000).project(cam).x;
}

/**
 * The camera t seconds into the scene. capeBearing: degrees true from the boat to the cape.
 * The camera stands on the far side of the boat from the cape, on whichever hand puts the cape
 * on the open side of the frame (the boat on one third, the cape towards the other).
 */
export function arrivalShot(
  host: FramingHost,
  capeBearing: number,
  t: number,
  /** The hand and third picked on an earlier frame of the same scene: kept, so the shot never jumps. */
  held?: [number, number],
): { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number; cape: number; boat: number; held: [number, number] } {
  const yaw = host.yaw();
  const bow = new THREE.Vector2(Math.cos(yaw), -Math.sin(yaw));
  const cape = new THREE.Vector2(Math.sin(capeBearing * D2R), -Math.cos(capeBearing * D2R));
  const len = host.length?.() ?? 3.05 * (host.scale?.() ?? 1);
  const target = boatAt(host);
  const k = Math.min(1, Math.max(0, t / ARRIVAL_S));
  const ease = k * k * (3 - 2 * k);
  // A slow push in: the boat a tenth bigger by the end.
  // Round from the cape's line by what CAPE_APART is of this frame's width (a phone's upright frame is narrow).
  const off = Math.atan(CAPE_APART * Math.tan((ARRIVAL.fov * D2R) / 2) * host.camera.aspect) / D2R;
  const look: Look = { ...ARRIVAL, az: 180 - off, f: ARRIVAL.f * (1 + 0.1 * ease) };
  let best: { c: Composed; cape: number; boat: number; score: number; held: [number, number] } | null = null;
  // Either hand, and the boat on either third: sailing straight at the cape or away from it, the usual
  // third (behind where she's heading) would put the cape out of the frame, so then she takes the other.
  for (const [side, flip] of held ? [held] : [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const c = compose(target, bow, cape, side, len, host.camera.aspect, { ...look, x: flip * look.x! }, 0, host.height?.() ?? 0);
    const cam = new THREE.PerspectiveCamera(c.fov, host.camera.aspect, 0.1, 1e6);
    cam.position.copy(c.pos);
    cam.quaternion.copy(c.quat);
    cam.updateMatrixWorld();
    const boat = target.clone().project(cam).x;
    const x = acrossOf(c, host.camera.aspect, cape);
    // In the frame, and as far from the boat as it can be.
    const score = Math.abs(x) < 0.85 ? Math.abs(x - boat) + 0.05 * flip : -Math.abs(x);
    if (!best || score > best.score) best = { c, cape: x, boat, score, held: [side, flip] };
  }
  const c = best!.c;
  c.pos.y = Math.max(c.pos.y, host.water(c.pos.x, c.pos.z) + 0.5);
  return { pos: c.pos, quat: c.quat, fov: c.fov, cape: best!.cape, boat: best!.boat, held: best!.held };
}
