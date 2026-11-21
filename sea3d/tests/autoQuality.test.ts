// The helm's starting quality (src/helm/autoQuality.ts): where it starts, and when it steps down.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameJudge, levelSettings, startLevel } from "../src/helm/autoQuality";

test("?quality= pins it, a player's pick wins next, software graphics start Low, else Medium", () => {
  assert.deepEqual(startLevel("?quality=high", "low", true), { level: "high", source: "url" });
  assert.deepEqual(startLevel("?sail", "high", true), { level: "high", source: "player" });
  assert.deepEqual(startLevel("", "nonsense", true), { level: "low", source: "software" });
  assert.deepEqual(startLevel("", null, false), { level: "medium", source: "auto" });
  assert.deepEqual(startLevel("?quality=ultra", null, false), { level: "medium", source: "auto" });
});

const run = (j: FrameJudge, dts: number[]) => dts.map((d) => j.tick(d));

test("the compile frames don't count; a slow median steps down once", () => {
  const j = new FrameJudge({ skipFrames: 3, skipMs: 100, windowMs: 300, slowMs: 36, pauseMs: 500 });
  // Three huge compile frames, then steady 50 ms frames: slow.
  const out = run(j, [450, 400, 300, ...Array(7).fill(50)]);
  assert.equal(out.filter((x) => x === "slow").length, 1);
  assert.equal(j.median(), 50);
  assert.equal(j.tick(50), "done");
});

test("a few spikes don't make a fast computer slow", () => {
  const j = new FrameJudge({ skipFrames: 0, skipMs: 0, windowMs: 1000, slowMs: 36, pauseMs: 500 });
  const dts = Array.from({ length: 70 }, (_, i) => (i % 10 === 0 ? 120 : 16));
  const out = run(j, dts);
  assert.ok(out.includes("ok"));
  assert.ok(!out.includes("slow"));
});

test("stalls every few frames count, though the median looks fast (a browser waiting on the graphics card)", () => {
  const j = new FrameJudge({ skipFrames: 0, skipMs: 0, windowMs: 3000, slowMs: 36, pauseMs: 500 });
  const dts = Array.from({ length: 200 }, (_, i) => (i % 4 === 3 ? 200 : 16.7));
  const out = run(j, dts);
  assert.equal(j.median(), 16.7);
  assert.ok(out.includes("slow"));
});

test("a short window on a slow computer still drops its one hitch (Kai)", () => {
  const j = new FrameJudge({ skipFrames: 0, skipMs: 0, windowMs: 800, slowMs: 36, pauseMs: 500 });
  const out = run(j, [...Array(14).fill(30), 400, 30]);
  assert.ok(out.includes("ok"), String(j.typical()));
});

test("a hidden tab's long gap is a pause, not a slow frame (Kai)", () => {
  const j = new FrameJudge({ skipFrames: 0, skipMs: 0, windowMs: 3000, slowMs: 36, pauseMs: 500 });
  assert.equal(j.tick(30000), "wait");
  assert.equal(j.frames, 0);
  const out = run(j, Array(10).fill(16.7));
  assert.ok(!out.includes("slow") && !out.includes("ok"), "ten frames are not 3 s");
});

test("three long gaps in a row is a very slow computer, not a pause (Kai)", () => {
  const j = new FrameJudge({ skipFrames: 0, skipMs: 0, windowMs: 3000, slowMs: 36, pauseMs: 500 });
  assert.deepEqual(run(j, [600, 600, 600]), ["wait", "wait", "slow"]);
  const k = new FrameJudge({ skipFrames: 0, skipMs: 0, windowMs: 3000, slowMs: 36, pauseMs: 500 });
  assert.ok(!run(k, [600, 600, 16, 600, 600]).includes("slow"), "not in a row");
});

