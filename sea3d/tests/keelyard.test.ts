// The two keelboats in the Boatyard (M4 wave 1): their sails and rig, from Theo's slot table.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hintsFor, plannedDesign, sailOnly, simChoices, summarise, withSim, type Catalog, type SimSlots } from "../src/yard/design";
import { KEEL_KEYS, baseFromHash, isKeel, keelCatalog } from "../src/yard/bases";
import { moneyWords, partFigure, shownOptions } from "../src/yard/nomoney";
import { OddsModel } from "../src/yard/estimate";
import type { GridBuild } from "../src/yard/launch";

const sim = JSON.parse(readFileSync("public/sim-slots.json", "utf8")) as SimSlots;
const kayak = withSim(JSON.parse(readFileSync("public/parts-catalog.json", "utf8")) as Catalog, sim);

test("each keelboat starts as built, with her sails, rig, keel, drogue, spare autopilot and tactician", () => {
  for (const key of KEEL_KEYS) {
    const c = keelCatalog(key, sim, kayak)!;
    assert.ok(c, key);
    assert.deepEqual(c.slots.map((s) => s.id), ["rig", "cloth", "reef", "storm", "keel", "drogue", "spare", "tactician"]);
    const d = plannedDesign(c);
    assert.equal(d.base, key);
    assert.deepEqual(d.picks, sim.stock![key].defaults);
    // As built, nothing goes to the simulator but the boat.
    assert.deepEqual(simChoices(d, d), { base: key, cruise_w: d.cruiseW });
    assert.ok(sailOnly(d)); // no cruise power to set
    const s = summarise(c, d);
    assert.equal(s.solarW, 400);
    assert.equal(s.batteryWh, 2400);
    assert.ok(s.electronicsWhDay > 0 && Number.isFinite(s.massKg));
    assert.equal(baseFromHash(`#base=${key}`), key);
    assert.ok(isKeel(key) && !isKeel("revc"));
  }
});

test("every keelboat part has a name, a line and no money words", () => {
  for (const key of KEEL_KEYS) {
    const c = keelCatalog(key, sim, kayak)!;
    for (const s of c.slots)
      for (const o of shownOptions(s)) {
        assert.ok(o.n && o.d && !/^[a-z0-9-]+$/.test(o.n), `${key} ${s.id}/${o.id}: ${o.n}`);
        assert.deepEqual(moneyWords(`${o.n} ${o.d} ${partFigure(s, o)}`), [], `${s.id}/${o.id}`);
        for (const other of s.opts) assert.deepEqual(moneyWords(hintsFor(other, o, c.mmPerKg).join(" ")), []);
      }
  }
});

test("a sail part moves the quick odds once the grid has tested it", () => {
  const key = "stock_pearson31_2";
  const c = keelCatalog(key, sim, kayak)!;
  const plan = plannedDesign(c);
  const b = (id: string, options: Record<string, string>, p: number): GridBuild =>
    ({ id, boat: "Pearson 31-2", label: id, options: { base: key, ...options }, odds: { voyages: 100, finished: p * 100, odds: p, low95: p - 0.1, high95: p + 0.1 } }) as unknown as GridBuild;
  const grid = [b(key, {}, 0.6), b(`${key}-storm.storm`, { storm: "storm" }, 0.7), b(`${key}-reef.slab3`, { reef: "slab3" }, 0.65)];
  const m = new OddsModel(c, grid);
  assert.equal(m.odds(plan)!.p, 0.6);
  assert.equal(m.odds({ ...plan, picks: { ...plan.picks, storm: "storm" } })!.p, 0.7);
  // Both: the same gale, so they overlap (one counts in full, the other at a quarter).
  const both = m.odds({ ...plan, picks: { ...plan.picks, storm: "storm", reef: "slab3" } })!.p!;
  assert.ok(both > 0.7 && both < 0.75, String(both));
  // A part the grid hasn't tested says so rather than guess.
  assert.equal(m.odds({ ...plan, picks: { ...plan.picks, cloth: "laminate" } })!.p, null);
});

test("the drogue slot has no caveat now the odds count a keelboat being rolled", () => {
  for (const key of KEEL_KEYS) {
    const c = keelCatalog(key, sim, kayak)!;
    assert.equal(c.slots.find((s) => s.id === "drogue")!.note, undefined);
  }
});
