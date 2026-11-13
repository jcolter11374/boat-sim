// The Set sail card's "Who steers" row (M2 piece R2; Rosa, Elena's five conditions, Leo's words
// in handoffs/m2-r2-words.md). "You" is the crossing as it has always been. "The autopilot" is
// the same crossing with the autopilot steering all the way: you sit back and watch her go.
// To the player it is one crossing either way, so nothing here that a player reads says how the
// watched voyage is stored. Pure: no DOM here.

import type { IndexEntry } from "../replay/data";
import { WATCH_DEFAULT_DAY, watchBase } from "./watchSource";

export type Who = "you" | "autopilot";

/** Leo's words (m2-r2-words.md). The button says "Set sail" for both. */
export const WHO_WORDS = {
  label: "Who steers",
  you: { pill: "You", line: "You give the orders, and race the ghost to Portugal.", after: "You can change speed, pause, and take the wheel once you're at sea." },
  autopilot: { pill: "The autopilot", line: "She sails herself across. You sit back and watch her go.", after: "You can change speed and pause; she steers herself." },
  /** The boat on the card has no voyage to watch (a design of your own, say). */
  none: "She hasn't sailed on that day yet. Pick another day, or test her in the Boatyard.",
} as const;

/** The card's pick in a link: ?who=autopilot (and ?day=2020-06-01). Anything else is you, on the default day. */
export function whoFromUrl(search: string): { who: Who; day: string } {
  const p = new URLSearchParams(search);
  const day = p.get("day") ?? "";
  return { who: p.get("who") === "autopilot" ? "autopilot" : "you", day: /^\d{4}-\d\d-\d\d$/.test(day) ? day : WATCH_DEFAULT_DAY };
}

export interface WatchDay {
  /** "2020-06-01" */
  day: string;
  /** "1 Jun" and "2020": a plain date, with no hint of how the voyage ends (finding out is the point). */
  label: string;
  year: string;
  /** The voyage's file in the index. */
  file: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The days the card's boat can be watched, in date order. `base` is the helm's boat key ("" our kayak, "revc", a stock id). */
export function watchDays(index: IndexEntry[], base: string): WatchDay[] {
  return index
    .filter((v) => watchBase(v.boat) === base && /^\d{4}-\d\d-\d\d/.test(v.start))
    .map((v) => {
      const day = v.start.slice(0, 10);
      return { day, label: `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`, year: day.slice(0, 4), file: v.file };
    })
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** The day picked, if she sailed then; else the default day (1 June 2020); else her first. Null when she has none. */
export function watchDay(days: WatchDay[], asked: string): WatchDay | null {
  return days.find((d) => d.day === asked) ?? days.find((d) => d.day === WATCH_DEFAULT_DAY) ?? days[0] ?? null;
}

/** The card's own keys, dropped from a link that starts watching (the page's other switches, ?quality= and the like, are kept). */
const CARD_KEYS = ["where", "when", "challenge", "course", "breeze", "boat", "practice", "go", "who", "day", "sail", "watch", "replay", "race", "launch"];
/** The link that sets sail with the autopilot steering: this page, watching that voyage. */
export function watchLink(search: string, file: string): string {
  const p = new URLSearchParams(search);
  for (const k of CARD_KEYS) p.delete(k);
  p.set("watch", file);
  return `helm.html?${p.toString()}`;
}
