import { test } from "node:test";
import assert from "node:assert/strict";
import { HERO_SEA, HERO_SUN, cardBelowOf, cardRightOf, heroSpec } from "../src/titleHero";
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
