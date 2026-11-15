// The far mist after dark under cloud (atmosphere.ts): no pale stripe on the horizon.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { NIGHT_HAZE, STORM_HAZE, STORM_NIGHT, twilightLit } from "../src/atmosphere";
import { DECK_NIGHT_LIFT, skyColours } from "../src/clouds";

const lum = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

test("an overcast night's haze is about as dark as a clear night's, not a lit grey band", () => {
  const overcast = lum(STORM_HAZE.clone().multiplyScalar(STORM_NIGHT));
  const clear = lum(NIGHT_HAZE);
  // Elena, 14 Nov: at full night under cloud the horizon sits within a shade of the sky (it was ten times the clear night's).
  assert.ok(overcast < 2.5 * clear, `overcast night haze ${overcast.toFixed(4)} vs clear ${clear.toFixed(4)}`);
  assert.ok(overcast > 0.5 * clear, "but not black: the sea's far edge still fades into something");
});

test("after dark the deck is lifted against the haze, so it is not black above the horizon; by day it is as before", () => {
  const ratio = (el: number) => {
    const haze = STORM_HAZE.clone().multiplyScalar(el < 0 ? STORM_NIGHT : 1);
    return lum(skyColours(haze, el, 0.8, 1).steel) / lum(haze);
  };
  assert.ok(Math.abs(ratio(-30) / ratio(30) - (1 + DECK_NIGHT_LIFT)) < 1e-6);
  assert.ok(Math.abs(ratio(30) - 1.4 * lum({ r: 0.84, g: 0.95, b: 1.12 })) < 1e-6); // the daytime steel, unchanged
});

test("dusk: the light for the sea and the boat follows the twilight sky, not the day's curve that ends at -5 degrees", () => {
  // Elena, 14 Nov: at -5 degrees the scene is dim but readable; black only by about -12. Nights stay dark (L3).
  assert.ok(twilightLit(-4) > 0.25, `at -4: ${twilightLit(-4)}`);
  assert.ok(twilightLit(-8) > 0.1 && twilightLit(-8) < twilightLit(-4));
  assert.equal(twilightLit(-12), 0);
  assert.equal(twilightLit(-20), 0);
  for (const el of [-1, 0, 3, 10, 40]) assert.ok(twilightLit(el) >= THREE.MathUtils.smoothstep(el, -5, 6), `never darker than the day's own at ${el}`);
  assert.equal(twilightLit(10), THREE.MathUtils.smoothstep(10, -5, 6)); // the day itself unchanged
  for (let el = -15; el < 10; el += 0.5) assert.ok(twilightLit(el + 0.5) >= twilightLit(el), `brightens as the sun rises (${el})`);
});
