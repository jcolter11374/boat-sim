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
  autopilot: { pill: "The autopilot", line: "She sails herself across. You sit back and watch her go.", after: "You can change speed and pause; she steers herself.", go: "Watch her go" },
  /** The card's button, and its launch day label (with the autopilot the year follows: "Launch day, 2020"). */
  go: "Set sail",
  dayLabel: "Launch day",
  /** The boat on the card has no voyage to watch (a design of your own, say). */
  none: "She hasn't sailed on that day yet. Pick another day, or test her in the Boatyard.",
} as const;

/** The card's pick in a link: ?who=autopilot (and ?day=2020-06-01). Anything else is you, on the default day. */
export function whoFromUrl(search: string): { who: Who; day: string; against: string } {
  const p = new URLSearchParams(search);
  const day = p.get("day") ?? "";
  const against = p.get("against") ?? "";
  return { who: p.get("who") === "autopilot" ? "autopilot" : "you", day: /^\d{4}-\d\d-\d\d$/.test(day) ? day : WATCH_DEFAULT_DAY, against: (RACE_IDS as readonly string[]).includes(against) ? against : "" };
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
const CARD_KEYS = ["where", "when", "challenge", "course", "breeze", "boat", "practice", "go", "who", "day", "against", "sail", "watch", "replay", "race", "launch"];
/** The link that sets sail with the autopilot steering: this page, watching that voyage. */
export function watchLink(search: string, file: string): string {
  const p = new URLSearchParams(search);
  for (const k of CARD_KEYS) p.delete(k);
  p.set("watch", file);
  return `helm.html?${p.toString()}`;
}

// ---------------------------------------------------------------- "Race against" (M2 piece R4)
// Race it is the autopilot steering two different boats on the same sea, so it sits under the
// autopilot pick: Nobody (you watch her alone) or Another boat (helm.html?race=<a>,<b>&launch=).

/** Leo's words (m2-r2-words.md, R4). */
export const RIVAL_WORDS = {
  label: "Race against",
  nobody: { pill: "Nobody", line: "Just her and the sea." },
  boat: { pill: "Another boat", line: "Same sea, same day. First to the finish wins.", after: "You can change speed and pause; both boats steer themselves." },
  /** With you steering the row isn't a choice: it says who the rival is. */
  you: "The ghost, the autopilot in a boat just like yours.",
  against: "Against:",
  picker: "The other boat",
  pick: "Pick this boat",
  same: "Pick a different boat. She can't race herself.",
} as const;

/** The boats a race can run (the race link's own ids, raceSource's RACE_BOATS). */
export const RACE_IDS = ["kayak", "revc", "revb", "mine"] as const;
export type RaceId = (typeof RACE_IDS)[number];
/** The six launches a race can start on, in the race's own order (?launch=0..5). */
export const RACE_DAYS = ["2020-04-01", "2020-04-15", "2020-05-01", "2020-05-15", "2020-06-01", "2020-06-15"];

/** "1 Jun" for "2020-06-01". */
export function dayLabel(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

/** The card's boat (the boat radio's value) as a race id; null for a boat the race can't run (a stock yacht). */
export function raceId(cardBoat: string): RaceId | null {
  if (cardBoat === "") return "kayak";
  return (RACE_IDS as readonly string[]).includes(cardBoat) ? (cardBoat as RaceId) : null;
}

/** A rival's name. A Randolph boat is always "(our model)" (John, B2). `mine` is the player's name for their saved design. */
export function rivalName(id: string, mine: string | null): string {
  return id === "revc" ? "Randolph Rev C5 (our model)" : id === "revb" ? "Randolph Rev B (our model)" : id === "mine" ? (mine ?? "Your boat") : "Our kayak";
}

/** The rival offered first: our model of the Randolph Rev C5, or our kayak when that is the boat on the card. */
export function defaultRival(a: RaceId): RaceId {
  return a === "revc" ? "kayak" : "revc";
}

/** The link that starts a race: this page, boat a against boat b, launched on `day` (the first launch if it isn't one of the six). */
export function raceLink(search: string, a: RaceId, b: RaceId, day: string): string {
  const p = new URLSearchParams(search);
  for (const k of CARD_KEYS) p.delete(k);
  p.set("race", `${a},${b}`);
  p.set("launch", String(Math.max(0, RACE_DAYS.indexOf(day))));
  return `helm.html?${p.toString()}`.replace("%2C", ",");
}

/** The link from a watched voyage's ending to sailing that day yourself: the Set sail card, You picked, the same launch day. */
export function sailLink(search: string, start: string): string {
  const p = new URLSearchParams(search);
  for (const k of CARD_KEYS) p.delete(k);
  p.set("who", "you");
  const day = start.slice(0, 10);
  if (/^\d{4}-\d\d-\d\d$/.test(day)) p.set("day", day);
  return `helm.html?${p.toString()}`;
}
