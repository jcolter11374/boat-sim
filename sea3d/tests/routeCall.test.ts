import { test } from "node:test";
import assert from "node:assert/strict";
import { ROUTE_BIG_KM, routeBigText } from "../src/helm/routeCall.ts";

test("a free faster line is a card only when the forecast puts it 90 km or more ahead (routing-findings.md)", () => {
  assert.equal(ROUTE_BIG_KM, 90);
  const t = routeBigText("095°", "the autopilot's line", "about 120 km gained on the ghost");
  assert.match(t, /095° well ahead of the autopilot's line, about 120 km gained/);
  assert.match(t, /gamble/);
  assert.match(t, /7 times in 8/, "the odds, as measured");
  assert.doesNotMatch(t, /<|>/, "plain text: the card uses textContent");
});
