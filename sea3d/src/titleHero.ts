/**
 * The title hero (one-game plan, step 1; Elena, 12 Nov): the first frame of the game.
 * The player's own boat on the open sea at golden hour, lit by a low sun off to one side
 * of her (never straight behind: its glow bleached her, John 13 Nov), filmed from a low
 * chase boat on a long lens (framing.ts titleShot), drifting slowly. No name
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
/**
 * The glow round bright things on the title: under half the usual strength and a tight
 * radius, so the low sun's light stays by the sun and nothing lies over the boat.
 */
export const HERO_GLOW = { scale: 0.45, radius: 0.2 };
/** How much the far water takes of the sky's warm horizon colour (0..1; gentle). */
export const HERO_SEA_WARM = 0.55;
/**
 * How the title lights a boat. sunOff: how far round from the lens's line the low sun stands
 * (degrees; framing.ts titleShot). fill, env: how much of the sky dome's light and of the
 * sky's reflections she keeps. back: the sun's edge light and the glow through sailcloth.
 *
 * A boat with sails is filmed towards the sun (30 degrees off it): her sails glow and she
 * reads as a shape against the sky. A low boat with no sails has nothing to glow, and that
 * way round her near side was in shadow: the orange kayak read as a dull brown shape on
 * grey-black water (Elena, 13 Nov). So for those the sun stands over the lens's shoulder, at
 * about three-quarters: the side we see catches the warm light, the deck reflects the sky.
 */
export interface HeroLight {
  sunOff: number;
  fill: number;
  env: number;
  back: number;
  /** Warm light on the far ripples, between her and the horizon (0..1). */
  glint: number;
}
export const HERO_LIGHT_SAILS: HeroLight = { sunOff: 30, fill: 0.35, env: 0.25, back: 1, glint: 0 };
export const HERO_LIGHT_LOW: HeroLight = { sunOff: 120, fill: 0.8, env: 0.8, back: 0, glint: 0.6 };
export function heroLightFor(key: string): HeroLight {
  return key === "kayak" || key === "randolph" || key === "stock_ocean_rower45" ? HERO_LIGHT_LOW : HERO_LIGHT_SAILS;
}
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
  // By where the card's middle is, not its top: on a short phone (375x667, 360x640) the card
  // is taller than 60% of the screen, and a rule on its top edge took it for the desktop
  // layout, so the boat was framed behind the menu.
  return r.width > 0.7 * width && (r.top + r.bottom) / 2 > 0.5 * height;
}
