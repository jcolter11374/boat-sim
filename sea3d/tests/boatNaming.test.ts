import { test } from "node:test";
import assert from "node:assert/strict";
import { boatNaming } from "../src/ui/myboatAdapter.ts";

test("no boat saved: our kayak", () => {
  assert.deepEqual(boatNaming(null), { name: "Our kayak" });
});

test("a design still carrying the Randolph boat's name reads as our model (B2)", () => {
  for (const name of ["Rev C", "My Rev C5", "rev c5", "Randolph Rev C"]) assert.deepEqual(boatNaming({ kind: "yard", base: "revc", name }), { name: "Rev C5 (our model)" }, name);
  assert.deepEqual(boatNaming({ kind: "yard", base: "revb", name: "My Rev B" }), { name: "Rev B (our model)" });
});

test("a renamed design on the Randolph boat keeps its name, with a note on what it's built on (Elena)", () => {
  assert.deepEqual(boatNaming({ kind: "yard", base: "revc", name: "Petrel" }), { name: "Petrel", note: "based on our model of the Randolph team's Rev C5" });
});

test("our kayak's designs and stock boats keep their names as saved", () => {
  assert.deepEqual(boatNaming({ kind: "yard", base: "kayak", name: "My kayak" }), { name: "My kayak" });
  assert.deepEqual(boatNaming({ kind: "stock", base: "stock_pearson31_2", name: "Pearson 31-2 (our model)" }), { name: "Pearson 31-2 (our model)" });
});
