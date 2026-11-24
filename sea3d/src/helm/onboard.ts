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

/** Boats this long or longer carry a person (GUESS: the 4.3 m dinghy is the smallest crewed boat). */
export const CREWED_M = 3.5;

/**
 * Where the eye is. Heights are above the waterline (GUESS, by eye on the models):
 * - a yacht (6 m and up): the helm, 82% of her length aft of the bow, a seated eye above her deck;
 * - a dinghy or a beach cat: 70% aft, a sitting sailor's eye, 1.1 m;
 * - a small unmanned boat: on her stern mast, 90% aft, high enough to see over her deck.
 */
export function eyeFor(b: EyeBoat): Eye {
  const bow = b.cgX;
  if (b.length >= 6) return { x: bow - 0.82 * b.length, y: b.cgBelowWaterline + 1.2 + 0.11 * b.length, down: 5, kind: "helm" };
  if (b.length >= CREWED_M) return { x: bow - 0.7 * b.length, y: b.cgBelowWaterline + 1.1, down: 6, kind: "helm" };
  return { x: bow - 0.9 * b.length, y: b.cgBelowWaterline + 0.25 + 0.3 * b.length, down: 9, kind: "mast" };
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
export function boardWords(kind: Eye["kind"], crewed: boolean): string {
  const where = kind === "helm" && crewed ? "On board, at the helm" : "On board, from her stern mast";
  return `${where}. Drag to look around; the arrow keys steer as before. V steps off.`;
}
