import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ARRIVAL, ARRIVAL_AT, ARRIVAL_S, CABO_DA_ROCA, arrivalShot } from "../src/helm/arrivalShot";
import { bearingTo } from "../src/land/landmarks";
import type { FramingHost } from "../src/framing";

const host = (headingDeg: number, aspect = 16 / 9, len = 3.05, tall = 0): FramingHost => ({
  camera: new THREE.PerspectiveCamera(50, aspect, 0.1, 1e6),
  controls: { target: new THREE.Vector3(0, 0.3, 0) },
  water: () => 0,
  // The boat's heading as scene yaw: bow along (cos yaw, 0, -sin yaw); heading 90 (east) is yaw 0.
  yaw: () => THREE.MathUtils.degToRad(90 - headingDeg),
  length: () => len,
  height: () => tall,
});
const cape = bearingTo(CABO_DA_ROCA, ARRIVAL_AT[0], ARRIVAL_AT[1]);

test("the finish shot: the boat on a third, the cape in the frame on the open side, whatever her heading", () => {
  for (const heading of [0, 45, 90, 135, 180, 225, 270, 315]) {
    for (const aspect of [16 / 9, 4 / 3, 9 / 16]) {
      const s = arrivalShot(host(heading, aspect), cape, 0);
      assert.ok(Math.abs(s.cape) < 0.85, `cape in frame (${heading}, ${aspect.toFixed(2)}): ${s.cape}`);
      assert.ok(Math.abs(s.boat) < 0.75, `boat in frame (${heading}, ${aspect.toFixed(2)}): ${s.boat}`);
      assert.ok(Math.abs(s.cape - s.boat) > 0.25, `the cape beside her, not behind her (${heading}, ${aspect.toFixed(2)}): ${s.cape} ${s.boat}`);
    }
  }
});

test("the finish shot is low, level and long-lensed, and looks towards the cape", () => {
  const s = arrivalShot(host(70), cape, 0);
  assert.equal(s.fov, ARRIVAL.fov);
  assert.ok(s.pos.y > 0.5 && s.pos.y < 2.5, `a chase boat's height: ${s.pos.y}`);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(s.quat);
  const looks = (THREE.MathUtils.radToDeg(Math.atan2(fwd.x, -fwd.z)) + 360) % 360;
  const off = Math.abs(((looks - cape + 540) % 360) - 180);
  assert.ok(off < 20, `looks ${looks.toFixed(0)}, the cape bears ${cape.toFixed(0)}`);
  assert.ok(Math.abs(fwd.y) < 0.1, "nearly level: the horizon and the coast in frame");
});

test("a slow push in: closer by the end, never a jump, and it stops when the scene's time is up", () => {
  const h = host(cape + 90); // side-on to the lens (end-on she is already as close as her bow allows)
  const d = (t: number) => arrivalShot(h, cape, t).pos.length();
  assert.ok(d(ARRIVAL_S) < d(0) * 0.96, `${d(0)} to ${d(ARRIVAL_S)}`);
  for (let t = 0; t < ARRIVAL_S; t += 0.5) assert.ok(Math.abs(d(t + 0.5) - d(t)) < 0.02 * d(0), `step at ${t}`);
  assert.equal(d(ARRIVAL_S + 30), d(ARRIVAL_S));
});

