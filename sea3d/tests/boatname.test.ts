import { test } from "node:test";
import assert from "node:assert/strict";
import { hullName, nameScale, NAME_H, NAME_MAX_W } from "../src/boats/boatName";
import type { MyBoat } from "../src/myboat";

const mine = (name: string, base = "kayak", kind: MyBoat["kind"] = "yard"): MyBoat => ({ kind, base, hash: "", name, choices: {}, saved: "" });

test("the kayak carries the player's own name, and nothing until she has one", () => {
  assert.equal(hullName(null), "");
  assert.equal(hullName(mine("Our kayak")), "");
  assert.equal(hullName(mine("My kayak")), "");
  assert.equal(hullName(mine("  Sea   Biscuit ")), "Sea Biscuit");
  // A saved stock boat or Randolph design isn't this kayak: the default name.
  assert.equal(hullName(mine("Pearson", "stock_pearson31_2", "stock")), "");
  assert.equal(hullName(mine("Rev C mine", "revc")), "");
  assert.ok(hullName(mine("x".repeat(40))).length <= 20);
});

test("a long name is squeezed to fit the quarter, a short one keeps its letter height", () => {
  assert.equal(nameScale(300, 70), 1); // about 30 cm at 7 cm capitals
  const s = nameScale(1200, 70);
  assert.ok(s < 1);
  assert.ok(Math.abs((1200 / 70) * NAME_H * s - NAME_MAX_W) < 1e-9);
});
