// A first crossing, guided (John, 24 Nov 2026: "This game isn't streamlined at all. New players will
// have no idea what to do"). Someone who has never played goes from the title straight to casting
// off (no Set sail card to fill in), and at sea gets one plain tip at a time in place of the open
// orders drawer: the goal, that time runs by itself, what a decision is, how to steer. Each tip is
// shown once ever. A returning player sees none of it: the card, the drawer and the key hint as before.
//
// This file is the rules and the words, no page: helm.ts shows them, title.ts picks the link.

import type { StorageLike } from "../myboat";

/** What this browser has been told. */
export const GUIDE_KEY = "boatsim.guide.v1";

/** Anything here means the game has been played in this browser: a voyage at sea, a finished one, a boat chosen. */
export const PLAYED_KEYS = [GUIDE_KEY, "boatsim.voyage.v1", "boatsim.lastcrossing.v1", "boatsim.crossing.best.v1", "boatsim.myboat.v1", "boatsim.challenge.best.v1"];

/** The tips, in the order they come. */
export type TipId = "goal" | "time" | "call" | "steer";
export const TIPS: readonly TipId[] = ["goal", "time", "call", "steer"];

function store(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // some browsers throw just for touching localStorage with storage off
  }
}

/**
 * Nobody has played here yet. With storage off we can't know, so the answer is no: the Set sail
 * card and the ordinary opening, rather than the first-time tips on every visit. Never throws.
 */
export function isNewcomer(s: StorageLike | null = store()): boolean {
  if (!s) return false;
  try {
    return PLAYED_KEYS.every((k) => s.getItem(k) === null);
  } catch {
    return false;
  }
}

/** Where the title's Set sail goes: a newcomer straight to sea on the defaults, anyone else to the card. */
export const setSailLink = (newcomer: boolean): string => (newcomer ? "helm.html?sail" : "helm.html");

/** The line under the title's Set sail for a newcomer. A crossing is 40 to 80 game days: a few minutes at the usual speed. */
export const START_HERE = "Start here. Your first crossing takes about five minutes.";

function seen(s: StorageLike | null): TipId[] {
  try {
    const d = JSON.parse(s?.getItem(GUIDE_KEY) ?? "null") as { seen?: unknown } | null;
    return Array.isArray(d?.seen) ? TIPS.filter((t) => (d!.seen as unknown[]).includes(t)) : [];
  } catch {
    return [];
  }
}

/** Remember that a tip was shown, so it never comes twice. Never throws. */
export function markSeen(tip: TipId, s: StorageLike | null = store()): void {
  try {
    const all = seen(s);
    if (!all.includes(tip)) all.push(tip);
    s?.setItem(GUIDE_KEY, JSON.stringify({ v: 1, seen: all }));
  } catch {
    // storage full or off: the tip may come once more, nothing worse
  }
}

export const wasSeen = (tip: TipId, s: StorageLike | null = store()): boolean => seen(s).includes(tip);

/** What the boat is driven by, for the steering tip: a motor boat has power, a sailing boat does not. */
export interface TipBoat {
  /** She has motors the player sets the power of. */
  power: boolean;
  /** A touch screen with no keyboard. */
  touch: boolean;
}

export interface Tip {
  head: string;
  body: string;
}

/**
 * The goal, for someone who has never seen the game: what it is, where to, who you are up against
 * and what you will be doing. The "ghost" is named here, because every panel after this uses the word.
 */
export function goalWords(km: number): Tip {
  return {
    head: "Get your boat across the Atlantic.",
    body: `It is ${Math.round(km).toLocaleString("en-US")} km to the finish line off Portugal, and she sails herself, day and night. A second boat, the ghost, makes the same crossing on autopilot. Your job is to get there before it.`,
  };
}

/** The tips after the goal. */
export function tipWords(tip: Exclude<TipId, "goal">, boat: TipBoat = { power: true, touch: false }): Tip {
  if (tip === "time")
    return {
      head: "Nothing to do yet.",
      body: "Time runs fast: a few seconds is a whole day at sea. Watch her go. The game stops by itself and asks you when there is a decision to make.",
    };
  if (tip === "call")
    return {
      head: "Your first decision.",
      body: "Time has stopped. Read the choices and pick one. The ghost always takes the autopilot's choice, so picking differently is how you get ahead of it, or fall behind.",
    };
  const keys = boat.touch
    ? "Open Orders, on the left, to turn her or change her speed."
    : boat.power
      ? "Press ← or → to turn her and ↑ or ↓ for more or less motor power. Space pauses."
      : "Press ← or → to turn her. Space pauses.";
  return {
    head: "You can steer her yourself, any time.",
    body: `${keys} The Orders panel on the left hands her back to the autopilot. More decisions are coming.`,
  };
}

/** How long a tip stays if nothing else ends it (ms): long enough to read, twice for the small ones. The
 *  goal hides the instruments while it is up, so it is kept to a slow read; the decision's stays until the choice (0). */
export const TIP_MS: Record<TipId, number> = { goal: 15_000, time: 45_000, call: 0, steer: 30_000 };
