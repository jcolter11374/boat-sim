import { test } from "node:test";
import assert from "node:assert/strict";
import { firstBreak, knockdowns, leadChanges, raceHighlights, roughest, watchHighlights } from "../src/helm/highlights.ts";
import type { Replay, ReplayEvent } from "../src/replay/data.ts";

const TARGET: [number, number] = [39.5, -13.5];
/** A boat sailing due east along 39.5N from 70W at `speed` degrees of longitude a day, for `days`. */
function rep(speed: (day: number) => number, days: number, events: ReplayEvent[] = [], hs = 2): Replay {
  const h: number[] = [];
  const lon: number[] = [];
  let x = -70;
  for (let t = 0; t <= days * 24; t += 1) {
    h.push(t);
    lon.push(x);
    x += speed(t / 24) / 24;
  }
  const col = (v: number) => h.map(() => v);
  return {
    schema: 1, boat: "v4 kayak", start: "2020-04-15T12:00", end: null, seed: 1, outcome: "arrived", days, t_start_line: null, t_finish_line: null,
    course: { drop: [39.5, -70], west_line: [], east_line: [], target: TARGET, target_radius_m: 25000 },
    h, lat: col(39.5), lon, heading: col(90), stw: col(1), soc: col(1), wind_u: col(0), wind_v: col(0), hs: h.map((t) => (t === 240 ? 5.7 : hs)),
    tp: col(8), wave_dir: col(0), current_u: col(0), current_v: col(0), ghi: col(0), events,
  } as unknown as Replay;
}

test("knockdowns count each one the log reports", () => {
  const r = rep(() => 1, 10, [
    { h: 79, kind: "capsize", detail: "1 knockdown(s), Hs 4.5 m" },
    { h: 91, kind: "capsize", detail: "3 knockdown(s), Hs 5.7 m" },
  ]);
  assert.equal(knockdowns(r), 4);
});

test("the first breakdown names each part once, in plain words, with its day", () => {
  const r = rep(() => 1, 10, [
    { h: 94, kind: "part_failed", detail: "electronics_main (common-cause electronics failure)" },
    { h: 94, kind: "part_failed", detail: "electronics_safe (common-cause electronics failure)" },
    { h: 120, kind: "part_failed", detail: "rudder (knockdown)" },
  ]);
  assert.deepEqual(firstBreak(r), { day: 4, parts: ["Main computer", "Backup computer"] });
});

test("a watched voyage: what broke, the knockdowns and the roughest sea, at most three lines", () => {
  const r = rep(() => 1, 20, [
    { h: 94, kind: "part_failed", detail: "electronics_main (x)" },
    { h: 94, kind: "part_failed", detail: "electronics_safe (x)" },
    { h: 79, kind: "capsize", detail: "2 knockdown(s), Hs 4.5 m" },
  ]);
  assert.deepEqual(watchHighlights(r), [
    "Day 4: the main computer and the backup computer broke.",
    "Waves knocked her flat 2 times.",
    "The roughest sea: waves of 5.7 m on day 11.",
  ]);
  assert.deepEqual(roughest(r), { hs: 5.7, day: 11 });
});

test("a sailing boat's hard leans aren't counted as knockdowns", () => {
  const r = { ...rep(() => 1, 5, [{ h: 10, kind: "capsize", detail: "1 knockdown(s), Hs 1 m" }], 0.5), boat: "Randolph Rev C" } as Replay;
  assert.equal(knockdowns(r), 0);
  assert.deepEqual(watchHighlights(r), ["Nothing broke all the way."]);
});

test("a quiet voyage says nothing broke", () => {
  assert.equal(watchHighlights(rep(() => 1, 5, [], 0.5))[0], "Nothing broke, and no wave knocked her flat.");
});

test("the lead: a day's hold counts, an hour's doesn't", () => {
  // A is faster for 10 days, then B for the rest: B takes the lead for good.
  const a = rep((d) => (d < 10 ? 1.2 : 0.6), 40);
  const b = rep((d) => (d < 10 ? 1.0 : 1.2), 40);
  const l = leadChanges(a, b, TARGET)!;
  assert.equal(l.who, 1);
  assert.equal(l.swaps, 1);
  assert.ok(l.since > 10 && l.since < 20, String(l.since));
  // Never behind: led from the first day.
  assert.deepEqual(leadChanges(rep(() => 1.2, 20), rep(() => 1, 20), TARGET), { swaps: 0, who: 0, since: 2 });
  assert.deepEqual(raceHighlights(rep(() => 1.2, 20), rep(() => 1, 20), ["Our kayak", "Randolph Rev C5"], TARGET)[0], "Our kayak led all the way.");
});

test("a race: the lead, then what broke, in the boats' names, then the roughest sea", () => {
  const a = rep((d) => (d < 10 ? 1.2 : 0.6), 40, [{ h: 79, kind: "capsize", detail: "1 knockdown(s), Hs 4.5 m" }]);
  const b = rep((d) => (d < 10 ? 1.0 : 1.2), 40, [{ h: 200, kind: "part_failed", detail: "thruster_port (wear)" }]);
  const lines = raceHighlights(a, b, ["Our kayak", "Randolph Rev C5"], TARGET);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^The lead changed hands once; Randolph Rev C5 took it for good on day \d+\.$/);
  assert.equal(lines[1], "Randolph Rev C5, day 9: the left motor broke.");
  assert.equal(lines[2], "The roughest sea: waves of 5.7 m on day 11.");
});
