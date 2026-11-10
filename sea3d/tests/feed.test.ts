// Checks for the live tracker feed -> replay conversion (replay/feed.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { commsAt, positionAt, valueAt, type Course } from "../src/replay/data";
import { advanceNow, feedToReplay, reportAt, type FeedGhost, type FeedVoyage } from "../src/replay/feed";

const course: Course = { drop: null, west_line: [], east_line: [], target: [0, 0], target_radius_m: 0 };
const T = (h: number) => new Date(Date.UTC(2020, 4, 1, 12) + h * 3600e3).toISOString().replace(".000", "");
const ir = (h: number, lat: number, lon: number, soc: number, flags: Record<string, boolean> = {}) => ({ t: T(h), src: "iridium", lat, lon, soc, hdg: 90, mode: "normal", flags });
const bc = (h: number, lat: number, lon: number) => ({ t: T(h), src: "beacon", lat, lon });

function voyage(fixes: FeedVoyage["fixes"], ageH = 2, replay = true): FeedVoyage {
  return {
    schema: 1,
    updated: T(fixes.length ? Math.max(...fixes.map((f) => (Date.parse(f.t) - Date.parse(T(0))) / 3600e3)) + ageH : 0),
    voyage: { name: "v4 kayak", start: { t: T(0), lat: 36.65, lon: -74.94 }, finish: { lat: 39.5, lon: -13.5, radius_km: 25 }, status: "at_sea", ...(replay ? { replay: { weather: "synthetic" } } : {}) },
    fixes,
    routes: [{ sent: T(24), version: 1, kind: "route", waypoints: [[39.5, -13.5]] }],
    summary: { days_at_sea: 0, km_sailed: 0, km_to_finish: 0, last_fix_age_h: ageH, silent_days_total: 0 },
  };
}

test("reports become a track that passes exactly through each report, then waits at the last one until now", () => {
  const v = voyage([ir(0, 36.65, -74.94, 0.9), bc(6, 36.7, -74.8), ir(24, 37, -74, 0.8), bc(30, 37.1, -73.8)], 3);
  const tr = feedToReplay(v, null, course);
  assert.equal(tr.lastFixHour, 30);
  assert.equal(tr.nowHour, 33);
  assert.deepEqual(positionAt(tr.rep, 24), [37, -74]);
  assert.deepEqual(positionAt(tr.rep, 33), [37.1, -73.8]); // no guessing past the last report
  assert.equal(tr.simulated, true);
  assert.equal(feedToReplay(voyage([ir(0, 36.65, -74.94, 0.9)], 1, false), null, course).simulated, false);
  // The battery only comes from main-box reports.
  assert.equal(reportAt(tr, 29)?.soc, 0.8);
  assert.equal(valueAt(tr.rep, tr.rep.soc, 24), 0.8);
});

test("reports stopping with the beacon still heard: comms go to beacon only, with an event", () => {
  const fixes = [ir(0, 36.65, -74.94, 0.9), ir(24, 37, -74, 0.8)];
  for (let h = 30; h <= 120; h += 6) fixes.push(bc(h, 37 + h / 1000, -74 + h / 100));
  const tr = feedToReplay(voyage(fixes), null, course);
  assert.equal(commsAt(tr.rep, 24), "ok");
  assert.equal(commsAt(tr.rep, 90), "beacon");
  assert.ok(tr.rep.events.some((e) => e.kind === "reports_stopped" && Math.abs(e.h - 60) < 1e-6));
  assert.ok(tr.rep.events.some((e) => e.kind === "mission_updated"));
});

test("flags in the reports become events once, when they come on", () => {
  const tr = feedToReplay(voyage([ir(0, 36.65, -74.94, 0.9), ir(24, 37, -74, 0.8, { one_thruster: true }), ir(48, 37.2, -73, 0.7, { one_thruster: true })]), null, course);
  assert.deepEqual(tr.rep.events.filter((e) => e.kind === "one_motor").map((e) => e.h), [24]);
});

test("the forecast follows the ghost's middle path after now", () => {
  const v = voyage([ir(0, 36.65, -74.94, 0.9), ir(24, 37, -74, 0.8)], 2);
  const ghost: FeedGhost = {
    schema: 1, from_fix: T(24), made: T(26), runs: 10,
    median: [[T(48), 37.5, -72], [T(72), 38, -70]],
    spread: [[T(48), 37.5, -72, 30], [T(72), 38, -70, 60]],
    eta: { p10: "2020-06-20", p50: "2020-06-30", p90: "2020-07-10" }, p_finish: 0.9,
  };
  const tr = feedToReplay(v, ghost, course);
  assert.equal(tr.nowHour, 26);
  assert.deepEqual(positionAt(tr.rep, 72), [38, -70]);
  assert.equal(commsAt(tr.rep, 60), "silent"); // drawn as a dashed forecast, not as reports
  assert.ok(tr.ghost);
});

test("now moves on with the clock: the boat waits at its last report and the forecast isn't reached early", () => {
  const v = voyage([ir(0, 36.65, -74.94, 0.9), ir(24, 37, -74, 0.8)], 2);
  const ghost: FeedGhost = {
    schema: 1, from_fix: T(24), made: T(26), runs: 10,
    median: [[T(48), 37.5, -72], [T(72), 38, -70]],
    spread: [[T(48), 37.5, -72, 30], [T(72), 38, -70, 60]],
    eta: { p10: "2020-06-20", p50: "2020-06-30", p90: "2020-07-10" }, p_finish: 0.9,
  };
  const tr = feedToReplay(v, ghost, course);
  advanceNow(tr, 26.5); // the page has been open half an hour
  assert.equal(tr.nowHour, 26.5);
  assert.deepEqual(positionAt(tr.rep, 26.5), [37, -74]); // still where it last reported
  advanceNow(tr, 26.2); // never back
  assert.equal(tr.nowHour, 26.5);
  advanceNow(tr, 60); // long after: stops short of the forecast's next point
  assert.ok(tr.nowHour < 48 && tr.nowHour > 47.99);
  // A feed made right at a report still has its own "now" row to move.
  const fresh = feedToReplay(voyage([ir(0, 36.65, -74.94, 0.9), ir(24, 37, -74, 0.8)], 0), null, course);
  advanceNow(fresh, 25);
  assert.equal(fresh.nowHour, 25);
  assert.deepEqual(positionAt(fresh.rep, 25), [37, -74]);
});
