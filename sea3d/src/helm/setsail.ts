// The one Set sail card's choices (Rosa; the one-game plan, Elena 12 Nov). Where (the ocean
// crossing or the Annapolis practice course), when (a calm or a rough start), and an optional
// weather challenge, all feeding the one sailing screen (helm.html). Jonas draws the card from
// SET_SAIL; Leo owns the words. The same choices ride in the URL, so the title, the Boatyard's
// "Test it" and Play again can open a filled-in card. Pure: no DOM here.

import type { Breeze, CourseKind } from "./course";

export type Where = "ocean" | "annapolis";
export type When = "calm" | "rough";
export type Course = CourseKind | "drill";

export interface SetSail {
  /** "" our kayak; "revc"/"revb" our model of the Randolph boat; a stock id; or a Boatyard design key. Annapolis practice always sails the 31 ft cruiser. */
  boat: string;
  where: Where;
  /** The crossing's start. Ignored for Annapolis and for a challenge (it brings its own day). */
  when: When;
  /** A weather challenge id, or "" for none. A challenge is an ocean crossing. */
  challenge: string;
  /** Annapolis only: the course and the breeze, picked on the card's second row. */
  course: Course | "";
  breeze: Breeze;
}

export const DEFAULT_SET_SAIL: SetSail = { boat: "", where: "ocean", when: "calm", challenge: "", course: "", breeze: "good" };

/**
 * The launch day each "when" stands for (the helm's #launch values). Fixed on purpose: these
 * two are an open item on John's list (Elena, 12 Nov), so don't pick new dates here.
 * Calm: 23 Apr 2020, a good day (Hs 0.9 m, 12 kt from the SW). Rough: 1 Apr 2020, the tail of
 * a gale, about 4 m waves (the odds launch with index 0).
 */
export const LAUNCH: Record<When, string> = { calm: "2020-04-23", rough: "0" };

export interface Option<K extends string> {
  key: K;
  /** Short, for the card (Leo rewrites). */
  label: string;
  /** One line under it. */
  sub: string;
}

/** What the card offers. Words are placeholders for Leo; keys are the contract. */
export const SET_SAIL = {
  where: [
    { key: "ocean", label: "The ocean crossing", sub: "From off the Chesapeake Bay to the finish off Portugal, in the real weather of 2020" },
    { key: "annapolis", label: "Annapolis practice", sub: "A Beneteau First 31.7 on the Bay: a short course, timed, against your best" },
  ] as Option<Where>[],
  when: [
    { key: "calm", label: "A calm start", sub: "23 April 2020: a good day, light seas" },
    { key: "rough", label: "A rough start", sub: "1 April 2020: the tail of a gale, about 4 m waves" },
  ] as Option<When>[],
  course: [
    { key: "triangle", label: "The triangle", sub: "Three marks 800 m apart: upwind, across, back" },
    { key: "light", label: "Thomas Point Light", sub: "About 7 km down the Bay; finish east of the light" },
    { key: "drill", label: "Drills", sub: "Short spells: a reach, a beat, a run" },
  ] as Option<Course>[],
  breeze: [
    { key: "light", label: "Light", sub: "8 kn" },
    { key: "good", label: "Good", sub: "12 kn" },
    { key: "fresh", label: "Fresh", sub: "18 kn" },
  ] as Option<Breeze>[],
};

const oneOf = <K extends string>(v: string | null, opts: Option<K>[]): K | null => (opts.some((o) => o.key === v) ? (v as K) : null);

/**
 * The choices in a page's URL, old links included: ?practice is Annapolis practice; ?challenge=x
 * (the Sea page's "Sail this sea") is that challenge; ?where=, ?when=, ?course=, ?breeze=, ?boat= are the card's own.
 */
export function fromUrl(search: string): SetSail {
  const p = new URLSearchParams(search);
  const s: SetSail = { ...DEFAULT_SET_SAIL };
  s.where = oneOf(p.get("where"), SET_SAIL.where) ?? (p.has("practice") ? "annapolis" : "ocean");
  s.when = oneOf(p.get("when"), SET_SAIL.when) ?? "calm";
  s.challenge = s.where === "ocean" ? (p.get("challenge") ?? "") : "";
  s.course = s.where === "annapolis" ? (oneOf(p.get("course"), SET_SAIL.course) ?? "") : "";
  s.breeze = oneOf(p.get("breeze"), SET_SAIL.breeze) ?? "good";
  s.boat = p.get("boat") ?? "";
  return s;
}

/** The URL for a set of choices (only what differs from the defaults); go: start at once on arrival. */
export function toUrl(s: SetSail, go = false): string {
  const p = new URLSearchParams();
  if (s.where !== "ocean") p.set("where", s.where);
  if (s.where === "ocean" && s.challenge) p.set("challenge", s.challenge);
  else if (s.where === "ocean" && s.when !== "calm") p.set("when", s.when);
  if (s.where === "annapolis" && s.course) p.set("course", s.course);
  if (s.where === "annapolis" && s.breeze !== "good") p.set("breeze", s.breeze);
  if (s.boat && s.where === "ocean") p.set("boat", s.boat);
  if (go) p.set("go", "1");
  const q = p.toString();
  return `helm.html${q ? `?${q}` : ""}`;
}

/** What a choice implies, for the card to show (a challenge fixes where and when). */
export function implied(s: SetSail): { whenShown: boolean; boatShown: boolean; courseShown: boolean } {
  return { whenShown: s.where === "ocean" && !s.challenge, boatShown: s.where === "ocean", courseShown: s.where === "annapolis" };
}

/** The card's own keys in a URL (and the old ?practice). */
const KEYS = ["where", "when", "challenge", "course", "breeze", "boat", "practice", "go"];
/** A page's query with the card's choices swapped in, keeping anything else (?quality=, ?hour=, tests' switches). */
export function withChoices(search: string, s: SetSail, go = false): string {
  const p = new URLSearchParams(search);
  for (const k of KEYS) p.delete(k);
  new URLSearchParams(toUrl(s, go).split("?")[1] ?? "").forEach((v, k) => p.set(k, v));
  const q = p.toString();
  return q ? `?${q}` : "";
}
