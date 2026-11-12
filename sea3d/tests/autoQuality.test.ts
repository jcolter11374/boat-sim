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
  const j = new FrameJudge({ skipFrames: 3, skipMs: 100, windowMs: 300, slowMs: 33 });
  // Three huge compile frames, then steady 50 ms frames: slow.
  const out = run(j, [900, 800, 700, ...Array(7).fill(50)]);
  assert.equal(out.filter((x) => x === "slow").length, 1);
  assert.equal(j.median(), 50);
  assert.equal(j.tick(50), "done");
});

test("a few spikes don't make a fast computer slow", () => {
  const j = new FrameJudge({ skipFrames: 0, skipMs: 0, windowMs: 1000, slowMs: 33 });
  const dts = Array.from({ length: 70 }, (_, i) => (i % 10 === 0 ? 120 : 16));
  const out = run(j, dts);
  assert.ok(out.includes("ok"));
  assert.ok(!out.includes("slow"));
});

test("stalls every few frames count, though the median looks fast (a browser waiting on the graphics card)", () => {
  const j = new FrameJudge({ skipFrames: 0, skipMs: 0, windowMs: 3000, slowMs: 33 });
  const dts = Array.from({ length: 200 }, (_, i) => (i % 4 === 3 ? 200 : 16.7));
  const out = run(j, dts);
  assert.equal(j.median(), 16.7);
  assert.ok(out.includes("slow"));
});

test("it waits for the whole window, and ignores bad frame times", () => {
  const j = new FrameJudge({ skipFrames: 0, skipMs: 0, windowMs: 100, slowMs: 33 });
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
