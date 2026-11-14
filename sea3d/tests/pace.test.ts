import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain .mjs tool, no types
import { MAX_PACE, REFERENCE_MS, T, paceFor } from "../../tools/playtest/pace.mjs";

test("click waits are as written on a machine drawing at the reference frame time or faster", () => {
  assert.equal(paceFor(REFERENCE_MS), 1);
  assert.equal(paceFor(120), 1);
  assert.equal(paceFor(16.7), 1);
});

test("a slower machine stretches the waits in proportion, and never past the cap", () => {
  assert.equal(paceFor(REFERENCE_MS * 2), 2);
  assert.ok(Math.abs(paceFor(1183) - 1183 / REFERENCE_MS) < 1e-9); // a slow runner's Chrome, 14 Nov
  assert.equal(paceFor(REFERENCE_MS * 10), MAX_PACE);
});

test("a page that never drew leaves the waits as written", () => {
  assert.equal(paceFor(0), 1);
  assert.equal(paceFor(Number.NaN), 1);
  assert.equal(paceFor(-5), 1);
});

test("before the machine is measured, T is the wait as written", () => {
  assert.equal(T(15_000), 15_000);
});
