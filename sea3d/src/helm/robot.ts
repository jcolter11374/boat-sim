// A robot sailor for the practice courses (Rosa): perfect trim (auto-trim), steers for the
// mark, and upwind sails the best angle for getting to windward and tacks on the layline.
// It sets the medal times (trial.ts) and a test re-sails it, so the targets stay honest when the
// trim tables change. Not used by the page.

import { Wheel, bestSheet } from "./wheel";

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** The true wind angle that makes the most ground to windward (deg off the wind). */
export function bestUpwind(w: Wheel): number {
  let best = 45;
  let vmg = 0;
  for (let a = 30; a <= 70; a += 1) {
    const v = bestSheet(w.table, w.s.plan, w.wind.twsKn, a).speedKn * Math.cos((a * Math.PI) / 180);
    if (v > vmg) [vmg, best] = [v, a];
  }
  return best;
}

/** Sail a wheel to the end of its course; returns the seconds it took (Infinity if it never got there). */
export function robotSail(w: Wheel, limitS = 4 * 3600, dt = 0.25): number {
  w.s.autoTrim = true;
  const up = bestUpwind(w);
  let tack = wrap180(w.wind.fromDeg - w.s.heading) >= 0 ? 1 : -1; // +1: wind on the starboard side
  while (!w.s.done && w.s.t < limitS) {
    const from = w.wind.fromDeg;
    const mb = w.markBearing();
    let want = mb;
    const off = wrap180(mb - from); // the mark's bearing off the wind
    if (Math.abs(off) < up) {
      // Upwind: the close-hauled heading on this tack; tack once the mark lies on the other tack's line.
      // On starboard (+1) she sails left of the wind, so the mark drifts to the right of it (off > 0).
      if (Math.sign(off) === tack && Math.abs(off) >= up - 2) tack = -tack;
      want = from - tack * up;
    } else tack = wrap180(from - mb) >= 0 ? 1 : -1;
    const err = wrap180(want - w.s.heading);
    w.step(dt, { helm: Math.max(-1, Math.min(1, err / 10)), sheet: 0 });
  }
  return w.s.done && !w.s.aground ? w.s.t : Infinity;
}
