// The power call (Rosa, M5 piece D2): "spend the battery, or bank it?"
//
// The route check (helm.ts maybeRouteCheck) looks at the forecast every few quiet days and asks
// about a better HEADING. This is the same look asking about POWER: with a well-charged battery,
// would more power gain on what you are doing now over the next 4 days, and what would it cost?
// It is a call only when it is a real trade (Elena's rule): a quarter of a day or more gained,
// paid for with a battery low point 8 points or more below what you have now. The numbers come
// from the simulator sailing a copy of your boat in the forecast as issued (sandbox/helm.py
// Game.outlook), so the card's stake is the forecast's, never the truth.
//
// Pure rules and words, no page: tests/powerCall.test.ts.

import type { Heading, Preview } from "./game";

/** The power levels the look tries, as shares of full drive power. Two, because each costs a
 * 4-day forecast sail in the browser. With one of two motors dead a share buys half the watts,
 * which is why the higher level is there. GUESS, tuned on six launch days of 2020. */
export const PUSH_LEVELS = [0.5, 0.8] as const;
/** A push is worth a card when the forecast puts it this far ahead of your present order. */
export const PUSH_GAIN_DAYS = 0.25;
/** ... and it pays: the battery's low point is this much lower (the route check's own price). */
export const PUSH_DRAIN = 0.08;
/** Not asked below this charge: there is nothing to spend. GUESS. */
export const PUSH_MIN_SOC = 0.5;
/** A level is "more power" only if it is this much above the order in force. */
const PUSH_STEP = 0.05;

/** Where a push points her. On the autopilot there is no heading of yours to keep, so a push is
 * the plainest order there is: straight at the finish. Steering yourself, your heading stays. */
export function pushHeading(order: Heading): Heading {
  return order === "auto" ? "finish" : order;
}

/** The orders to add to the route check's forecast look: empty when there is nothing to ask
 * (no motors, a low battery, or already at or above every level). */
export function pushOrders(order: Heading, power: number, soc: number, motors: boolean): { heading: Heading; power: number }[] {
  if (!motors || soc < PUSH_MIN_SOC) return [];
  return PUSH_LEVELS.filter((p) => p >= power + PUSH_STEP).map((p) => ({ heading: pushHeading(order), power: p }));
}

type Staked = Preview & { lead_km: number; power?: number };

/** The push worth asking about, if any: the level the forecast puts furthest ahead, when that is
 * a real trade against `now` (your present order in the same forecast). paceKmPerDay: the
 * ghost's, to turn km into days as the route check does. */
export function pickPush<T extends Staked>(now: Staked, pushes: T[], paceKmPerDay: number): { push: T; gainDays: number } | null {
  if (!(paceKmPerDay > 1) || !pushes.length) return null;
  const push = pushes.reduce((a, b) => (b.lead_km > a.lead_km ? b : a));
  const gainDays = (push.lead_km - now.lead_km) / paceKmPerDay;
  const drains = (now.soc_min ?? 1) - (push.soc_min ?? 1) >= PUSH_DRAIN;
  return gainDays >= PUSH_GAIN_DAYS && drains ? { push, gainDays } : null;
}

/** After "stay" the same question is not asked again (Maya, 14 Nov; the storm call's rule): only
 * an offer clearly better than the one turned down, by this many days of forecast gain. */
export const PUSH_BETTER_DAYS = 0.25;
/** turnedDown: the forecast gain (days) of the last push you said "stay" to, or null if you took
 * the last one or none has been asked. */
export function worthAskingAgain(gainDays: number, turnedDown: number | null): boolean {
  return turnedDown === null || gainDays >= turnedDown + PUSH_BETTER_DAYS;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The card's words (Elena's ruling, 14 Nov: plain, no "would gain on"). One sentence of what the
 * forecast says, with the price in it; the options' forecast tags carry the numbers. `ago`: what
 * the note four days later opens with, before "she's now N km ahead of the ghost". */
export function pushCard(order: Heading, power: number, soc: number, push: Staked): { text: string; push: string; pushTitle: string; stay: string; did: string; ago: string } {
  const to = pct(push.power ?? 0);
  const low = pct(push.soc_min ?? 0);
  const faster = order === "auto" ? "pull ahead of the autopilot" : `go faster than at your ${pct(power)}`;
  return {
    text: `Navigator's check: the battery is at ${pct(soc)}. At ${to} power she'd ${faster} over the next 4 days, but the battery would drop to ${low}.`,
    push: `Push: ${to} power`,
    pushTitle: "Faster, but it drains the battery. Ease off, or hand her back to the autopilot, before it runs low.",
    stay: order === "auto" ? "Stay on the autopilot (same as the ghost)" : `Keep ${pct(power)} power`,
    did: `pushed to ${to} power`,
    ago: `You pushed to ${to} power 4 days ago`,
  };
}

/** How the night call opens (Elena, 14 Nov). "Night is coming" only when dark is about 3 hours
 * off or less; earlier in the day it gives the time instead, because after a push the call can
 * come around midday. hoursToDark: to the first forecast row with no sun; the rows are 6 hours
 * apart, so it is "dark in about", not a sunset time. */
export function nightOpener(soc: number, hoursToDark: number): string {
  if (hoursToDark <= 3) return `The battery is at ${pct(soc)} and night is coming, with no sun to charge it.`;
  return `The battery is at ${pct(soc)}, and it will be dark in about ${Math.round(hoursToDark)} hours, with no sun to charge it.`;
}

/** The note when you steer and the forecast puts the autopilot ahead of your order. */
export function handBackNote(km: number): string {
  const n = Math.max(5, Math.round(Math.abs(km) / 5) * 5);
  return `Navigator's note: for the next 4 days the forecast favours the autopilot over your order (about ${n} km better against the ghost). To hand her back, open Orders.`;
}

/** The night call may follow a push this soon (hours): the push is what runs the battery down,
 * so "night is coming and she is low" must not wait out the usual two quiet days after it. */
export const NIGHT_AFTER_PUSH_H = 12;

/** The charge under which a night at this power could run her flat, so the night call asks.
 * At the autopilot's cruise (25%) it is the 35% the call has always used; above that it rises
 * with the power, because a night at 50 W takes about half our kayak's battery (1280 Wh) and the
 * motors stop at 15%. GUESS: fitted to our kayak, used for every boat with motors. */
export function nightLine(power: number): number {
  return Math.min(0.9, Math.max(0.35, 0.15 + 0.8 * power));
}

/** The power an order leaves on the Orders panel. A push raises it; handing her back to the
 * autopilot puts it back to what it was before the push (`before`, null if there was none), so a
 * heading ordered days later does not quietly sail at the pushed power. On the autopilot the
 * power is the autopilot's own, so this is only what your next order of your own starts from. */
export function powerAfter(heading: Heading, asked: number, before: number | null): number {
  return heading === "auto" && before !== null ? before : asked;
}
