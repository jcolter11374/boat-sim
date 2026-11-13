// The title's shore (titleShore.ts): the skyline file and the strip made from it, checked without graphics. Hana, 13 Nov 2026.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as THREE from "three";
import { HERO_SEA, HERO_SUN } from "../src/titleHero";
import { CROWN, SHORE, SHORE_EYE, SHORE_REACH, SHORE_TALLER, readSkyline, shoreClear, shoreStrip } from "../src/titleShore";

const light = { sunDir: new THREE.Vector3(Math.sin((255 * Math.PI) / 180), 0.09, -Math.cos((255 * Math.PI) / 180)).normalize(), sun: new THREE.Color(1, 0.7, 0.4), haze: new THREE.Color(0.8, 0.6, 0.5) };
/** A made-up skyline: n bearings, land where `at` says (distance m, height m). */
function made(n: number, at: (deg: number) => [number, number] | null): Uint16Array {
  const d = new Uint16Array(2 * n);
  for (let i = 0; i < n; i++) {
    const v = at((i * 360) / n);
    if (v) d.set([v[0], Math.round(v[1] * 10)], 2 * i);
  }
  return d;
}
const bearingOf = (p: Float32Array, i: number) => ((Math.atan2(p[3 * i], -p[3 * i + 2]) * 180) / Math.PI + 360) % 360;

test("the skyline file: ours is read; a web page, a stub or nonsense is refused", () => {
  const ours = readSkyline(new Uint8Array(readFileSync("public/title-skyline.bin")).buffer);
  assert.ok(ours && ours.length === 2 * 7200);
  assert.equal(readSkyline(new TextEncoder().encode("<!doctype html><html></html>").buffer), null, "a page");
  assert.equal(readSkyline(new ArrayBuffer(0)), null);
  assert.equal(readSkyline(new ArrayBuffer(1441)), null, "odd length");
  assert.equal(readSkyline(new Uint16Array(1440).fill(65535).buffer), null, "impossible heights");
  assert.ok(readSkyline(new Uint16Array(1440).buffer), "all open sea is fine");
  assert.ok(new Uint8Array(readFileSync("public/title-skyline.bin")).length <= 40000, "small: it is on the first screen");
});

test("the strip: land only where there is land, turned so the June sunset falls on the title's sun", () => {
  // Land from 290 to 310 degrees true (the sunset in its middle), 2 km off, 12 m tall.
  const s = shoreStrip(made(720, (deg) => (deg >= 290 && deg <= 310 ? [2000, 12] : null)), HERO_SUN.az, light);
  const verts = s.position.length / 3;
  assert.equal(verts, 2 * 41);
  assert.equal(s.index.length, 6 * 40, "joined along its length, not round the back");
  for (let i = 0; i < verts; i++) {
    const b = bearingOf(s.position, i);
    assert.ok(b >= HERO_SUN.az - 10.01 && b <= HERO_SUN.az + 10.01, `bearing ${b}`);
    assert.ok(Math.abs(Math.hypot(s.position[3 * i], s.position[3 * i + 2]) - 2000) < 0.01);
    // Feet in the water, tops above it and not absurd.
    if (i % 2 === 0) assert.ok(s.position[3 * i + 1] < 0);
    else assert.ok(s.position[3 * i + 1] > 5 && s.position[3 * i + 1] < 40);
  }
  assert.equal(shoreStrip(new Uint16Array(1440), HERO_SUN.az, light).index.length, 0, "open sea all round: nothing");
});

test("the strip: joined across north; a far shore is brought inside the title's sea at the height it appears", () => {
  const s = shoreStrip(made(360, (deg) => (deg >= 350 || deg <= 10 ? [5200, 30] : null)), SHORE.sunsetAz, light);
  assert.equal(s.position.length / 3, 2 * 22, "north is there twice: the strip's start and its end");
  assert.equal(s.index.length, 6 * 20);
  for (let i = 0; i < s.position.length / 3; i++) assert.ok(Math.hypot(s.position[3 * i], s.position[3 * i + 2]) <= SHORE_REACH + 0.01);
  // 30 m at 5.2 km looks as tall as 15 m at 2.6 km (before the title's own stretch, at most twice).
  const y = s.position[3 * 1 + 1];
  assert.ok(y > 14 && y < 32, `top ${y}`);
  // Land all the way round closes on itself.
  const ring = shoreStrip(made(360, () => [2000, 10]), SHORE.sunsetAz, light);
  assert.equal(ring.index.length, 6 * 360);
});

