// Points of interest along the track (src/pois.ts, public/pois.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { kmBetween, loadPois, passes, safeUrl, segmentNearest, whereFrom, type Poi, type Track } from "../src/pois";

const P = (id: string, at: [number, number][], radius_km: number): Poi => ({
  id,
  kind: "wreck",
  title: id,
  at,
  radius_km,
  text: "",
  source: "s",
  url: "https://example.org/",
});
// Due east along 37N, one degree (about 89 km) every 10 hours.
const track: Track = { h: [0, 10, 20, 30], lat: [37, 37, 37, 37], lon: [-75, -74, -73, -72] };

test("distances: a degree of latitude is about 111 km; a leg's nearest point", () => {
  assert.ok(Math.abs(kmBetween([37, -75], [38, -75]) - 111.2) < 0.5);
  const n = segmentNearest([37.5, -74.5], [37, -75], [37, -74]);
  assert.ok(Math.abs(n.f - 0.5) < 0.01 && Math.abs(n.km - 55.6) < 0.5);
});

test("a point passed between legs' samples is caught, at the right hour, once", () => {
  const seen = new Set<string>();
  const pois = [P("near", [[37.4, -73.5]], 50), P("far", [[40, -73.5]], 50)];
  const ps = passes(track, 0, 30, pois, seen);
  assert.deepEqual(ps.map((p) => p.poi.id), ["near"]);
  assert.ok(Math.abs(ps[0].h - 15) < 0.2, String(ps[0].h));
  assert.ok(Math.abs(ps[0].km - 44.5) < 1);
  assert.deepEqual(passes(track, 0, 30, pois, seen), []); // shown once
});

test("only the hours asked for count, and a line feature uses its closest point", () => {
  const line = P("stream", [[38, -74.5], [37.2, -72.5], [38, -71]], 30);
  assert.deepEqual(passes(track, 0, 20, [line], new Set()), []); // reached after hour 20
  const ps = passes(track, 20, 30, [line], new Set());
  assert.equal(ps.length, 1);
  assert.deepEqual(ps[0].near, [37.2, -72.5]);
  assert.ok(ps[0].h > 24 && ps[0].h < 26);
});

test("the drop alone, a gap in the track, and earliest first", () => {
  const one: Track = { h: [0], lat: [37], lon: [-75] };
  assert.equal(passes(one, 0, 0, [P("drop", [[37.5, -75]], 60)], new Set()).length, 1);
  const gap: Track = { h: [0, 10, 20], lat: [37, null, 37], lon: [-75, null, -73] };
  assert.equal(passes(gap, 0, 20, [P("mid", [[37, -74]], 20)], new Set()).length, 0);
  const ps = passes(track, 0, 30, [P("b", [[37, -72.2]], 10), P("a", [[37, -74.8]], 10)], new Set());
  assert.deepEqual(ps.map((p) => p.poi.id), ["a", "b"]);
});

test("where the point lies from the boat, in plain words", () => {
  const p = passes(track, 0, 30, [P("n", [[38, -73.5]], 200)], new Set())[0];
  assert.equal(whereFrom({ ...p, boat: [37, -73.5] }), "About 110 km to the north");
  assert.equal(whereFrom({ ...p, boat: [38, -73.52] }), "Right here");
});

test("only https links; a missing or HTML file gives no points", async () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("http://example.org/"), null);
  assert.equal(safeUrl("https://noaa.gov/x"), "https://noaa.gov/x");
  assert.deepEqual(await loadPois("x", async () => new Response("", { status: 404 })), []);
  assert.deepEqual(await loadPois("x", async () => new Response("<html>", { headers: { "content-type": "text/html" } })), []);
});

test("the published list: every point sourced over https, inside the corridor", async () => {
  const body = readFileSync(new URL("../public/pois.json", import.meta.url), "utf8");
  const pois = await loadPois("x", async () => new Response(body, { headers: { "content-type": "application/json" } }));
  assert.ok(pois.length >= 15);
  for (const p of pois) {
    assert.ok(safeUrl(p.url), p.id);
    for (const [la, lo] of p.at) assert.ok(la > 25 && la < 50 && lo > -80 && lo < -5, p.id);
  }
});

test("the first moments of a replay count as at the drop, before its first sample", () => {
  const late: Track = { h: [0.17, 1.17], lat: [37, 37], lon: [-75, -74.99] };
  assert.equal(passes(late, 0, 0.001, [P("drop", [[37.5, -75]], 60)], new Set()).length, 1);
  assert.equal(passes(late, 0.5, 0.6, [P("drop", [[37.5, -75]], 60)], new Set()).length, 1);
});
