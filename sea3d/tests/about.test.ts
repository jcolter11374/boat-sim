import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ABOUT } from "../src/boats/about";
import { STOCK, type StockKey } from "../src/boats/specs";

/** A config's spec_card numbers (configs/stock_*.yaml), by key. */
function specCard(key: StockKey): Record<string, number> {
  const yaml = readFileSync(new URL(`../../configs/${key}.yaml`, import.meta.url), "utf8");
  const block = /^  spec_card:.*\n((?:    .*\n)+)/m.exec(yaml);
  assert.ok(block, `${key}: no spec_card`);
  const out: Record<string, number> = {};
  for (const m of block[1].matchAll(/^    (\w+):\s*([\d.]+)\s*(?:#|$)/gm)) out[m[1]] = Number(m[2]);
  return out;
}
const metres = (s: string) => Number(/^(?:about )?([\d.]+) m\b/.exec(s)?.[1]);
const row = (key: StockKey, what: RegExp) => ABOUT[key].specs.find(([w]) => what.test(w))?.[1];

test("every stock boat has specs, a history and sources", () => {
  for (const key of Object.keys(STOCK) as StockKey[]) {
    const a = ABOUT[key];
    assert.ok(a, `${key}: no specs and history`);
    assert.ok(a.specs.length >= 5 && a.history.length > 80 && a.sources.length >= 2, key);
    for (const s of a.sources) assert.match(s.url, /^https:\/\//, `${key}: ${s.name}`);
  }
});

test("the card's length and width are the config's (the builder's numbers)", () => {
  for (const key of Object.keys(STOCK) as StockKey[]) {
    const card = specCard(key);
    assert.equal(metres(row(key, /^Length$/)!), card.length_overall_m, `${key} length`);
    if (card.beam_m) assert.equal(metres(row(key, /^Width/)!), card.beam_m, `${key} width`);
    if (card.draft_m) assert.equal(metres(row(key, /^Keel depth/)!), card.draft_m, `${key} keel depth`);
  }
});
