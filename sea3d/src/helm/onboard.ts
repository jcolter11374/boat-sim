// The on-board view (John, 24 Nov 2026: "being on the actual boat and controlling it from a first
// person perspective"). The camera rides the boat: it heaves, rolls and pitches with her, and
// looks along her bow. On a boat with a crew it is the helm's eye, aft; on a small unmanned boat
// (our kayak, the Randolph drone) it is a camera on her stern mast, looking forward over her deck.
// Drag looks around, the wheel of the mouse widens or narrows the lens. The steering keys are the
// same as in any other view. Display only.
//
// Pure arithmetic here (tested); helm.ts holds the camera.

/** What the eye needs of a boat (boats/specs.ts). */
export interface EyeBoat {
  /** The boat's key (boats/specs.ts), to know the unmanned ones. */
  key: string;
  length: number;
  /** CG distance aft of the bow (m): the boat frame's origin is the CG, +x the bow. */
  cgX: number;
  /** CG depth below the static waterline (m). */
  cgBelowWaterline: number;
}

export interface Eye {
  /** In the boat's frame (m): +x towards the bow, +y up, from the CG. */
  x: number;
  y: number;
  /** Looking down by this at rest (deg), to take in her own deck and the water ahead. */
  down: number;
  /** "helm": where a person would stand or sit; "mast": a camera on a small unmanned boat. */
  kind: "helm" | "mast";
}

/** Boats with nobody on board, whatever their length: the eye is a camera on the stern mast. */
export const UNMANNED = new Set(["kayak", "randolph", "stock_sail_drone7"]);
/** Whether she carries a person: not one of the unmanned boats, and big enough to (GUESS: the 4.3 m dinghy is the smallest). */
export const crewed = (b: EyeBoat): boolean => !UNMANNED.has(b.key) && b.length >= 3.5;

/**
 * Where the eye is. Heights are above the waterline (GUESS, by eye on the models):
 * - an unmanned boat: on her stern mast, 90% of her length aft of the bow, high enough to see
 *   over her deck (1.2 m on our kayak, never more than 1.6 m);
 * - the ocean rowing boat: a rower's seated eye, 1.3 m, well aft;
 * - a yacht (6 m and up): the helm, 82% aft, a seated eye above her deck;
 * - a dinghy or a beach cat: 70% aft, a sitting sailor's eye, 1.1 m.
 */
export function eyeFor(b: EyeBoat): Eye {
  const bow = b.cgX;
  if (!crewed(b)) return { x: bow - 0.9 * b.length, y: b.cgBelowWaterline + Math.min(0.25 + 0.3 * b.length, 1.6), down: 9, kind: "mast" };
  if (b.key === "stock_ocean_rower45") return { x: bow - 0.75 * b.length, y: b.cgBelowWaterline + 1.3, down: 5, kind: "helm" };
  if (b.length >= 6) return { x: bow - 0.82 * b.length, y: b.cgBelowWaterline + 1.2 + 0.11 * b.length, down: 5, kind: "helm" };
  return { x: bow - 0.7 * b.length, y: b.cgBelowWaterline + 1.1, down: 6, kind: "helm" };
}

/** How far the head turns and tips (deg), and the lens (deg). */
export const LOOK = { yaw: 170, up: 50, down: 40, fov: 62, fovMin: 40, fovMax: 80 };

/** A drag of (dx, dy) px turns the head: across the frame's height is about the lens's angle. */
export function dragLook(yaw: number, pitch: number, dx: number, dy: number, frameH: number, fov: number): { yaw: number; pitch: number } {
  const k = fov / Math.max(frameH, 1);
  return {
    yaw: Math.max(-LOOK.yaw, Math.min(LOOK.yaw, yaw - dx * k)),
    pitch: Math.max(-LOOK.down, Math.min(LOOK.up, pitch + dy * k)),
  };
}

/** The words when the view changes (plain, short). */
export function boardWords(kind: Eye["kind"]): string {
  const where = kind === "helm" ? "On board, at the helm" : "On board, from her stern mast";
  return `${where}. Drag to look around; the arrow keys steer as before. V steps off.`;
}

/** A turn of the mouse wheel or a trackpad swipe of `deltaY` px changes the lens by this (deg): a notch is about 3, a swipe is smooth. */
export function lensAfterWheel(fov: number, deltaY: number): number {
  return Math.max(LOOK.fovMin, Math.min(LOOK.fovMax, fov + Math.max(-100, Math.min(100, deltaY)) * 0.03));
}
