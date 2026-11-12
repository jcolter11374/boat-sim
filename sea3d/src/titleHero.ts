/**
 * The title hero (one-game plan, step 1; Elena, 12 Nov): the first frame of the game.
 * The player's own boat on the open sea at golden hour, backlit by a low sun, filmed
 * from a low chase boat on a long lens (cinema.ts titleShot), drifting slowly. No name
 * tags; the left of the screen is kept clear for the logo and the three choices.
 * These are the hero's choices; index.html (main.ts) draws it while the title shows.
 */
import { STOCK, KAYAK, RANDOLPH, type BoatSpec, type StockKey } from "./boats/specs";
import type { MyBoat } from "./myboat";
import type { SeaState } from "./waves";

/** The sun for the hero: 5 degrees up (warm, long light, still bright enough to model the sails), in the west. */
export const HERO_SUN = { el: 5, az: 255 };
/** Fair-weather cumulus, a third of the sky: lit heads and gold rims at golden hour (Hana's #410). */
export const HERO_CLOUD = 0.3;
/** The sky's pattern for the hero: a fixed day, so the first frame is the same every visit. */
export const HERO_SKY_DAY = 20190;
/** A gentle sea: low enough that the hull stays clear of the crests from a 1.5 m camera, big enough to move. */
export const HERO_SEA: SeaState = { name: "Title", hs: 0.8, tp: 6.5, meanDirection: 0.3 };

/** The boat the hero shows: the player's own; our kayak when they haven't chosen one. */
export function heroSpec(mine: MyBoat | null): BoatSpec {
  if (!mine) return KAYAK;
  if (mine.kind === "stock" && mine.base in STOCK) return STOCK[mine.base as StockKey];
  if (mine.base === "revb" || mine.base === "revc") return RANDOLPH;
  return KAYAK;
}

/**
 * How much of the screen's width the title's menu covers, from the left edge (0..1): the
 * shot keeps the boat to the right of it. Measured from the page, so it follows Jonas's
 * layout on any screen; a third when there's nothing to measure.
 */
export function cardRightOf(el: Element | null, width: number): number {
  const r = el?.getBoundingClientRect();
  if (!r || !r.width || !width) return 1 / 3;
  return Math.min(0.6, Math.max(0, r.right / width));
}

/**
 * Whether the title's menu runs across the bottom of the screen (Jonas's phone layout) rather
 * than down the left: then the shot puts the boat above it (framing.ts TITLE_PHONE).
 */
export function cardBelowOf(el: Element | null, width: number, height: number): boolean {
  const r = el?.getBoundingClientRect();
  if (!r || !r.width || !width || !height) return false;
  return r.width > 0.7 * width && r.top > 0.4 * height;
}