test("a steady 30 frames a second is fine; 40 a second on a 60 Hz screen too (Kai)", () => {
  const a = new FrameJudge({ skipFrames: 0, skipMs: 0, windowMs: 3000, slowMs: 36, pauseMs: 500 });
  assert.ok(run(a, Array(100).fill(33.3)).includes("ok"));
  const b = new FrameJudge({ skipFrames: 0, skipMs: 0, windowMs: 3000, slowMs: 36, pauseMs: 500 });
  assert.ok(run(b, Array.from({ length: 200 }, (_, i) => (i % 2 ? 33.3 : 16.7))).includes("ok"));
});

test("it waits for the whole window, and ignores bad frame times", () => {
  const j = new FrameJudge({ skipFrames: 0, skipMs: 0, windowMs: 100, slowMs: 36, pauseMs: 500 });
  assert.equal(j.tick(NaN), "wait");
  assert.equal(j.tick(-5), "wait");
  assert.equal(j.tick(40), "wait");
  assert.equal(j.tick(40), "wait");
  assert.equal(j.tick(40), "slow");
});

test("each level's cost", () => {
  assert.deepEqual(levelSettings("high", 2, false), { ratio: 2, bloom: true, sea: "high" });
  assert.deepEqual(levelSettings("medium", 2, false), { ratio: 1, bloom: false, sea: "high" });
  assert.deepEqual(levelSettings("low", 2, false), { ratio: 0.75, bloom: false, sea: "low" });
  assert.deepEqual(levelSettings("low", 1, true).ratio, 0.5);
});

import { SlowWatch } from "../src/helm/autoQuality";
const O = { skipFrames: 0, skipMs: 0, windowMs: 1000, slowMs: 36, pauseMs: 500 };
/** Feed frames dt ms apart from t; returns the frame index of each "step down". */
function feed(w: SlowWatch, dts: number[], on: (i: number) => boolean = () => true): number[] {
  let t = 0;
  const steps: number[] = [];
  dts.forEach((d, i) => {
    t += d;
    if (w.tick(t, on(i))) steps.push(i);
  });
  return steps;
}

test("SlowWatch: fast all along never steps down", () => {
  assert.deepEqual(feed(new SlowWatch(O), Array(600).fill(16.7)), []);
});

test("SlowWatch: slowness that starts later steps down after two slow windows in a row", () => {
  const dts = [...Array(300).fill(16.7), ...Array(60).fill(50)];
  const steps = feed(new SlowWatch(O), dts);
  assert.equal(steps.length, 1, String(steps));
  // The window running when it got slow is mostly fast; then two slow windows of 1 s (20 frames each).
  assert.ok(steps[0] > 300 && steps[0] <= 300 + 60, String(steps));
});

test("SlowWatch: one heavy moment between fast stretches doesn't step down", () => {
  const dts = [...Array(120).fill(16.7), ...Array(25).fill(60), ...Array(200).fill(16.7), ...Array(25).fill(60), ...Array(200).fill(16.7)];
  assert.deepEqual(feed(new SlowWatch(O), dts), []);
});

test("SlowWatch: skipped frames (hidden, busy, building) neither count nor end the window", () => {
  const dts = Array(400).fill(50);
  // Every other frame skipped: what's timed is still 50 ms frames, minus the gaps over the skipped ones.
  assert.equal(feed(new SlowWatch(O), dts, (i) => i % 2 === 0).length, 0, "a skipped frame breaks the pair, so nothing is timed");
  assert.equal(feed(new SlowWatch(O), dts, (i) => i % 10 !== 0).length > 0, true);
  assert.deepEqual(feed(new SlowWatch(O), dts, () => false), []);
});

test("SlowWatch: after a step it starts over, its skip included", () => {
  const w = new SlowWatch({ ...O, skipFrames: 10, skipMs: 500 });
  const steps = feed(w, Array(400).fill(50));
  assert.ok(steps.length >= 2);
  assert.ok(steps[1] - steps[0] >= 40 + 10, String(steps));
});
