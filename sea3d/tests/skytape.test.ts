// The compass strip along the top (src/replay/skytape.ts), decision L4.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tapeItems } from "../src/replay/skytape.ts";

test("looking east, E sits in the middle and N is off the strip", () => {
  const items = tapeItems(90, 420, []);
  const e = items.find((i) => i.text === "E")!;
  assert.equal(e.x, 210);
  assert.equal(e.cls, "lbl card");
  assert.equal(items.find((i) => i.text === "N"), undefined);
  assert.ok(items.find((i) => i.text === "NE")!.x < 210 && items.find((i) => i.text === "SE")!.x > 210);
});

test("the strip wraps through north, and north is marked as north", () => {
  const items = tapeItems(350, 420, []);
  const n = items.find((i) => i.text === "N")!;
  assert.equal(n.cls, "lbl card n");
  assert.ok(Math.abs(n.x - (210 + 10 * (420 / 150))) < 1e-9);
  assert.ok(items.some((i) => i.text === "NW") && items.some((i) => i.text === "NE"));
});

test("labels are drawn only where they fit whole", () => {
  for (const view of [0, 37, 123, 359]) for (const i of tapeItems(view, 420, [])) if (i.cls.startsWith("lbl")) assert.ok(i.x > 14 && i.x < 380);
});

test("marks out of view are left off, and two that would touch take separate rows", () => {
  const items = tapeItems(90, 420, [[92, "▲ bow", "#ff8a2a"], [95, "☀ sun", "#ffd166"], [270, "☾ moon", "#cfe0ff"]]);
  const mk = items.filter((i) => i.cls.startsWith("mk"));
  assert.deepEqual(mk.map((m) => m.text), ["▲ bow", "☀ sun"]);
  assert.deepEqual(mk.map((m) => m.cls), ["mk", "mk up"]);
  assert.equal(mk[0].colour, "#ff8a2a");
});
