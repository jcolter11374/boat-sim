// The short wind waves on top of the swell, felt by the hull for the picture only.
// The motion model (motion.ts) rides the big waves (waves.ts heightAt), the same
// waves in every replay, so the simulator stays bit-identical. The drawn sea also has
// short waves (seaDetail.ts), and a 3 m kayak is a cork on those too: it tilts with
// every bump, rolls fast and never sits steady (Sam's realism checklist 3). This adds
// that on top of the motion, display only.
//
// Four points on the waterline (stem, stern, both sides at the widest) read the short
// waves' height; the hull heaves by their mean and tilts by their differences,
// smoothed by a first-order lag about as long as the hull's own response. A hull much
// longer than the short waves averages them out, so the response falls with length.

import { toWorld, type Placement } from "../standin";

export interface ShortRide {
  heave: number; // m
  pitch: number; // rad, bow up +
  roll: number; // rad, as motion.ts (rotation.x)
}

/** A knockdown on screen (times in the page clock's seconds). */
export interface KnockdownTiming {
  /** The crest hits: the boat starts going over. */
  start: number;
  /** Flat on the water (the roll's peak). */
  flat: number;
  /** Starts to come back up after hanging there a beat. */
  rising: number;
  /** Back within 10 deg of upright. */
  upright: number;
  /** Peak roll, deg; side: +1 over to starboard, -1 to port. */
  peakDeg: number;
  side: number;
}

/** Knockdown shape by hull length (GUESS by eye, Elena's brief): thrown flat in half a
 *  second, hangs a beat, then rights itself, the kayak (dome and keel weight) quickly,
 *  a 31 footer slower with the water pouring off. */
function knockShape(length: number): { peak: number; build: number; hang: number; recover: number } {
  const big = Math.min(1, Math.max(0, (length - 3) / 6.5)); // 0 kayak .. 1 at 9.5 m
  return { peak: 82 - 8 * big, build: 0.5 + 0.3 * big, hang: 0.7 + 0.6 * big, recover: 1.6 + 2.8 * big };
}

export class ShortWaveRide implements ShortRide {
  heave = 0;
  pitch = 0;
  roll = 0;
  private readonly gain: number;
  private readonly heaveGain: number;
  private readonly tau: number;
  private readonly shape: ReturnType<typeof knockShape>;
  private knockAt = -1e9;
  private knockSide = 1;
  /** The roll from the short waves alone (rad), before any knockdown. */
  private waveRoll = 0;
  /** The last knockdown thrown, or null (for the cinema's Heel shot). */
  knockdown: KnockdownTiming | null = null;

  /**
   * length, beam: waterline (m); bowX, sternX: their x in the boat frame (m).
   * GUESS (by eye against Sam's checklist): 1.4 x the slope for a 3 m hull, falling as 4.2/L
   * beyond; heave follows a little less than fully, so crests climb a low deck
   * ("awash"); the lag is 0.12 s per sqrt(m) of length (a kayak about 0.2 s).
   */
  constructor(
    length: number,
    private readonly beam: number,
    private readonly bowX: number,
    private readonly sternX: number,
  ) {
    // A small hull is livelier than the water slope alone: it's thrown about by the
    // short crests (Sam: rolls and pitches about every second, never steady).
    this.gain = Math.min(1.4, 4.2 / Math.max(length, 0.5));
    this.heaveGain = 0.75 * Math.min(1, 3 / Math.max(length, 0.5));
    this.tau = 0.12 * Math.sqrt(Math.max(length, 0.5));
    this.shape = knockShape(length);
  }

  /** Throw the boat flat now (t: the page clock, s); side +1 to starboard, -1 to port. */
  knock(t: number, side: number): KnockdownTiming {
    const k = this.shape;
    this.knockAt = t;
    this.knockSide = side < 0 ? -1 : 1;
    const flat = t + k.build;
    const rising = flat + k.hang;
    this.knockdown = { start: t, flat, rising, upright: rising + 0.75 * k.recover, peakDeg: k.peak, side: this.knockSide };
    return this.knockdown;
  }

  /** The knockdown's roll (rad, as motion.ts) at time t: 0 outside one. */
  knockRoll(t: number): number {
    const k = this.shape;
    const x = t - this.knockAt;
    if (x < 0 || x > k.build + k.hang + 2.5 * k.recover) return 0;
    const peak = (k.peak * Math.PI) / 180;
    let a: number;
    if (x < k.build) {
      const u = x / k.build;
      a = peak * u * u * (3 - 2 * u); // the crest shoves it over
    } else if (x < k.build + k.hang) {
      const u = (x - k.build) / k.hang;
      a = peak * (1 - 0.06 * Math.sin(u * Math.PI)); // hangs there, sagging back a touch
    } else {
      // Rights itself and settles (a hair past upright).
      const u = (x - k.build - k.hang) / k.recover;
      a = peak * Math.exp(-2.6 * u) * Math.cos(1.14 * u);
    }
    // rotation.x lowers +z (port), so over to starboard is a negative roll.
    return -this.knockSide * a;
  }

  /** Heel now as the page shows it, deg, + over to starboard: the motion's roll plus ours. */
  heelDeg(motionRoll: number): number {
    return (-(motionRoll + this.roll) * 180) / Math.PI;
  }

  /** height(x, z): the short waves alone at a world point (Sea.detailHeightAt). */
  update(height: (x: number, z: number) => number, place: Placement, dt: number, t = 0): void {
    const at = (bx: number, bz: number) => {
      const [x, z] = toWorld(bx, bz, place);
      return height(x, z);
    };
    const mid = (this.bowX + this.sternX) / 2;
    const hb = at(this.bowX, 0);
    const hs = at(this.sternX, 0);
    const hp = at(mid, -this.beam / 2);
    const hsb = at(mid, this.beam / 2);
    const span = Math.max(this.bowX - this.sternX, 0.3);
    const heave = this.heaveGain * (hb + hs + hp + hsb) / 4;
    const pitch = this.gain * Math.atan2(hb - hs, span);
    // rotation.x lowers +z: roll the hull so the side with the higher water lifts.
    const roll = -this.gain * Math.atan2(hsb - hp, Math.max(this.beam, 0.2));
    const k = dt > 0 ? 1 - Math.exp(-dt / this.tau) : 0;
    this.heave += (heave - this.heave) * k;
    this.pitch += (pitch - this.pitch) * k;
    this.waveRoll += (roll - this.waveRoll) * k;
    this.roll = this.waveRoll + this.knockRoll(t);
  }
}
