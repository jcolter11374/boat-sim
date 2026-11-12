import { test } from "node:test";
import assert from "node:assert/strict";
import { CALLS, briefing, callToast, goalChip, goalDays, starsText, type Goal } from "../src/helm/mission.ts";

const START = "2012-10-22T12:00:00Z";
const SANDY: Goal = {
  until: "2012-10-31T12:00:00Z",
  storm: { name: "Sandy", track: [["2012-10-22T12:00:00Z", 13.0, -78.0], ["2012-10-29T12:00:00Z", 38.0, -73.0]], clear_km: 250, well_km: 300 },
  stars3: { east_of: -68, battery_min: 0.2 },
  call_day: 3,
};

test("the goal chip: the day of the challenge and the storm's distance, and how close is too close", () => {
  assert.equal(goalDays(SANDY, START), 9);
  const t0 = Date.parse(START);
  const c = goalChip(SANDY, START, t0 + 3.5 * 86400e3, 36.65, -74.94);
  assert.equal(c.day, "Day 4 of 9");
  assert.match(c.storm, /^storm centre [\d,]+ km$/);
  // Right on top of the centre at the start: danger.
  assert.equal(goalChip(SANDY, START, t0, 13.0, -78.0).state, "danger");
  assert.equal(goalChip(SANDY, START, t0, 15.5, -78.0).state, "near"); // about 280 km north
  assert.equal(goalChip(SANDY, START, t0, 30.0, -78.0).state, "clear");
  assert.equal(goalChip(SANDY, START, t0 + 30 * 86400e3, 30, -70).day, "Day 9 of 9", "never past the last day");
  assert.equal(goalChip(SANDY, START, t0 + 20 * 86400e3, 30, -70).storm, "", "no storm outside its track");
});

test("the briefing is short: two lines and the stars", () => {
  const b = briefing(SANDY, START);
  assert.equal(b.lines.length, 2);
  assert.equal(b.stars.length, 3);
  assert.match(b.stars[2], /east of 68°W .* 20%/);
  for (const l of [...b.lines, ...b.stars]) assert.ok(l.length < 100, l);
});

test("Sandy's call always offers the autopilot's way, and each option says its trade", () => {
  const c = CALLS["sandys-shadow"];
  assert.ok(c.options.some((o) => o.heading === "auto"));
  for (const o of c.options) assert.ok(o.label.length < 90, o.label);
});

test("the toast and the stars say what happened, in plain words", () => {
  assert.equal(callToast("east", -16), "Running east: 16 km behind the autopilot so far.");
  assert.equal(callToast("southeast", 42), "Heading south-east: 42 km ahead of the autopilot so far.");
  assert.equal(callToast("auto", 0.3), "Following the autopilot: level with the autopilot so far.");
  const s = starsText({ stars: 2, closest_km: 512.4, end_lon: -69.2, battery_low: 0.14, sailing: true }, SANDY);
  assert.equal(s.stars, "★★☆");
  assert.equal(s.why[0], "Closest to the centre: 512 km.");
});

test("the debrief says plainly how the autopilot fared", () => {
  const s = starsText({ stars: 3, closest_km: 640, end_lon: -66.6, battery_low: 0.23, sailing: true }, SANDY, { stars: 0, closest_km: 16.2, end_lon: -70.5, battery_low: 0.14, sailing: true });
  assert.equal(s.why.at(-1), "The autopilot kept to its usual route, which crossed Sandy's path: the ghost passed 16 km from the eye.");
});
