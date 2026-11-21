// Checks for the Boatyard's test chart and gauges (src/yard/launchChart.ts, #332).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { CHART_BOX, FINISH, endMark, gaugeDash, project, tally, trackPoints, voyageKey } from "../src/yard/launchChart";
import { trackOf } from "../src/yard/launch";

test("the chart's corners and the finish land where they should", () => {
  assert.deepEqual(project(CHART_BOX.latMax, CHART_BOX.lonMin, 300, 112), [0, 0]);
  assert.deepEqual(project(CHART_BOX.latMin, CHART_BOX.lonMax, 300, 112), [300, 112]);
  const [x, y] = project(FINISH.lat, FINISH.lon, 300, 112);
  assert.ok(x > 250 && x < 300 && y > 40 && y < 80, `finish at ${x}, ${y}`); // far right, mid height: west of Lisbon
});

test("a track keeps its good points only", () => {
  const pts = trackPoints({ lat: [36.6, NaN, 40, 41], lon: [-74.9, -70, -60] }, 300, 112);
  assert.equal(pts.length, 2);
  assert.ok(pts[0][0] < pts[1][0], "sailing east goes right");
  assert.deepEqual(trackPoints(null, 300, 112), []);
  assert.deepEqual(trackPoints({ lat: "x", lon: [] } as never, 300, 112), []);
});

test("every published kayak voyage fits on the chart, start to end", () => {
  const dir = "public/boatyard/k-p25";
  for (const f of readdirSync(dir)) {
    const rp = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
    const pts = trackPoints(trackOf(rp), 300, 112);
    assert.ok(pts.length > 1, f);
    for (const [x, y] of pts) assert.ok(x >= 0 && x <= 300 && y >= 0 && y <= 112, `${f}: ${x}, ${y} is off the chart`);
  }
});

test("a replay without positions has no track", () => {
  assert.equal(trackOf(null), undefined);
  assert.equal(trackOf({ lat: [], lon: [] }), undefined);
  assert.deepEqual(trackOf({ lat: [1], lon: [2] }), { lat: [1], lon: [2] });
});

test("only a finish gets a tick", () => {
  assert.equal(endMark("arrived"), "tick");
  for (const o of ["capsized", "lost_contact", "aground", "timeout"]) assert.equal(endMark(o), "cross");
});

test("the same launch day sailed by both boats is two voyages; the same one twice is one", () => {
  assert.notEqual(voyageKey("yours", "2020-04-01T12:00"), voyageKey("planned", "2020-04-01T12:00"));
  assert.equal(voyageKey("yours", "2020-04-01T12:00"), voyageKey("yours", "2020-04-01T12:00:00Z"));
});

test("the line under the chart counts the player's voyages in plain words", () => {
  assert.match(tally([], 6), /^Your 6 voyages will appear/);
  assert.equal(tally([{ who: "yours", outcome: "arrived" }, { who: "yours", outcome: "capsized" }, { who: "planned", outcome: "arrived" }], 6), "2 of 6 of your voyages drawn: 1 made it, 1 didn't.");
  assert.equal(tally([{ who: "yours", outcome: "arrived" }], 1), "1 of your voyages drawn: 1 made it.");
});

test("the gauge fills in step with the odds and never overfills", () => {
  const [, all] = gaugeDash(1);
  assert.deepEqual(gaugeDash(1), [all, all]);
  assert.equal(gaugeDash(0)[0], 0);
  assert.equal(gaugeDash(null)[0], 0);
  assert.ok(Math.abs(gaugeDash(0.5)[0] - all / 2) < 0.01);
  assert.equal(gaugeDash(7)[0], all);
});
