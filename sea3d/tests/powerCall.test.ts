import { test } from "node:test";
import assert from "node:assert/strict";
import { PUSH_LEVELS, handBackNote, nightLine, nightOpener, pickPush, powerAfter, pushCard, pushHeading, pushOrders, worthAskingAgain } from "../src/helm/powerCall.ts";

const sail = (lead_km: number, soc_min: number, power?: number) => ({ hours: 96, stw: 1, soc: 0, km: 400, outcome: "at_sea", lead_km, soc_min, power });

test("a push points straight at the finish from the autopilot, and keeps a heading of yours", () => {
  assert.equal(pushHeading("auto"), "finish");
  assert.equal(pushHeading(95), 95);
  assert.equal(pushHeading("route"), "route");
});

test("the look tries more power only when there is battery to spend and motors to spend it", () => {
  assert.deepEqual(pushOrders("auto", 0.25, 0.8, true), PUSH_LEVELS.map((power) => ({ heading: "finish", power })));
  assert.deepEqual(pushOrders("auto", 0.25, 0.49, true), [], "under half a battery: nothing to spend");
  assert.deepEqual(pushOrders("auto", 0.25, 0.9, false), [], "a boat under sail alone");
  assert.deepEqual(pushOrders(100, 0.5, 0.9, true), [{ heading: 100, power: 0.8 }], "only levels above the power in force");
  assert.deepEqual(pushOrders(100, 0.8, 0.9, true), []);
});

test("a push is a call only when it gains a quarter of a day and the battery pays for it", () => {
  const now = sail(0, 0.6);
  // 100 km a day: 40 km is 0.4 day.
  const ask = pickPush(now, [sail(40, 0.1, 0.5), sail(20, 0.0, 0.8)], 100);
  assert.equal(ask?.push.power, 0.5, "the level the forecast puts furthest ahead");
  assert.ok(Math.abs(ask!.gainDays - 0.4) < 1e-9);
  assert.equal(pickPush(now, [sail(20, 0.1, 0.5)], 100), null, "0.2 day: not worth stopping the clock");
  assert.equal(pickPush(now, [sail(40, 0.55, 0.5)], 100), null, "a gain that costs nothing is not a question");
  assert.equal(pickPush(now, [], 100), null);
  assert.equal(pickPush(now, [sail(40, 0.1, 0.5)], 0), null, "no pace to measure by");
});

test("the card says what the forecast says and what it costs, in plain words (Elena, 14 Nov)", () => {
  const c = pushCard("auto", 0.25, 0.97, sail(40, 0.42, 0.5));
  assert.equal(c.text, "Navigator's check: the battery is at 97%. At 50% power she'd pull ahead of the autopilot over the next 4 days, but the battery would drop to 42%.");
  assert.equal(c.push, "Push: 50% power");
  assert.equal(c.pushTitle, "Faster, but it drains the battery. Ease off, or hand her back to the autopilot, before it runs low.");
  assert.equal(c.stay, "Stay on the autopilot (same as the ghost)");
  assert.equal(c.ago, "You pushed to 50% power 4 days ago");
  const mine = pushCard(95, 0.3, 0.7, sail(40, 0.2, 0.8));
  assert.equal(mine.text, "Navigator's check: the battery is at 70%. At 80% power she'd go faster than at your 30% over the next 4 days, but the battery would drop to 20%.");
  assert.equal(mine.push, "Push: 80% power");
  assert.equal(mine.stay, "Keep 30% power");
  assert.equal(mine.did, "pushed to 80% power");
});

test("the night call says \"night is coming\" only when it is, and the time otherwise", () => {
  assert.equal(nightOpener(0.3, 2), "The battery is at 30% and night is coming, with no sun to charge it.");
  assert.equal(nightOpener(0.3, 3), "The battery is at 30% and night is coming, with no sun to charge it.");
  assert.equal(nightOpener(0.54, 6), "The battery is at 54%, and it will be dark in about 6 hours, with no sun to charge it.");
});

test("the hand-back note, in whole fives of km", () => {
  assert.equal(handBackNote(61), "Navigator's note: for the next 4 days the forecast favours the autopilot over your order (about 60 km better against the ghost). To hand her back, open Orders.");
});

test("the night call's line: 35% at the autopilot's cruise, higher the harder she is pushed", () => {
  assert.equal(nightLine(0.25), 0.35);
  assert.equal(nightLine(0.1), 0.35);
  assert.ok(Math.abs(nightLine(0.5) - 0.55) < 1e-9);
  assert.equal(nightLine(1), 0.9);
});

test("after \"stay\" a push is asked again only when the offer is clearly better", () => {
  assert.equal(worthAskingAgain(0.3, null), true, "never turned one down");
  assert.equal(worthAskingAgain(0.4, 0.3), false, "about the same offer: not asked twice");
  assert.equal(worthAskingAgain(0.54, 0.3), false);
  assert.equal(worthAskingAgain(0.55, 0.3), true, "a quarter of a day better than the one turned down");
});

test("handing her back after a push puts the panel's power back to what it was", () => {
  assert.equal(powerAfter("auto", 0.5, 0.25), 0.25, "the pushed 50% does not linger");
  assert.equal(powerAfter("auto", 0.4, null), 0.4, "no push: nothing to put back");
  assert.equal(powerAfter(95, 0.5, 0.25), 0.5, "an order of your own keeps the power asked for");
  assert.equal(powerAfter("finish", 0.1, 0.25), 0.1, "easing off for the night is still your order");
});
