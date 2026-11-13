import { test } from "node:test";
import assert from "node:assert/strict";
import { fitView, sameLine, toPx } from "../src/helm/callmap.ts";

test("a call's map fits every line and the boat, with room to spare, the right way up", () => {
  const boat: [number, number] = [36.7, -74.5];
  const lines: [number, number][][] = [
    [[36.9, -74.0], [37.3, -73.2]],
    [[36.4, -74.1], [35.9, -73.6]],
  ];
  const v = fitView(lines, boat, 420, 150);
  for (const [la, lo] of [boat, ...lines.flat()]) {
    const [x, y] = toPx(v, la, lo);
    assert.ok(x > 10 && x < 410 && y > 5 && y < 145, `${la},${lo} -> ${x},${y}`);
  }
  assert.ok(toPx(v, 37.3, -73.2)[1] < toPx(v, 35.9, -73.6)[1], "north is up");
  assert.ok(toPx(v, 36.7, -73.2)[0] > toPx(v, 36.7, -74.5)[0], "east is right");
  assert.ok(Math.abs(v.kx / v.ky - Math.cos((v.lat * Math.PI) / 180)) < 1e-9, "a degree of longitude is narrower");
});

test("a short line still gets a map at least 0.6 degrees tall", () => {
  const v = fitView([[[36.7, -74.5], [36.71, -74.49]]], [36.7, -74.5], 420, 150);
  assert.ok(v.spanLat >= 0.6);
});

test("two options on the same line are told apart (the later one is dashed)", () => {
  const a: [number, number][] = [[36.8, -74.3], [37.0, -74.0]];
  const v = fitView([a], [36.7, -74.5], 420, 120);
  assert.ok(sameLine(v, a, a.map(([la, lo]) => [la + 0.001, lo] as [number, number])));
  assert.ok(!sameLine(v, a, a.map(([la, lo]) => [la + 0.2, lo] as [number, number])));
});
