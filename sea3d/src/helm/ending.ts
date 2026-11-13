// The ways on from an ending (M3, "One ending, and go again"): every mode ends on the one results
// card, and the card offers the same ways on in the same order. Pure: the page draws what this says.
//
//   Play again · Change the boat · Race it · Leaderboard, then the mode's own extras as quiet links.
//
// A way on that makes no sense for a mode is left out, not hidden: a race's "Race it" is its
// "Race again"; a watched voyage has no boat of yours to change. Practice is sailed in the one practice
// yacht and has no board: it offers the course again, another course, and the ocean crossing.

import { leaderboardLink, raceItLink } from "../results";
import { RACE_IDS } from "./whoSteers";

export type EndMode = "crossing" | "challenge" | "watch" | "race" | "practice";
/** The card's buttons and links, by what they do. */
export type WayId = "again" | "follow" | "sail" | "boat" | "race" | "board" | "day" | "postcard" | "look" | "watch" | "course" | "atlantic";

export interface Way {
  id: WayId;
  label: string;
  /** Where a link goes; a way with none is a button the page wires itself. */
  href?: string;
}

export interface WayCtx {
  /** The page's own query (?quality= and the like are kept on links back into the game). */
  search: string;
  /** The design's key on the leaderboard (the card's `build`), when there is one. */
  build?: string;
  /** The Boatyard link that reopens the player's own boat, when one is saved. */
  boatyard?: string;
  /** The boat sailed, as a race id ("kayak", "revc", "revb", "mine"), or null for one the race can't run (a stock yacht). */
  raceId?: string | null;
  /** The launch day, "2020-06-01" or a full timestamp. */
  day?: string;
  /** A race: the other boat's race id, and her short name when she is still sailing and can be followed. */
  rival?: string;
  followName?: string;
  /** A watched voyage: the link that sails that day yourself. */
  sailHref?: string;
  /** Practice: the same course again, worded "Race your best run" or "Try again"; left out when there's no course to sail again (a drill). */
  again?: string;
  /** The finish scene is behind the card, or a voyage was watched: there is something to look around at. */
  canLook?: boolean;
}

/** The page's switches that aren't the Set sail card's own picks, kept on a link back into the game. */
function kept(search: string): URLSearchParams {
  const p = new URLSearchParams(search);
  for (const k of ["who", "day", "against", "watch", "race", "launch", "replay", "sail", "go", "challenge"]) p.delete(k);
  return p;
}

/** The Set sail card with the autopilot steering and another boat picked to race: the card's "Race against" row, ready to start. */
export function raceCardLink(search: string, against: string, day?: string): string {
  const p = kept(search);
  p.set("who", "autopilot");
  p.set("against", (RACE_IDS as readonly string[]).includes(against) ? against : "revc");
  const d = (day ?? "").slice(0, 10);
  if (/^\d{4}-\d\d-\d\d$/.test(d)) p.set("day", d);
  return `./helm.html?${p.toString()}`;
}

/** The Set sail card with the autopilot steering: watch her go. */
export function watchCardLink(search: string, day?: string): string {
  const p = kept(search);
  p.set("who", "autopilot");
  const d = (day ?? "").slice(0, 10);
  if (/^\d{4}-\d\d-\d\d$/.test(d)) p.set("day", d);
  return `./helm.html?${p.toString()}`;
}


/**
 * The ways on from an ending: `main` are the card's buttons, in order, the first one the orange one;
 * `quiet` are the small links under them.
 */
export function waysOn(mode: EndMode, c: WayCtx): { main: Way[]; quiet: Way[] } {
  const boat: Way = { id: "boat", label: "Change the boat", href: c.boatyard ?? "./boatyard.html" };
  const board: Way = { id: "board", label: "Leaderboard", href: leaderboardLink({ build: c.build, challenge: mode === "challenge" ? "yes" : null }) };
  // Race it: your boat against another, on the card. Our model of the Rev C5 first, or our kayak when the Rev C5 is the boat sailed.
  const mine = c.raceId === undefined ? "kayak" : c.raceId;
  const raceHref = mine ? raceItLink({ boat: mine === "kayak" ? "" : mine, day: c.day, quality: new URLSearchParams(c.search).get("quality") }) : null;
  const race: Way[] = raceHref ? [{ id: "race", label: "Race it", href: raceHref }] : [];
  const look: Way[] = c.canLook ? [{ id: "look", label: "Look around" }] : [];
  switch (mode) {
    case "crossing":
      return {
        main: [{ id: "again", label: "Play again" }, boat, ...race, board],
        quiet: [{ id: "day", label: "Try another launch day" }, { id: "watch", label: "Watch her go", href: watchCardLink(c.search, c.day) }, ...look],
      };
    case "challenge":
      // A challenge brings its own day and weather: no other launch day, and no race in its weather.
      return { main: [{ id: "again", label: "Try again" }, boat, board], quiet: look };
    case "watch":
      return {
        main: [{ id: "again", label: "Watch again" }, ...(c.sailHref ? [{ id: "sail" as const, label: "Sail it yourself", href: c.sailHref }] : []), ...race, board],
        quiet: [{ id: "postcard", label: "Save postcard" }, ...look],
      };
    case "practice":
      return {
        main: [...(c.again ? [{ id: "again" as const, label: c.again }] : []), { id: "course", label: "Another course" }],
        quiet: [{ id: "atlantic", label: "Sail across the Atlantic", href: "./helm.html" }],
      };
    case "race":
      return {
        main: [
          { id: "again", label: "Race again" },
          ...(c.followName ? [{ id: "follow" as const, label: `Follow ${c.followName} to the end` }] : []),
          { id: "boat", label: "Change the boats", href: raceCardLink(c.search, c.rival ?? "revc", c.day) },
          board,
        ],
        quiet: look,
      };
  }
}
