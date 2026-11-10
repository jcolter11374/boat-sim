// Checks for the Boatyard's design arithmetic (src/yard/design.ts) on the real parts catalog.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PLANNED_KG,
  decodeDesign,
  designYaml,
  encodeDesign,
  hintsFor,
  nightHours,
  optionOf,
  plannedDesign,
  summarise,
  type Catalog,
} from "../src/yard/design";
import { gridDistance } from "../src/yard/launch";

const cat = JSON.parse(readFileSync("public/parts-catalog.json", "utf8")) as Catalog;

test("every option has a stable id, unique in its slot, and each slot has a planned choice", () => {
  for (const s of cat.slots) {
    const ids = s.opts.map((o) => o.id);
    assert.ok(ids.every((id) => typeof id === "string" && /^[a-z0-9-]+$/.test(id)), `${s.id}: ${ids}`);
    assert.equal(new Set(ids).size, ids.length, `${s.id}: duplicate ids`);
    assert.equal(s.opts.filter((o) => o.def).length, 1, `${s.id}: one planned option`);
  }
});

test("the planned build adds up to the catalog's own totals", () => {
  const s = summarise(cat, plannedDesign(cat));
  const parts = cat.base.cost + cat.slots.reduce((a, sl) => a + sl.opts.find((o) => o.def)!.cost, 0);
  assert.ok(Math.abs(s.partsCost - parts) < 0.01);
  assert.equal(s.massKg, PLANNED_KG);
  assert.equal(s.thrusters, 2);
  assert.equal(s.solarW, 250);
  assert.equal(s.batteryWh, 1280);
  assert.equal(s.boxes, 2);
  assert.ok(s.beacon && s.ais && s.antifouling);
});

test("swapping parts changes cost, weight and power the way the catalog says", () => {
  const d = plannedDesign(cat);
  const base = summarise(cat, d);
  d.picks.bat = "two-100ah";
  d.picks.thr = "one-t200";
  const s = summarise(cat, d);
  assert.equal(s.batteryWh, 2560);
  assert.equal(s.thrusters, 1);
  const dkg = optionOf(cat, "bat", d)!.kg + optionOf(cat, "thr", d)!.kg;
  assert.ok(Math.abs(s.massKg - (base.massKg + dkg)) < 1e-9);
  assert.ok(nightHours(s) > nightHours(base) * 1.9, "twice the battery runs about twice as long");
  assert.ok(s.estimates.includes("Batteries"));
});

test("hints say what a swap means, in plain words", () => {
  const bat = cat.slots.find((s) => s.id === "bat")!;
  const two50 = bat.opts.find((o) => o.id === "two-50ah")!;
  const h = hintsFor(two50, bat.opts.find((o) => o.id === "two-100ah")!);
  assert.ok(h.some((x) => /heavier: sits \d+ mm lower/.test(x)), h.join("; "));
  assert.ok(h.some((x) => /longer at night/.test(x)));
  assert.ok(h.some((x) => /estimate/.test(x)));
  const one = hintsFor(two50, bat.opts.find((o) => o.id === "one-50ah")!);
  assert.ok(one.some((x) => /less power at night/.test(x)));
  assert.deepEqual(hintsFor(two50, two50), []);
});

test("share links round-trip and stay short; junk falls back to the planned build", () => {
  const d = plannedDesign(cat);
  assert.equal(encodeDesign(cat, d), "");
  d.picks.sol = "solar-300";
  d.picks.ais = "none";
  d.cruiseW = 15;
  const hash = encodeDesign(cat, d);
  assert.equal(hash, "#sol=solar-300&ais=none&w=15");
  assert.deepEqual(decodeDesign(cat, hash), d);
  assert.deepEqual(decodeDesign(cat, "#sol=solar-9000&w=7&zzz=1"), plannedDesign(cat));
});

test("the design file lists every slot's pick and the totals", () => {
  const y = designYaml(cat, plannedDesign(cat), 'quote "test"');
  for (const s of cat.slots) assert.match(y, new RegExp(`^  ${s.id}: [a-z0-9-]+$`, "m"));
  assert.match(y, /^cruise_w: 25$/m);
  assert.match(y, /^name: "quote \\"test\\""$/m);
});

test("the grid launcher finds the build nearest a design", () => {
  const energy = [
    { id: "s", label: "small", battery_wh: 640, solar_wp: 200 },
    { id: "m", label: "current", battery_wh: 1280, solar_wp: 250 },
  ];
  const b = (motors: number, e: string, boxes: number, w = 25) => ({ id: "", boat: "v4 kayak", label: "", options: { motors, cruise_w: w, energy: e, boxes }, odds: null, replays: [] });
  const s = summarise(cat, plannedDesign(cat));
  assert.equal(gridDistance(b(2, "m", 2), energy, s), 0);
  assert.ok(gridDistance(b(1, "m", 2), energy, s) > gridDistance(b(2, "s", 2), energy, s), "a motor matters more than battery size");
});
