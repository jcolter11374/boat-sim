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

export class ShortWaveRide implements ShortRide {
  heave = 0;
  pitch = 0;
  roll = 0;
  private readonly gain: number;
  private readonly heaveGain: number;
  private readonly tau: number;

  /**
   * length, beam: waterline (m); bowX, sternX: their x in the boat frame (m).
   * GUESS (by eye against Sam's checklist): full tilt for a 3 m hull, falling as 3/L
   * beyond; heave follows a little less than fully, so crests climb a low deck
   * ("awash"); the lag is 0.12 s per sqrt(m) of length (a kayak about 0.2 s).
   */
  constructor(
    length: number,
    private readonly beam: number,
    private readonly bowX: number,
    private readonly sternX: number,
  ) {
    this.gain = Math.min(1, 3 / Math.max(length, 0.5));
    this.heaveGain = 0.75 * this.gain;
    this.tau = 0.12 * Math.sqrt(Math.max(length, 0.5));
  }

  /** height(x, z): the short waves alone at a world point (Sea.detailHeightAt). */
  update(height: (x: number, z: number) => number, place: Placement, dt: number): void {
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
    this.roll += (roll - this.roll) * k;
  }
}
