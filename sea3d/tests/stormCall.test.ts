import { test } from "node:test";
import assert from "node:assert/strict";
import { DODGE_CALMER_M, stormKeep, stormNote } from "../src/helm/stormCall.ts";

test("turning away is offered only when the forecast says it is calmer (1 April 2020)", () => {
  assert.equal(DODGE_CALMER_M, 0.75);
  assert.deepEqual(stormKeep([5.4, 5.6, 5.4]), [true, false, true], "day 1.4: turning was rougher");
  assert.deepEqual(stormKeep([8.8, 8.3, 9.0]), [true, false, true], "day 17.3: 0.5 m calmer is not enough");
  assert.deepEqual(stormKeep([6.1, 5.3]), [true, true], "0.8 m calmer: a real choice");
  assert.deepEqual(stormKeep([null, null, null]), [true, true, true], "no forecast: ask as before");
  assert.deepEqual(stormKeep([5.4, 5.6]), [true, false]);
});

test("with only \"hold course\" left, a note", () => {
  assert.equal(stormNote("A gale is forecast here in about a day."), "A gale is forecast here in about a day. The forecast shows no calmer way round, so she holds course.");
});
