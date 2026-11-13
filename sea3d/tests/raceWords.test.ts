// A race's names on the strip, the chart and the far boat's tag (src/helm/raceWords.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { bareRacer, farBoatTag, raceLead, raceLine, shortRacer } from "../src/helm/raceWords.ts";
import { raceName } from "../src/helm/raceSource.ts";

const NAMES: [string, string] = ["Our kayak", raceName("Randolph Rev C")];

test("a Randolph boat keeps \"(our model)\" in its short name (B2)", () => {
  assert.equal(NAMES[1], "Randolph Rev C5 (our model)");
  assert.equal(shortRacer(NAMES[1]), "Rev C5 (our model)");
  assert.equal(shortRacer(raceName("Randolph Rev B")), "Rev B (our model)");
  assert.equal(shortRacer("Our kayak"), "Our kayak");
  assert.equal(shortRacer("Sea Biscuit"), "Sea Biscuit");
});

test("the lead cell names the boat that is ahead, by how far", () => {
  assert.deepEqual(raceLead(59.4, NAMES), { value: "59", unit: " km ahead", label: "Our kayak", leader: 0 });
  assert.deepEqual(raceLead(-1234.2, NAMES), { value: "1,234", unit: " km ahead", label: "Rev C5 (our model)", leader: 1 });
});

test("within a kilometre the boats are level, and nobody is named as ahead", () => {
  for (const km of [0, 0.4, -0.49, NaN]) assert.deepEqual(raceLead(km, NAMES), { value: "level", unit: "", label: "the two boats", leader: null });
});

test("the far boat's tag carries its name, never \"Ghost\" or \"You\"", () => {
  assert.equal(farBoatTag(NAMES[1], 4.2), "Rev C5 (our model) · 4 km");
  assert.equal(farBoatTag(NAMES[0], 0.3), "Our kayak · alongside");
});

test("the big map's line says which boat is ahead of which, in the panel's short names", () => {
  assert.equal(raceLine(59.4, NAMES), "Our kayak is 59 km ahead of Rev C5");
  assert.equal(raceLine(-12, NAMES), "Rev C5 is 12 km ahead of Our kayak");
  assert.equal(raceLine(0.2, NAMES), "Our kayak and Rev C5 are level");
  // Only the panel drops it: the names that stand alone keep "(our model)" (B2).
  assert.equal(bareRacer(NAMES[1]), "Rev C5");
  assert.match(shortRacer(NAMES[1]), /\(our model\)$/);
  assert.match(farBoatTag(NAMES[1], 3), /\(our model\)/);
  assert.match(raceLead(-5, NAMES).label, /\(our model\)$/);
});
