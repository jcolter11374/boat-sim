// The Ultra fallback: drops to High only after two slow 2-second windows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FpsGuard } from "../src/ultra";

function run(fps: number, seconds: number, g = new FpsGuard()): number | null {
  for (let i = 0; i <= fps * seconds; i++) if (g.tick(i / fps, true)) return i / fps;
  return null;
}

test("fast enough: stays on Ultra", () => {
  assert.equal(run(60, 30), null);
  assert.equal(run(30, 30), null);
});

test("too slow: drops after the settle time and two slow windows", () => {
  const t = run(15, 30);
  assert.ok(t !== null && t >= 6 && t < 7, `dropped at ${t}`);
});

test("off: never asks to drop", () => {
  const g = new FpsGuard();
  for (let i = 0; i < 300; i++) assert.equal(g.tick(i / 5, false), false);
});
