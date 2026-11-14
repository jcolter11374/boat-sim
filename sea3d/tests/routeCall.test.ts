import { test } from "node:test";
import assert from "node:assert/strict";
import { ROUTE_BIG_KM, routeBigText } from "../src/helm/routeCall.ts";

test("a free faster line is told only when the forecast puts it 90 km or more ahead (routing-findings.md)", () => {
  assert.equal(ROUTE_BIG_KM, 90);
  const t = routeBigText("095°", 118);
  assert.equal(
    t,
    "Navigator's note: the forecast says steering 095° would gain about 120 km on the ghost over the next 4 days, in no worse seas. It's a gamble: she'd hold that heading for days, and forecasts can be wrong. In our test crossings, a lead forecast this big paid off 7 times in 8; the other time she lost about 95 km. To try it, change her heading in Orders.",
  );
  assert.doesNotMatch(t, /autopilot's line/, "right on a set heading too (Maya)");
});
