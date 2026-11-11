// The boat's local time under the UTC clock (src/replay/localtime.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { localTime, zoneAt } from "../src/replay/localtime";

const may = Date.parse("2026-05-01T12:01:00Z");
const jan = Date.parse("2026-01-15T12:01:00Z");

test("Eastern time in the Chesapeake, with summer time", () => {
  assert.equal(localTime(may, 38.98, -76.48), "8:01 AM local (UTC−4, EDT)");
  assert.equal(localTime(jan, 38.98, -76.48), "7:01 AM local (UTC−5, EST)");
});

test("the nautical zone at sea", () => {
  assert.deepEqual(zoneAt(36.65, -60, may), { offset: -4, name: "sea zone", zone: null });
  assert.equal(localTime(may, 39.5, -13.5), "11:01 AM local (UTC−1, sea zone)");
  assert.equal(localTime(may, 45, -3), "12:01 PM local (UTC, sea zone)");
});

test("the island's clock in the Azores, Lisbon's near Portugal", () => {
  assert.equal(localTime(may, 38.47, -28.4), "12:01 PM local (UTC, AZOST)");
  assert.equal(localTime(may, 38.7, -9.3), "1:01 PM local (UTC+1, WEST)");
});
