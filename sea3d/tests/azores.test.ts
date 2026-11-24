import { test } from "node:test";
import assert from "node:assert/strict";
import { AZORES_ASK, AZORES_COST, azoresDue, azoresNote, azoresSmallPrint, azoresText, azoresYes } from "../src/helm/azores";

test("the call is due once, in mid-ocean, and never once she is going by the islands", () => {
  assert.equal(azoresDue(-50, false, false), false, "too early");
  assert.equal(azoresDue(-42, false, false), true);
  assert.equal(azoresDue(-42, true, false), false, "asked already");
  assert.equal(azoresDue(-42, false, true), false, "already going by them");
  assert.equal(azoresDue(-35.9, false, false), false, "too late to ask");
  // The simulator takes the order only west of 33W: the window must close before that.
  assert.ok(AZORES_ASK.east <= -34);
});

test("the words give the distance in round numbers and the measured price", () => {
  assert.match(azoresText(1234), /about 1,250 km/);
  assert.match(azoresYes(), new RegExp(`about ${AZORES_COST.typical} days longer, and a risk`));
  assert.match(azoresText(1234), new RegExp(`1 crossing in ${AZORES_COST.lostOneIn} was lost`));
  assert.match(azoresSmallPrint(), new RegExp(`${AZORES_COST.low} to ${AZORES_COST.high} days`));
  assert.match(azoresSmallPrint(), /same finish line/);
  assert.match(azoresNote(0.2), /about 1 day\./);
  assert.match(azoresNote(9.6), /about 10 days\./);
});
