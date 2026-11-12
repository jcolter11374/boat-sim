import { test } from "node:test";
import assert from "node:assert/strict";
import { CHASE_FOV, ChaseCam, placeFor, standAt, type Frame } from "../src/helm/chaseCam.ts";

const F: Frame = { w: 1280, h: 720, top: 90, bottom: 640, fovDeg: CHASE_FOV };
/** Where a world point lands on screen for a camera at pos looking at look (px), with the frame's lens. */
function screen(p: number[], pos: number[], look: number[], f: Frame): [number, number] {
  const fwd = [look[0] - pos[0], look[1] - pos[1], look[2] - pos[2]];
  const n = Math.hypot(...fwd);
  const z = fwd.map((v) => v / n);
  const right = [-z[2], 0, z[0]];
  const rn = Math.hypot(...right);
  const r = right.map((v) => v / rn);
  const up = [r[1] * z[2] - r[2] * z[1], r[2] * z[0] - r[0] * z[2], r[0] * z[1] - r[1] * z[0]];
  const v = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]];
  const dz = v[0] * z[0] + v[1] * z[1] + v[2] * z[2];
  const focal = f.h / 2 / Math.tan((f.fovDeg * Math.PI) / 360);
  const x = (v[0] * r[0] + v[1] * r[1] + v[2] * r[2]) / dz;
  const y = (v[0] * up[0] + v[1] * up[1] + v[2] * up[2]) / dz;
  return [f.w / 2 + x * focal, f.h / 2 - y * focal];
}

const bearingOf = (x: number, z: number) => ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360;
const diff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

test("the camera stands behind her and to leeward", () => {
  // Heading north, wind on starboard (from the east): she heels to port, so we stand south-west.
  assert.equal(standAt(0, 1), 222);
  assert.equal(standAt(0, -1), 138);
  const s = placeFor(0, standAt(0, 1), 9.5, 14, F);
  assert.ok(s.pos[0] < 0 && s.pos[2] > 0, "south-west of the boat");
  assert.ok(s.pos[1] > 3 && s.pos[1] < 15, `raised a little: ${s.pos[1]}`);
  const d = Math.hypot(s.pos[0], s.pos[2]);
  assert.ok(d > 25 && d < 90, `${d} m back`);
});

test("at 1280x720, 1920x1080 and 1024x768 the whole boat is in the band above the strip, a third off-centre", () => {
  for (const [w, h] of [[1280, 720], [1920, 1080], [1024, 768]]) {
    const f: Frame = { w, h, top: 90, bottom: h - 80, fovDeg: CHASE_FOV };
    for (const heading of [0, 75, 200]) {
      const s = placeFor(heading, standAt(heading, 1), 9.5, 14, f);
      const hull = screen([0, 0, 0], s.pos, s.look, f);
      const mast = screen([0, 14, 0], s.pos, s.look, f);
      assert.ok(hull[1] < f.bottom && hull[1] > (f.top + f.bottom) / 2, `${w}x${h}: hull at ${hull[1]}`);
      assert.ok(mast[1] > f.top, `${w}x${h}: masthead at ${mast[1]}, band from ${f.top}`);
      assert.ok(hull[0] > w * 0.2 && hull[0] < w * 0.8, `${w}x${h}: hull at x ${hull[0]}`);
      assert.ok(Math.abs(hull[0] - w / 2) > w * 0.08, `${w}x${h}: off-centre`);
    }
  }
});

test("she sits a third off-centre, with the open side of the frame ahead of her bow", () => {
  const s = placeFor(0, 222, 9.5, 14, F);
  const look = bearingOf(s.look[0] - s.pos[0], s.look[2] - s.pos[2]);
  const toBoat = bearingOf(-s.pos[0], -s.pos[2]);
  const off = diff(look, toBoat);
  assert.ok(Math.abs(off) > 5 && Math.abs(off) < 14, `${off} deg off-centre`);
  assert.ok(Math.sign(off) === Math.sign(diff(0, toBoat)), "turned toward where she's heading");
  assert.ok(s.look[1] < s.pos[1], "looking a little down: horizon on the upper third");
});

test("it eases round on a tack and doesn't flicker on a dead run", () => {
  const c = new ChaseCam();
  c.update(1 / 30, 0, 45, 9.5, 14, F, false);
  const first = placeFor(0, 222, 9.5, 14, F).pos;
  let s = c.update(1 / 30, 0, 45, 9.5, 14, F, false)!;
  assert.ok(Math.abs(s.pos[0] - first[0]) < 0.5);
  // Tack: wind now on the port side. One frame later the camera has barely moved...
  s = c.update(1 / 30, 0, -45, 9.5, 14, F, false)!;
  assert.ok(Math.abs(s.pos[0] - first[0]) < 2, "no snap");
  for (let i = 0; i < 30 * 10; i++) s = c.update(1 / 30, 0, -45, 9.5, 14, F, false)!;
  assert.ok(s.pos[0] > 0, "...and after a few seconds it's on the other side");
  // Dead run, the wind angle flickering across 180: the camera holds its side.
  const x = s.pos[0];
  for (let i = 0; i < 60; i++) s = c.update(1 / 30, 0, i % 2 ? 179 : -179, 9.5, 14, F, false)!;
  assert.ok(Math.abs(s.pos[0] - x) < 0.5);
});

test("dragging the view hands the camera to the player until 4 s after letting go", () => {
  const c = new ChaseCam();
  c.drag(true);
  assert.equal(c.update(1, 0, 45, 9.5, 14, F, false), null);
  c.drag(false);
  assert.equal(c.update(2, 0, 45, 9.5, 14, F, false), null);
  assert.ok(c.update(3, 0, 45, 9.5, 14, F, false));
});
