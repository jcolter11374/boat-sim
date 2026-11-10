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
  simChoices,
  summarise,
  withSim,
  type Catalog,
  type SimSlots,
} from "../src/yard/design";
import { gridDistance } from "../src/yard/launch";
import { replayUrl } from "../src/replay/data";

const cat = JSON.parse(readFileSync("public/parts-catalog.json", "utf8")) as Catalog;
const sim = JSON.parse(readFileSync("public/sim-slots.json", "utf8")) as SimSlots;

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

test("the grid launcher's distance counts differing modelled slots, then cruise watts", () => {
  const c = withSim(cat, sim);
  const plan = plannedDesign(c);
  const b = (options: Record<string, string | number>) => ({ id: "", boat: "v4 kayak", label: "", options, odds: null, replays: [] });
  assert.deepEqual(gridDistance(b({ ...plan.picks, cruise_w: 25 }), c, plan), [0, 0]);
  // A grid build that lists only what differs: unlisted slots are the planned choice.
  assert.deepEqual(gridDistance(b({ thr: "one-t200", cruise_w: 20 }), c, plan), [1, 5]);
  // Options the simulator doesn't model yet don't count against a build.
  const mat = c.slots.find((s) => s.id === "material")!;
  const fancy = { ...plan, picks: { ...plan.picks, material: mat.opts[1].id } };
  assert.equal(mat.opts[1].effect, "no effect yet");
  assert.deepEqual(gridDistance(b({ cruise_w: 25 }), c, fancy), [0, 0]);
});

test("the simulator's notes merge into the catalog without losing prices", () => {
  const c = withSim(cat, sim);
  for (const s of cat.slots) {
    const m = c.slots.find((x) => x.id === s.id)!;
    assert.deepEqual(m.opts.map((o) => [o.id, o.cost, o.kg]), s.opts.map((o) => [o.id, o.cost, o.kg]), s.id);
  }
  for (const id of ["drive", "material", "shape"]) {
    const s = c.slots.find((x) => x.id === id);
    assert.ok(s, `new slot ${id}`);
    assert.equal(s!.opts.filter((o) => o.def).length, 1, `${id} has one planned choice`);
    assert.ok(s!.opts.slice(1).every((o) => o.priceTbd), `${id}: alternatives have no price yet`);
  }
  assert.equal(withSim(cat, null), cat);
  // Share links carry the new slots too.
  const d = plannedDesign(c);
  d.picks.shape = "surf-ski";
  assert.equal(decodeDesign(c, encodeDesign(c, d)).picks.shape, "surf-ski");
  assert.equal(simChoices(d).shape, "surf-ski");
  assert.equal(simChoices(d).cruise_w, 25);
});

test("replays are read from this site only", () => {
  const o = "https://jcolter11374.github.io";
  assert.equal(replayUrl("./voyages", "a.json", o), "./voyages/a.json");
  assert.equal(replayUrl(".", `${o}/boat-sim/boatyard/x.json`, o), `${o}/boat-sim/boatyard/x.json`);
  assert.equal(replayUrl(".", `blob:${o}/1234`, o), `blob:${o}/1234`);
  assert.throws(() => replayUrl(".", "https://example.com/x.json", o));
});
