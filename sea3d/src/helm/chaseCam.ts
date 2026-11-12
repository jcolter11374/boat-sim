// The sailing camera at the wheel (Rosa; plan approved by Elena, 12 Nov): a chase boat's
// view. 30 degree lens, behind the boat and to leeward (she heels toward us and we see
// her deck), raised a little, the boat a third off-centre with room ahead of her bow,
// a level horizon on the upper third. It eases after the boat like a person holding it,
// swings round slowly on a tack, and gives way to the mouse (drag to look, and it eases
// back a few seconds after you let go).
//
// Pure arithmetic in placeFor() (tested); ChaseCam keeps the easing state.

/** Where the camera wants to be and look, metres around the boat (at the origin): x east, y up, z south. */
export interface Shot {
  pos: [number, number, number];
  look: [number, number, number];
}

export const CHASE_FOV = 30;
/** Off the stern line toward leeward (deg). */
const OFF_DEG = 30;

/**
 * The part of the screen the picture is composed in (px): the whole frame less the top bar and
 * the wheel strip, so no part of the boat sits behind a panel (Elena), at any size or shape.
 */
export interface Frame {
  w: number;
  h: number;
  /** The free band: from `top` down to `bottom` (px from the top of the frame). */
  top: number;
  bottom: number;
  fovDeg: number;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * The shot for a boat heading `heading` (compass deg), length `lengthM`, rig `topM` above
 * the water, with the camera standing on compass bearing `around` from her (pass the eased
 * value). Composed in the free band: the horizon on its upper third, the hull's waterline on
 * its lower third, the boat on the vertical third away from where she's heading, and the
 * masthead inside the band (the camera backs off until it is).
 */
export function placeFor(heading: number, around: number, lengthM: number, topM: number, f: Frame): Shot {
  const focal = f.h / 2 / Math.tan(rad(f.fovDeg) / 2); // px per unit tan
  const yc = f.h / 2;
  const band = Math.max(f.bottom - f.top, f.h * 0.4);
  const yHorizon = f.top + band / 3;
  const yHull = f.top + (band * 2) / 3;
  const pitch = Math.atan((yc - yHorizon) / focal); // look down by this (negative: up)
  const hullBelow = Math.atan((yHull - yc) / focal) + pitch; // angle of the hull below the horizontal
  const roomAbove = Math.atan((yc - (f.top + band * 0.04)) / focal) - pitch; // to just under the band's top
  // Back off until the masthead fits, from about five boat lengths (GUESS).
  let d = 5 * lengthM;
  let h = d * Math.tan(hullBelow);
  for (let i = 0; i < 20 && Math.atan((topM - h) / d) > roomAbove; i++) {
    d *= 1.08;
    h = d * Math.tan(hullBelow);
  }
  h = Math.max(h, 1.5); // never in the waves
  const a = rad(around);
  // Compass bearing b -> world: east = sin b, south = -cos b.
  const pos: [number, number, number] = [Math.sin(a) * d, h, -Math.cos(a) * d];
  // Turn from the boat toward where she's heading by a third of the frame's width.
  const third = deg(Math.atan(f.w / 6 / focal));
  const toBoat = (around + 180) % 360;
  const rel = ((((heading - toBoat) % 360) + 540) % 360) - 180;
  const lookB = rad(toBoat + Math.sign(rel || 1) * Math.min(third, Math.abs(rel) + 2));
  const far = 40; // inside the orbit controls' reach (60 m)
  const look: [number, number, number] = [pos[0] + Math.sin(lookB) * far, h - Math.tan(pitch) * far, pos[2] - Math.cos(lookB) * far];
  return { pos, look };
}

/** Where the camera should stand (compass bearing from the boat): behind and to leeward. */
export function standAt(heading: number, windSide: number): number {
  // Wind on starboard (+1): she heels to port, so stand to port of the stern.
  return (((heading + 180 + (windSide >= 0 ? OFF_DEG : -OFF_DEG)) % 360) + 360) % 360;
}

export class ChaseCam {
  /** The eased bearing the camera stands on, or null before the first frame. */
  private around: number | null = null;
  /** Seconds since the player last dragged the view (Infinity while dragging). */
  private sinceDrag = 99;
  private dragging = false;
  /** Which side the wind is on, held through a run (dead downwind it flickers from side to side). */
  private side = 1;
  /** Off: the old orbit view ("deck view", key V). */
  on = true;

  /** The player started or stopped dragging the view. */
  drag(on: boolean): void {
    this.dragging = on;
    this.sinceDrag = 0;
  }

  /** Forget the easing (a new spell starts from the right place, not swinging in). */
  reset(): void {
    this.around = null;
  }

  /** True while the camera is ours (not dragged in the last 4 s, and not switched off). */
  active(): boolean {
    return this.on && !this.dragging && this.sinceDrag > 4;
  }

  /**
   * One frame. Returns the shot to show, or null when the player has the camera.
   * blend: how far to move this frame (0..1), for the page to ease from wherever it is.
   */
  update(dt: number, heading: number, twa: number, lengthM: number, topM: number, frame: Frame, still: boolean): (Shot & { blend: number }) | null {
    if (!this.dragging) this.sinceDrag += dt;
    // Switch sides only when the wind is clearly on the other side (a tack or a gybe), not on a dead run.
    if (Math.abs(twa) < 165 && Math.sign(twa) !== this.side && twa !== 0) this.side = Math.sign(twa);
    const want = standAt(heading, this.side);
    if (this.around === null) this.around = want;
    // Ease the bearing (about 1.2 s; a tack's 60 degree swing takes about 3 s). Reduced motion: quicker, no sway.
    const tau = still ? 0.5 : 1.2;
    const d = ((((want - this.around) % 360) + 540) % 360) - 180;
    this.around = (this.around + d * (1 - Math.exp(-dt / tau)) + 360) % 360;
    if (!this.active()) return null;
    const shot = placeFor(heading, this.around, lengthM, topM, frame);
    // Coming back from a drag, or at first: glide in rather than jump.
    const blend = this.sinceDrag < 6 ? 1 - Math.exp(-dt / 0.8) : 1 - Math.exp(-dt / 0.15);
    return { ...shot, blend };
  }
}
