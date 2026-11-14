import { test } from "node:test";
import assert from "node:assert/strict";
import { backdropAim, backdropQuality } from "../src/backdrop.ts";

test("the page's sea is looked at off to one side of the sun, never straight into it", () => {
  assert.equal(backdropAim(255), 217);
  assert.equal(backdropAim(10), 332); // wraps round north
});

test("the page's sea draws at Low on a computer with no graphics card, unless the link asks", () => {
  assert.equal(backdropQuality(null, true), "low");
  assert.equal(backdropQuality(null, false), "high");
  assert.equal(backdropQuality("high", true), "high");
  assert.equal(backdropQuality("low", false), "low");
  assert.equal(backdropQuality("ultra", true), "low");
});
