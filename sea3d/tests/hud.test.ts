// The helm's instrument strip words (src/helm/hud.ts) and its short local time (src/replay/localtime.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { point } from "../src/helm/hud";
import { shortLocal } from "../src/replay/localtime";

test("a heading reads as the nearest of eight points", () => {
  assert.equal(point(0), "N");
  assert.equal(point(62), "NE");
  assert.equal(point(90), "E");
  assert.equal(point(312), "NW");
  assert.equal(point(359), "N");
  assert.equal(point(-45), "NW");
});

test("the strip's date is the boat's local day and 24-hour time", () => {
  // 1 May 2026 12:01 UTC is 8:01 EDT in Annapolis, and 11:01 in the sea zone at 15 W (UTC-1).
  const may = Date.parse("2026-05-01T12:01:00Z");
  assert.equal(shortLocal(may, 38.98, -76.48), "1 May 08:01");
  assert.equal(shortLocal(may, 40, -15), "1 May 11:01");
  // Just after midnight UTC, it's still yesterday off Virginia.
  assert.equal(shortLocal(Date.parse("2020-04-03T02:30:00Z"), 36.6, -74.9), "2 Apr 21:30");
});
