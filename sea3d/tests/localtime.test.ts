// The boat's local time under the UTC clock (src/replay/localtime.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { localTime, shortLocal, zoneAt, zoneLabel } from "../src/replay/localtime";

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

test("the strip's short zone label changes as the boat crosses zones (locked item S1)", () => {
  // Leaving the Chesapeake: the shore's clock, then the sea zones one by one going east.
  assert.equal(zoneLabel(36.9, -75.9, may), "EDT");
  assert.equal(zoneLabel(36.65, -74.9, may), "UTC−5"); // just past the shore box: the nautical zone
  assert.equal(zoneLabel(37, -67.6, may), "UTC−5");
  assert.equal(zoneLabel(37, -67.4, may), "UTC−4"); // across 67.5°W
  assert.equal(zoneLabel(38, -52.4, may), "UTC−3");
  assert.equal(zoneLabel(39.5, -13.5, may), "UTC−1"); // the finish
  assert.equal(zoneLabel(45, -3, may), "UTC");
  assert.equal(zoneLabel(38.7, -9.3, may), "WEST"); // Lisbon's summer time
  assert.equal(zoneLabel(38.98, -76.48, jan), "EST"); // Annapolis in winter
  // The clock beside it moves with the zone: the same moment, an hour later one zone east.
  assert.equal(shortLocal(may, 37, -67.6), "1 May 07:01");
  assert.equal(shortLocal(may, 37, -67.4), "1 May 08:01");
});
