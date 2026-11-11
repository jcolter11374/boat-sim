import { test } from "node:test";
import assert from "node:assert/strict";
import { HEADING, HeldAxis, POWER, keyAxis, latestOnly } from "../src/helm/keys.ts";

function rig(start: number, o = HEADING) {
  const shown: number[] = [];
  const sent: number[] = [];
  const a = new HeldAxis({ value: () => start, preview: (v) => shown.push(v), commit: (v) => sent.push(v) }, o);
  return { a, shown, sent };
}

/** Frames every 16 ms from t0 to t1 (inclusive of t1). */
function frames(a: HeldAxis, t0: number, t1: number): void {
  for (let t = t0 + 16; t < t1; t += 16) a.tick(t);
  a.tick(t1);
}

test("a tap turns one 5-degree step, snapped to the grid, and sends it once", () => {
  const { a, sent } = rig(93);
  a.down(1, false, 0);
  frames(a, 0, 100);
  a.up(1, 100);
  assert.deepEqual(sent, [95]);
  const b = rig(95);
  b.a.down(-1, false, 0);
  b.a.up(-1, 50);
  assert.deepEqual(b.sent, [90]);
});

test("Shift is a 1-degree step", () => {
  const { a, sent } = rig(93);
  a.down(1, true, 0);
  a.up(1, 50);
  assert.deepEqual(sent, [94]);
});

test("heading wraps through north", () => {
  const { a, sent } = rig(358);
  a.down(1, false, 0);
  a.up(1, 10);
  assert.deepEqual(sent, [0]);
  const b = rig(2);
  b.a.down(-1, false, 0);
  b.a.up(-1, 10);
  assert.deepEqual(b.sent, [0]);
  const c = rig(0);
  c.a.down(-1, false, 0);
  c.a.up(-1, 10);
  assert.deepEqual(c.sent, [355]);
});

test("holding keeps turning, faster the longer it's held, and sends only a few orders", () => {
  const { a, shown, sent } = rig(90);
  a.down(1, false, 0);
  frames(a, 0, 1000);
  const at1s = a.current;
  frames(a, 1000, 3000);
  a.up(1, 3000);
  // First second: 5 deg tap, then ~0.72 s ramping up from 15 deg/s: about 20 deg in all.
  assert.ok(at1s > 103 && at1s < 118, `after 1 s: ${at1s}`);
  // Up to 3 s, ramping to 45 deg/s: about a right angle in all, so a U-turn is a 4-5 s hold.
  const turned = (sent.at(-1)! - 90 + 360) % 360;
  assert.ok(turned > 80 && turned < 120, `after 3 s: ${turned}`);
  assert.ok(sent.length <= 3000 / HEADING.commitMs + 2, `${sent.length} orders`);
  assert.ok(shown.length > 100, "the dial follows every frame");
  for (const v of sent) assert.equal(v, Math.round(v), "whole degrees only");
});

test("a held fine key creeps slowly", () => {
  const { a, sent } = rig(90);
  a.down(1, true, 0);
  frames(a, 0, 2280);
  a.up(1, 2280);
  // 1 deg tap + 2 s at 4 deg/s
  assert.equal(sent.at(-1), 99);
});

test("power is clamped, and stops at full", () => {
  const { a, sent } = rig(0.95, POWER);
  a.down(1, false, 0);
  frames(a, 0, 2000);
  a.up(1, 2000);
  assert.equal(sent.at(-1), 1);
  assert.ok(sent.every((v) => v <= 1));
  assert.ok(sent.every((v) => String(v).length <= 4), `clean hundredths: ${sent.join()}`);
  const b = rig(0, POWER);
  b.a.down(-1, false, 0);
  b.a.up(-1, 10);
  assert.deepEqual(b.sent, [0], "already at zero: nothing lower");
});

test("reversing mid-hold carries on from where the dial is", () => {
  const { a, sent } = rig(90);
  a.down(1, false, 0);
  frames(a, 0, 1000);
  const mid = Math.round(a.current);
  a.down(-1, false, 1000); // other arrow pressed while the first is still down
  a.up(1, 1000); // ignored: not the active key
  a.up(-1, 1050);
  assert.equal(sent.at(-1), Math.round(mid / 5) * 5 - (mid % 5 === 0 ? 5 : 0));
});

test("losing focus lets go and sends where it stopped", () => {
  const { a, sent } = rig(90);
  a.down(1, false, 0);
  frames(a, 0, 600);
  a.release(600);
  const n = sent.length;
  assert.equal(a.held, false);
  frames(a, 600, 1600);
  assert.equal(sent.length, n, "nothing moves after letting go");
});

test("latestOnly sends one at a time and keeps only the newest", async () => {
  const got: number[] = [];
  let open: (() => void) | null = null;
  const send = latestOnly<number>(
    (v) =>
      new Promise<void>((r) => {
        got.push(v);
        open = r;
      }),
  );
  send(1);
  send(2);
  send(3);
  assert.deepEqual(got, [1]);
  open!();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(got, [1, 3]);
  open!();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(got, [1, 3]);
});

test("arrow keys map to the two axes", () => {
  assert.deepEqual(keyAxis("ArrowLeft"), { axis: "heading", dir: -1 });
  assert.deepEqual(keyAxis("ArrowUp"), { axis: "power", dir: 1 });
  assert.equal(keyAxis("KeyW"), null);
});
