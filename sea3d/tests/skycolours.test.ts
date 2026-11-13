// Checks for the storm sky's colours and the break (clouds.ts skyColours). Hana, 12 Nov 2026.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { skyColours } from "../src/clouds";

const brownDusk = new THREE.Color(0.35, 0.22, 0.15); // a warm, brownish dusk haze

test("the deck is cold steel even when the haze is brown, and its bellies are darker", () => {
  const k = skyColours(brownDusk, 3, 0.8, 0.9);
  assert.ok(k.steel.b > k.steel.r, "steel is blue-grey, not brown");
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  assert.ok(lum(k.belly) < 0.5 * lum(k.steel));
});

test("the break shows under a stormy deck with the sun low, not on a fair day or at noon", () => {
  assert.ok(skyColours(brownDusk, 3, 0.8, 0.9).brk_amount > 0.9);
  assert.equal(skyColours(brownDusk, 3, 0, 0.1).brk_amount, 0); // fair: no deck, no break
  assert.ok(skyColours(brownDusk, 60, 0.8, 0.9).brk_amount < 0.45); // noon: a faint one at most
  assert.equal(skyColours(brownDusk, -10, 0.8, 0.9).brk_amount, 0); // night
});

test("the break is copper at sunset and paler gold with the sun higher", () => {
  const low = skyColours(brownDusk, 2, 0.8, 0.9).brk;
  const high = skyColours(brownDusk, 20, 0.8, 0.9).brk;
  assert.ok(low.r > low.b * 2.5, "copper");
  assert.ok(high.b / high.r > low.b / low.r, "paler, less red, with the sun higher");
});

test("a storm's wall shows from about 900 km and is full at 150 km", async () => {
  const { stormWall } = await import("../src/clouds");
  assert.equal(stormWall(2500), 0);
  assert.equal(stormWall(150), 1);
  assert.ok(stormWall(500) > 0.2 && stormWall(500) < 0.8);
  assert.equal(stormWall(NaN), 0);
});
