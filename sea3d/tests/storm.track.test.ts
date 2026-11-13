import assert from "node:assert/strict";
import { test } from "node:test";
import { centreAt, stormFromBoat, type StormRow } from "../src/helm/storm";

const track: StormRow[] = [
  ["2012-10-28T00:00:00Z", 32.0, -74.0],
  ["2012-10-28T01:00:00Z", 32.1, -74.0],
];

test("the storm centre is interpolated between hourly rows, and null outside them", () => {
  const c = centreAt(track, Date.parse("2012-10-28T00:30:00Z"))!;
  assert.ok(Math.abs(c.lat - 32.05) < 1e-9 && c.lon === -74);
  assert.equal(centreAt(track, Date.parse("2012-10-27T23:00:00Z")), null);
});

test("bearing and km from the boat: a storm due west is at 270°", () => {
  const s = stormFromBoat(track, Date.parse("2012-10-28T00:00:00Z"), 32.0, -70.0)!;
  assert.ok(Math.abs(s.km - 377) < 3, String(s.km)); // 4° of longitude at 32N
  assert.ok(Math.abs(s.bearing - 272) < 2.5, String(s.bearing)); // west, a touch north on a great circle
});