test("on an upright phone the boat is about half the width, in the lower middle of the frame", async () => {
  const { onScreen } = await import("../src/helm/arrivalShot");
  const W = 390;
  const H = 844;
  const wide = (len: number, tall: number, heading: number, W = 390, H = 844) => {
    const h = host(heading, W / H, len, tall);
    const s = arrivalShot(h, cape, 0);
    const yaw = h.yaw();
    const end = (k: number) => onScreen(s, W, H, new THREE.Vector3(Math.cos(yaw) * k * len, 0.3, -Math.sin(yaw) * k * len));
    const a = end(-0.5);
    const b = end(0.5);
    return { span: Math.abs(a.x - b.x) / W, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), y: (a.y + b.y) / 2 };
  };
  // Side-on to the lens: the kayak about half the frame's width, both ends inside it.
  const k = wide(3.05, 0, cape + 90);
  assert.ok(k.span > 0.38 && k.span < 0.6, `kayak ${k.span.toFixed(2)} of the width`);
  assert.ok(k.lo > 0 && k.hi < W, `both ends in the frame: ${k.lo.toFixed(0)} ${k.hi.toFixed(0)}`);
  // She sits in the lower middle of the frame, not on the top half with empty sea below.
  assert.ok(k.y > 0.6 * H && k.y < 0.8 * H, `kayak at ${(k.y / H).toFixed(2)} of the height`);
  // A wide screen keeps the framing it had: a fifth of the width.
  const d = wide(3.05, 0, cape + 90, 1280, 720);
  assert.ok(d.span > 0.15 && d.span < 0.25, `on a wide screen ${d.span.toFixed(2)} of the width`);
});

test("a yacht's mast fits: the camera stands back for a tall boat", () => {
  const kayak = arrivalShot(host(70), cape, 0).pos.length();
  const yacht = arrivalShot(host(70, 16 / 9, 9.6, 14), cape, 0).pos.length();
  assert.ok(yacht > 2 * kayak, `${kayak} ${yacht}`);
});

test("the finish banner goes in the empty sky and never covers the boat or the cape", async () => {
  const { bannerSpot } = await import("../src/helm/arrivalShot");
  const frame = { w: 1280, h: 720, top: 40 };
  const banner = { w: 430, h: 150 };
  // A kayak low on the left, the cape low on the right: the sky is free, so the top, away from the boat.
  const kayak = { x0: 250, y0: 440, x1: 480, y1: 520 };
  const cape = { x0: 420, y0: 380, x1: 1280, y1: 470 };
  const a = bannerSpot(frame, banner, [kayak, cape], -1);
  assert.equal(a.where, "top, away from the boat");
  assert.equal(a.covers, 0);
  assert.ok(a.x + banner.w <= 1280 && a.y >= 40);
  // A yacht's mast up the left of the frame: still top right, clear of her rig.
  const yacht = { x0: 300, y0: 30, x1: 640, y1: 520 };
  const b = bannerSpot(frame, banner, [yacht, cape], -1);
  assert.equal(b.where, "top, away from the boat");
  assert.equal(b.covers, 0);
  // The cape standing high on the right (a boat close in): the middle or her side of the sky, never the cape.
  const high = { x0: 700, y0: 60, x1: 1280, y1: 470 };
  const c = bannerSpot(frame, banner, [kayak, high], -1);
  assert.equal(c.covers, 0);
  assert.notEqual(c.where, "top, away from the boat");
  // A phone held upright: a tall rig and the cape leave no sky, so the banner goes low over the sea, below the boat.
  const phone = { w: 390, h: 760, top: 40 };
  const pb = { w: 366, h: 190 };
  const d = bannerSpot(phone, pb, [{ x0: 40, y0: 60, x1: 250, y1: 500 }, { x0: 60, y0: 380, x1: 390, y1: 470 }], -1);
  assert.ok(d.where.startsWith("bottom"), d.where);
  assert.equal(d.covers, 0);
  // A kayak on a phone: the tall sky is free.
  const e = bannerSpot(phone, pb, [{ x0: 40, y0: 470, x1: 250, y1: 520 }, { x0: 60, y0: 400, x1: 390, y1: 470 }], -1);
  assert.ok(e.where.startsWith("top"), e.where);
  assert.equal(e.covers, 0);
  // Nowhere clear: the spot that covers least, and it says how much.
  const f = bannerSpot({ w: 400, h: 300, top: 0 }, { w: 380, h: 200 }, [{ x0: 0, y0: 0, x1: 400, y1: 300 }], -1);
  assert.ok(f.covers > 0);
});
