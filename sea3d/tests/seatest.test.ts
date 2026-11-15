// The picture-only sea and sun settings (seaTest.ts): ?sun= takes a named sun or any elevation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { seaTestFrom } from "../src/seaTest";

test("?sun= takes a named sun or a number of degrees, and nothing else", () => {
  assert.deepEqual(seaTestFrom("?sun=dusk").sun, { el: 3, az: 250 });
  assert.deepEqual(seaTestFrom("?sun=-8").sun, { el: -8, az: 250 });
  assert.equal(seaTestFrom("?sun=").sun, null);
  assert.equal(seaTestFrom("?sun=abc").sun, null);
  assert.equal(seaTestFrom("?sun=200").sun, null);
  assert.equal(seaTestFrom("").sun, null);
});
