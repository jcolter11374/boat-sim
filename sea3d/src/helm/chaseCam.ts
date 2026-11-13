// The sailing camera at the wheel (Rosa; plan approved by Elena, 12 Nov): a chase boat's
// view. 30 degree lens, behind the boat and about 42 degrees to leeward (she heels toward us and we see
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
const OFF_DEG = 42;

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

/** Two subjects (the boat and a landmark she's sailing to): within this (m) the shot takes both in... */
export const TWO_SUBJECT_M = 2500;
/** ...on a longer lens (deg), so a lighthouse 1-2 km off reads as a building, not a speck. */
export const TWO_FOV = 20;
/** The camera stands this far (deg) off the line from the landmark through the boat, to leeward, so they sit on opposite thirds. */
const TWO_OFF = 14;
/** Which way to stand for a landmark at one end of the group (checked on frames). */
const TWO_SIDE_SIGN = -1;

/** How much of the two-subject shot (0..1): fades in from TWO_SUBJECT_M to 60% of it, only while the landmark is ahead (within 70 deg of the bow). */
export function twoSubject(distM: number, relDeg: number): number {
  if (Math.abs(relDeg) > 70) return 0;
  const x = Math.min(1, Math.max(0, (TWO_SUBJECT_M - distM) / (0.4 * TWO_SUBJECT_M)));
  return x * x * (3 - 2 * x);
}

/** The two-subject lens for a landmark group this wide (deg): long, but it keeps the whole group in its half of the frame. */
/** ...and no wider than this (deg): close to the light and its gate, a wide establishing shot. GUESS */
const TWO_FOV_MAX = 55;
export function twoFov(spanDeg: number): number {
  return Math.min(TWO_FOV_MAX, Math.max(TWO_FOV, 2 * spanDeg + 4));
}

export class ChaseCam {
  /** The lens the shot wants (deg): CHASE_FOV, or longer for two subjects. */
  fov = CHASE_FOV;
  /** The two-subject blend, eased (0..1). */
  private two = 0;
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
  update(
    dt: number,
    heading: number,
    twa: number,
    lengthM: number,
    topM: number,
    frame: Frame,
    still: boolean,
    subject?: { bearing: number; distM: number; spanDeg?: number; leanDeg?: number } | null,
  ): (Shot & { blend: number }) | null {
    if (!this.dragging) this.sinceDrag += dt;
    // Switch sides only when the wind is clearly on the other side (a tack or a gybe), not on a dead run.
    if (Math.abs(twa) < 165 && Math.sign(twa) !== this.side && twa !== 0) this.side = Math.sign(twa);
    // A landmark ahead: ease to a shot from behind her looking at it, both in frame (Elena's two-subject framing).
    const rel = subject ? ((((subject.bearing - heading) % 360) + 540) % 360) - 180 : 180;
    const twoWant = subject ? twoSubject(subject.distM, rel) : 0;
    this.two += (twoWant - this.two) * (1 - Math.exp(-dt / 1.5));
    if (this.two < 1e-3) this.two = 0;
    const alone = standAt(heading, this.side);
    // Stand on the side that keeps her mast off the landmark itself (leanDeg: where it sits in the group,
    // + clockwise), so its light never stacks on her masthead light (Ines, 12 Nov); else to leeward.
    const twoSide = subject?.leanDeg ? TWO_SIDE_SIGN * Math.sign(subject.leanDeg) : this.side;
    const both = (((subject?.bearing ?? 0) + 180 + twoSide * TWO_OFF) % 360 + 360) % 360;
    const dd = ((((both - alone) % 360) + 540) % 360) - 180;
    const want = (alone + dd * this.two + 360) % 360;
    this.fov = CHASE_FOV + (twoFov(subject?.spanDeg ?? 0) - CHASE_FOV) * this.two;
    frame = { ...frame, fovDeg: this.fov };
    if (this.around === null) this.around = want;
    // Ease the bearing (a tack swings it about 84 degrees, settled in about 3 s). Reduced motion: quicker, no sway.
    const tau = still ? 0.5 : 1.05;
    const d = ((((want - this.around) % 360) + 540) % 360) - 180;
    this.around = (this.around + d * (1 - Math.exp(-dt / tau)) + 360) % 360;
    if (!this.active()) return null;
    const shot = placeFor(heading, this.around, lengthM, topM, frame);
    // Coming back from a drag, or at first: glide in rather than jump.
    const blend = this.sinceDrag < 6 ? 1 - Math.exp(-dt / 0.8) : 1 - Math.exp(-dt / 0.15);
    return { ...shot, blend };
  }
}