test("the strip's colours: dark against the sun, lit with the sun behind the lens, paler with distance", () => {
  const lum = (c: Float32Array, i: number) => 0.2126 * c[3 * i] + 0.7152 * c[3 * i + 1] + 0.0722 * c[3 * i + 2];
  const all = shoreStrip(made(360, () => [2000, 10]), HERO_SUN.az, light);
  let towards = -1;
  let away = -1;
  for (let i = 1; i < all.position.length / 3; i += 2) {
    const b = bearingOf(all.position, i);
    if (Math.abs(b - HERO_SUN.az) < 0.6) towards = lum(all.color, i);
    if (Math.abs(b - ((HERO_SUN.az + 180) % 360)) < 0.6) away = lum(all.color, i);
  }
  assert.ok(towards > 0 && away > towards, `towards the sun ${towards}, away ${away}`);
  const hazeL = 0.2126 * light.haze.r + 0.7152 * light.haze.g + 0.0722 * light.haze.b;
  assert.ok(towards < 0.4 * hazeL, "a silhouette: well darker than the haze behind it");
  const near = shoreStrip(made(360, (d) => (d < 2 ? [1800, 10] : null)), HERO_SUN.az, light);
  const far = shoreStrip(made(360, (d) => (d < 2 ? [9000, 10] : null)), HERO_SUN.az, light);
  assert.ok(lum(far.color, 1) > lum(near.color, 1), "farther is hazier");
  assert.ok(shoreClear(2500) > 0.6 && shoreClear(2500) < 0.9, "softened at the shore's distance, not lost");
});

test("our skyline, as the title's two shots see it: a shore 1.5 to 4 km off, the State House in the yacht's view", () => {
  const d = readSkyline(new Uint8Array(readFileSync("public/title-skyline.bin")).buffer)!;
  const n = d.length / 2;
  const at = (trueDeg: number) => ({ dist: d[2 * Math.round((trueDeg * n) / 360)], top: d[2 * Math.round((trueDeg * n) / 360) + 1] / 10 });
  const turn = SHORE.sunsetAz - HERO_SUN.az;
  // A boat with sails is filmed looking 218 degrees by the title's compass, 41 degrees wide; a boat without, 128 (framing.ts).
  let peak = 0;
  for (let b = 198; b <= 238; b += 0.05) {
    const v = at(b + turn);
    assert.ok(v.dist >= 1500 && v.dist <= 4000, `yacht's view, ${b}: ${v.dist} m`);
    assert.ok(v.top > 3 && v.top < 60, `yacht's view, ${b}: ${v.top} m tall`);
    peak = Math.max(peak, v.top);
  }
  assert.ok(peak > 30, `the dome stands above the roofs (${peak} m as drawn at the shore's distance)`);
  let shore = 0;
  for (let b = 108; b <= 148; b += 0.5) {
    const v = at(b + turn);
    if (!v.dist) continue;
    shore++;
    assert.ok(v.dist >= 1500 && v.dist <= 4500, `kayak's view, ${b}: ${v.dist} m`);
  }
  assert.ok(shore > 15 && shore < 70, "the kayak's view has shore on one side and open water on the other");
});

test("the title's sea is a calm evening in the harbour", () => {
  assert.ok(HERO_SEA.hs >= 0.2 && HERO_SEA.hs <= 0.3);
  assert.ok(HERO_SEA.tp < 4);
});

test("the strip carries what the shore's texture needs: the land's own colour, the haze's share, the distance along it and the top", () => {
  const s = shoreStrip(made(720, (deg) => (deg >= 290 && deg <= 310 ? [2000, 12] : null)), HERO_SUN.az, light);
  const verts = s.position.length / 3;
  assert.equal(s.land.length, 3 * verts);
  assert.equal(s.keep.length, verts);
  assert.equal(s.along.length, 3 * verts);
  for (let i = 0; i < verts; i++) {
    assert.ok(s.keep[i] > 0 && s.keep[i] <= 1);
    const lit = s.along[3 * i + 1];
    assert.ok(lit >= 0 && lit <= 1);
    // Both vertices of a bearing know the skyline's top, so the crowns cut the same edge all the way up.
    assert.equal(s.along[3 * i + 2], s.position[3 * (i | 1) + 1]);
  }
  // Metres along the shore: 0.5 degrees at 2 km is about 17.5 m.
  assert.ok(Math.abs(s.along[3 * 2] - s.along[0] - 17.45) < 0.1);
  // The crowns cut a few metres into a 12 m skyline, not the whole of it.
  assert.ok(CROWN * SHORE_TALLER < 0.5 * (12 - SHORE_EYE) * SHORE_TALLER);
});
