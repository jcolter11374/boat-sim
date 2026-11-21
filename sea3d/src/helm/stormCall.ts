// The storm call's options (Rosa's feel write-up, 14 Nov; Maya's pick 2): "turn away" is offered
// only when the forecast says it really is calmer. On 1 April 2020 every storm card asked "Hold
// course / Turn south-east / Slow down", and turning was no calmer (5.6 m against 5.4 m, and
// 145 km lost for 0.5 m less in a 9 m gale), so holding course won on every number shown and
// the card asked nothing. The price is the route check's own: 0.75 m of worst waves.
//
// Pure rules, no page: tests/stormCall.test.ts.

import type { Heading } from "./game";

/** Turning away is a choice only if its worst waves over the look are this much lower. */
export const DODGE_CALMER_M = 0.75;

/** Which of the storm card's options to keep, given each one's worst waves over the 4-day look
 * (null: no forecast for it). The options are, in order: hold course, turn away, and (with
 * motors) slow down. Holding course is always kept; slowing down is a trade of time for battery
 * and stays; turning away stays only when it is calmer. No forecast at all: keep them all. */
export function stormKeep(hsMax: (number | null | undefined)[]): boolean[] {
  const hold = hsMax[0];
  return hsMax.map((hs, i) => i !== 1 || hold == null || hs == null || hold - hs >= DODGE_CALMER_M);
}

/** When only "hold course" is left there is nothing to ask: a note, and she holds course. */
export function stormNote(intro: string): string {
  return `${intro} The forecast shows no calmer way round, so she holds course.`;
}

// "Slow down and ride it out" ends when the blow has passed (#654). It used to leave the boat at
// 10% power for the rest of the crossing, with only a tooltip saying "turn them back up after the
// blow": in the live play-through of 21 Nov 2026 the Orders panel then read "about 583 days to go
// at that pace". Now the order and power from before the call come back once the weather has
// passed, as the night call's "ease off till sunrise" does in the morning (helm/powerCall.ts).

/** The power "slow down and ride it out" sets. */
export const SLOW_POWER = 0.1;

/** What to go back to after riding it out: the order and power from before, and the count of
 * orders given (`seq`) once the slow order was in. Any order after it moves the count on. */
export interface Slowed {
  order: Heading;
  power: number;
  seq: number;
}

/** Once the blow has passed: the order and power to go back to, or null to leave things alone.
 * She goes back only if the slow order is still the last order given (`seq`: the count of orders
 * now). Any order since then (a new heading, more or less power, another card's choice) stands.
 * Counted, not compared by value: the night call's "ease off" is 10% power too, and the two must
 * not take each other's 10% for their own (review of #656). */
export function afterBlow(slowed: Slowed | null, seq: number): { order: Heading; power: number } | null {
  return slowed && slowed.seq === seq ? { order: slowed.order, power: slowed.power } : null;
}

/** The "it has passed" note's last sentence when the power comes back. */
export function backWords(back: { order: Heading; power: number }): string {
  return back.order === "auto" ? "She's back on the autopilot, as before." : `Back to ${Math.round(back.power * 100)}% power, as before.`;
}
