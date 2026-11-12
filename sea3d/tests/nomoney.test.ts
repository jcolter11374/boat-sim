import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { designYaml, hintsFor, plannedDesign, withSim, type Catalog, type SimSlots } from "../src/yard/design";
import { randolphCatalog } from "../src/yard/bases";
import { deadChoice, livePicks, moneyWords, partFigure, shownOptions } from "../src/yard/nomoney";

// No money in the game (John, 12 Nov): what a player sees in the Boatyard.
const sim = JSON.parse(readFileSync("public/sim-slots.json", "utf8")) as SimSlots;
const cat = withSim(JSON.parse(readFileSync("public/parts-catalog.json", "utf8")) as Catalog, sim);
const slot = (id: string) => cat.slots.find((s) => s.id === id)!;
const opt = (s: string, o: string) => slot(s).opts.find((x) => x.id === o)!;

test("choices that only ever changed the price are gone", () => {
  assert.deepEqual(shownOptions(slot("spares")), []);
  assert.deepEqual(shownOptions(slot("radar")), []);
  assert.ok(deadChoice(opt("lead", "lead-50-scrap")));
  assert.deepEqual(shownOptions(slot("lead")).map((o) => o.id), ["lead-50-new", "lead-40"]);
  // Real choices stay, the planned part first as in the catalog.
  assert.deepEqual(shownOptions(slot("bat")).map((o) => o.id), ["two-50ah", "one-50ah", "two-100ah"]);
  assert.ok(shownOptions(slot("ais")).some((o) => o.id === "none"));
});

test("each part shows what it changes, not what it costs", () => {
  assert.equal(partFigure(slot("thr"), opt("thr", "one-t200")), "−0.45 kg");
  assert.equal(partFigure(slot("bat"), opt("bat", "two-100ah")), "~ +10 kg, +1,280 Wh");
  assert.equal(partFigure(slot("sol"), opt("sol", "solar-300")), "~ +1.2 kg, +50 W");
  assert.equal(partFigure(slot("bat"), opt("bat", "two-50ah")), "");
});

test("no money in any word a player reads in the Boatyard", () => {
  for (const c of [cat, randolphCatalog("revc", sim, cat)!, randolphCatalog("revb", sim, cat)!]) {
    for (const s of c.slots)
      for (const o of shownOptions(s)) {
        assert.deepEqual(moneyWords(`${o.n} ${o.d} ${partFigure(s, o)}`), [], `${s.id}/${o.id}: ${o.d}`);
        for (const other of s.opts) assert.deepEqual(moneyWords(hintsFor(other, o).join(" ")), [], `${s.id}/${other.id}->${o.id}`);
      }
  }
  assert.doesNotMatch(designYaml(cat, plannedDesign(cat)), /cost|usd/i);
  assert.deepEqual(moneyWords("$379"), ["$"]);
  assert.deepEqual(moneyWords("price TBD"), ["price"]);
});

test("a share link that picks a hidden part opens on the planned part", () => {
  const picks = livePicks(cat.slots, { lead: "lead-50-scrap", bat: "two-100ah" });
  assert.equal(picks.lead, "lead-50-new");
  assert.equal(picks.bat, "two-100ah"); // real choices are kept
});
