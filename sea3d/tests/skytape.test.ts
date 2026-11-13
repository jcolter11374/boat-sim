// The compass strip along the top (src/replay/skytape.ts), decision L4.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tapeItems } from "../src/replay/skytape.ts";

test("looking east, E sits in the middle and N is off the strip", () => {
  const items = tapeItems(90, 420, []);
  const e = items.find((i) => i.text === "E")!;
  assert.equal(e.x, 210);
  assert.equal(e.cls, "lbl pt");
  assert.equal(items.find((i) => i.text === "N"), undefined);
  assert.ok(items.find((i) => i.text === "NE")!.x < 210 && items.find((i) => i.text === "SE")!.x > 210);
});

test("the strip wraps through north, and north is marked as north", () => {
  const items = tapeItems(350, 420, []);
  const n = items.find((i) => i.text === "N")!;
  assert.equal(n.cls, "lbl pt n");
  assert.ok(Math.abs(n.x - (210 + 10 * (420 / 150))) < 1e-9);
  assert.ok(items.some((i) => i.text === "NW") && items.some((i) => i.text === "NE"));
});

test("labels are drawn only where they fit whole", () => {
  for (const view of [0, 37, 123, 359]) for (const i of tapeItems(view, 420, [])) if (i.cls.startsWith("lbl")) assert.ok(i.x > 14 && i.x < 380);
});

test("marks out of view are left off, and two that would touch take separate rows", () => {
  const items = tapeItems(90, 420, [[112, "▲ bow", "#ff8a2a"], [115, "☀ sun", "#ffd166"], [270, "☾ moon", "#cfe0ff"]]);
  const mk = items.filter((i) => i.cls.startsWith("mk"));
  assert.deepEqual(mk.map((m) => m.text), ["▲ bow", "☀ sun"]);
  assert.deepEqual(mk.map((m) => m.cls), ["mk", "mk up"]);
  assert.equal(mk[0].colour, "#ff8a2a");
});

test("each of the eight compass points sits at its own bearing, whichever way the camera looks", () => {
  const points: [string, number][] = [["N", 0], ["NE", 45], ["E", 90], ["SE", 135], ["S", 180], ["SW", 225], ["W", 270], ["NW", 315]];
  const W = 420;
  for (let view = 0; view < 360; view += 7) {
    const items = tapeItems(view, W, []);
    for (const [name, bearing] of points) {
      const rel = ((bearing - view + 540) % 360) - 180;
      const x = W / 2 + rel * (W / 150);
      const got = items.filter((i) => i.text === name);
      if (Math.abs(rel) <= 75 && x > 14 && x < W - 40) {
        assert.equal(got.length, 1, `${name} once, looking ${view}`);
        assert.ok(Math.abs(got[0].x - x) < 1e-9, `${name} at ${bearing}, looking ${view}`);
        // The tick under it is the same bearing's.
        assert.ok(items.some((i) => i.cls === "tick big" && Math.abs(i.x - x) < 1e-9));
      } else assert.equal(got.length, 0, `${name} not drawn, looking ${view}`);
    }
    // Numbers sit at their own bearings too, and never where a point is.
    for (const i of items) if (i.cls === "lbl") assert.ok(Number(i.text) % 45 !== 0 && Math.abs(i.x - (W / 2 + ((((Number(i.text) - view + 540) % 360) - 180) * W) / 150)) < 1e-9);
  }
});

test("a compass point's class is not one the sailing screen uses for something else", () => {
  // "card" is the Set sail card's class on the sailing screen: it made the letters 560 px wide boxes, drawn in the wrong place.
  for (const i of tapeItems(90, 420, [])) assert.doesNotMatch(i.cls, /\bcard\b/);
});

test("a mark the centre line would cut sits just beside it, on its own side", () => {
  const sun = (b: number) => tapeItems(90, 420, [[b, "☀ sun", "#ffd166"]]).find((i) => i.cls.startsWith("mk"))!;
  const half = "☀ sun".length * 3.4 + 6;
  assert.equal(sun(91).x, 210 + half);
  assert.equal(sun(89).x, 210 - half);
  assert.equal(sun(120).x, 210 + 30 * 2.8); // clear of the line: at its own bearing
});
