import { test } from "node:test";
import assert from "node:assert/strict";
import { HERO_GLOW, HERO_LIGHT_LOW, HERO_LIGHT_SAILS, HERO_SEA, HERO_SEA_WARM, HERO_SUN, cardBelowOf, cardRightOf, heroLightFor, heroSpec, heroWaterlineFor } from "../src/titleHero";
import type { MyBoat } from "../src/myboat";

const boat = (kind: MyBoat["kind"], base: string): MyBoat => ({ kind, base, hash: "", name: "x", choices: {}, saved: "" });

test("the hero shows the player's own boat, our kayak when there is none", () => {
  assert.equal(heroSpec(null).key, "kayak");
  assert.equal(heroSpec(boat("yard", "kayak")).key, "kayak");
  assert.equal(heroSpec(boat("yard", "revc")).key, "randolph");
  assert.equal(heroSpec(boat("stock", "stock_pearson31_2")).key, "stock_pearson31_2");
  assert.equal(heroSpec(boat("stock", "stock_nonesuch")).key, "kayak");
});

test("the hero's light and sea: golden hour, a gentle sea", () => {
  assert.ok(HERO_SUN.el > 2 && HERO_SUN.el < 8);
  assert.ok(HERO_SEA.hs <= 1);
});

test("the menu's width comes from the page, a third when unknown, never most of the screen", () => {
  assert.equal(cardRightOf(null, 1280), 1 / 3);
  const el = { getBoundingClientRect: () => ({ right: 424, width: 360 }) } as unknown as Element;
  assert.ok(Math.abs(cardRightOf(el, 1280) - 424 / 1280) < 1e-9);
  const wide = { getBoundingClientRect: () => ({ right: 380, width: 350 }) } as unknown as Element;
  assert.equal(cardRightOf(wide, 390), 0.6);
});

test("the menu counts as below the boat on short phones too, never on a desktop or a phone on its side", () => {
  const card = (left: number, top: number, right: number, bottom: number) => ({ getBoundingClientRect: () => ({ left, top, right, bottom, width: right - left, height: bottom - top }) }) as unknown as Element;
  assert.equal(cardBelowOf(null, 390, 844), false);
  assert.equal(cardBelowOf(card(12, 452, 400, 897), 412, 915), true); // a tall phone
  assert.equal(cardBelowOf(card(12, 257, 363, 649), 375, 667), true); // a short phone: the card starts above 40% of the height
  assert.equal(cardBelowOf(card(12, 240, 348, 622), 360, 640), true);
  assert.equal(cardBelowOf(card(64, 160, 424, 600), 1280, 720), false); // desktop: the card is down the left
  assert.equal(cardBelowOf(card(42, 44, 402, 372), 844, 390), false); // a phone on its side
});

test("the title's glow is small and tight, so the low sun's light can't lie over the boat", () => {
  assert.ok(HERO_GLOW.scale > 0 && HERO_GLOW.scale <= 0.5, "under half the usual strength, not off");
  assert.ok(HERO_GLOW.radius <= 0.25, "tight (the usual radius is 0.55)");
});

test("the title's far water is warmed gently: some of the sky's colour, never all of it", () => {
  assert.ok(HERO_SEA_WARM > 0.2 && HERO_SEA_WARM <= 0.7);
});

test("a boat with sails is filmed towards the sun; a low boat without sails is lit on the side we see", () => {
  for (const k of ["stock_pearson31_2", "stock_cruiser31", "stock_dinghy14", "stock_beachcat16", "stock_sail_drone7"]) assert.equal(heroLightFor(k), HERO_LIGHT_SAILS, k);
  for (const k of ["kayak", "randolph", "stock_ocean_rower45"]) assert.equal(heroLightFor(k), HERO_LIGHT_LOW, k);
  // Towards the sun but never straight into it; or the sun well behind the lens's shoulder.
  assert.ok(HERO_LIGHT_SAILS.sunOff >= 25 && HERO_LIGHT_SAILS.sunOff <= 45 && HERO_LIGHT_SAILS.back === 1);
  assert.ok(HERO_LIGHT_LOW.sunOff >= 100 && HERO_LIGHT_LOW.sunOff <= 150 && HERO_LIGHT_LOW.back === 0);
  // Warm light on the far ripples only where the sun is behind the lens, and gently.
  assert.ok(HERO_LIGHT_SAILS.glint === 0 && HERO_LIGHT_LOW.glint > 0 && HERO_LIGHT_LOW.glint <= 0.8);
  // A low boat is filmed from a little higher, so the far shore stands clear above her.
  assert.ok(HERO_LIGHT_SAILS.camH === 1.5 && HERO_LIGHT_LOW.camH > 1.6 && HERO_LIGHT_LOW.camH <= 2.4);
  assert.ok(HERO_LIGHT_LOW.fill > HERO_LIGHT_SAILS.fill && HERO_LIGHT_LOW.env > HERO_LIGHT_SAILS.env);
});

test("the title's white boats sit a touch deeper, with a soft wet line at the water; the others as before", () => {
  const rev = heroWaterlineFor("randolph");
  const kay = heroWaterlineFor("kayak");
  assert.ok(rev.sink > 0 && rev.sink < 0.05, "a few cm deeper, not swamped (her draft is 9 cm)");
  assert.ok(kay.sink > 0 && kay.sink < rev.sink, "the kayak too, but lighter");
  assert.ok(kay.wet > 0 && kay.wet < rev.wet);
  assert.deepEqual(heroWaterlineFor("stock_pearson31_2"), { sink: 0, wet: 0 });
});

test("the title's backlight goes out with the sun: full at the title's dusk, none at night", async () => {
  const { backAt } = await import("../src/titleHero");
  assert.equal(backAt(HERO_SUN.el), 1);
  assert.equal(backAt(55), 1);
  assert.equal(backAt(-18), 0);
  assert.equal(backAt(-6), 0);
  for (let el = -8; el < 4; el += 0.5) assert.ok(backAt(el + 0.5) >= backAt(el));
});

test("a yacht's lamps at night light the cockpit, not the sails", async () => {
  const { COCKPIT_REACH_M, BACK_FILL } = await import("../src/boats/nightlook");
  // The Pearson's boom is about 2.5 m above the cockpit lamp: out of its reach.
  assert.ok(COCKPIT_REACH_M <= 2.4 && COCKPIT_REACH_M >= 1.5);
  assert.ok(BACK_FILL > 0 && BACK_FILL <= 1.5, "the fill lifts dark paint without matching the sky");
});
