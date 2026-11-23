// The helm results card's words (src/helm/story.ts): who won, what happened, the numbers, your calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Card } from "../src/helm/game";
import { PUSH_ODDS, callLines, callName, headline, leaves, numbers, plainEnding, story } from "../src/helm/story";

const side = (outcome: string, days: number, ending?: Card["boat"]["ending"]): Card["boat"] => ({ outcome, days, battery_low: 0.4, breakdowns: [], ending });
const card = (over: Partial<Card>): Card => ({
  build: "kayak",
  launch: "2020-04-23T12:00:00Z",
  seed: 1,
  breakdowns_on: true,
  boat: side("arrived", 50),
  ghost: side("arrived", 52.3),
  margin_days: 2.3,
  verdict: "won",
  breakdowns_differ: false,
  orders: [],
  ...over,
});
const silent = { headline: "Went silent", words: "both electronics boxes dead: silent and uncontrolled", where: "out in the open ocean", day: 3.9, boat: null };

test("the headline says who won, and by how much", () => {
  assert.equal(headline(card({})), "You beat the autopilot by 2.3 days.");
  assert.equal(headline(card({ verdict: "lost", margin_days: -1.1 })), "The autopilot beat you by 1.1 days.");
  assert.equal(headline(card({ verdict: "draw", margin_days: 0.4 })), "Level with the autopilot: within a day.");
  assert.equal(headline(card({ verdict: "won", margin_days: null, ghost: side("lost", 9) })), "You made it to Portugal, and the autopilot didn't.");
  const both = card({ verdict: "neither_finished", margin_days: null, boat: side("lost", 3.9, silent), ghost: side("lost", 3.9, silent) });
  assert.equal(headline(both), "Lost on day 3.9, and so was the ghost.");
});

test("the story is said once when both boats ended the same way", () => {
  const both = card({ verdict: "neither_finished", margin_days: null, boat: side("lost", 3.9, silent), ghost: side("lost", 3.9, silent) });
  const s = story(both);
  assert.match(s, /^Both of her computers failed out in the open ocean, and she went silent\./);
  assert.doesNotMatch(s, /day 3\.9/, "the day is the headline's");
  assert.match(s, /same bad luck/);
  assert.equal(s.match(/computers/g)?.length, 1);
  const apart = card({ verdict: "lost", margin_days: null, boat: side("lost", 9, { ...silent, day: 9 }), ghost: side("arrived", 55, { headline: "Finished", words: "", where: null, day: 55, boat: null }) });
  assert.equal(story(apart), "Both of her computers failed out in the open ocean on day 9.0, and she went silent. The ghost crossed the finish line west of Lisbon after 55.0 days.");
  const caught = { headline: "Picked up", words: "taken or snagged by fishermen", where: "near the coast", day: 2, boat: null };
  assert.equal(plainEnding(caught, "lost"), "Caught in fishing gear near the coast.");
  assert.equal(plainEnding({ ...caught, words: "silent more than 10 days in a row", where: null }, "disqualified"), "Silent for more than 10 days in a row, which is out under the race rules.");
  assert.equal(plainEnding({ ...caught, words: "flamingo seam let go", where: null }, "lost"), "Flamingo seam let go.");
  // A crewless dinghy rolled in a blow says what rolled her and how big the sea was (Omar, #540).
  const rolled = { ...caught, words: "capsized and stayed upside down (not self-righting; breaking seas, Hs 3.6 m)", where: "out in the open ocean" };
  assert.equal(plainEnding(rolled, "lost"), "A breaking wave rolled her over out in the open ocean, in waves of 3.6 m, and with nobody aboard she couldn't right herself.");
  assert.equal(plainEnding({ ...rolled, words: "capsized and stayed upside down (not self-righting)" }, "lost"), "A breaking wave rolled her over out in the open ocean, and with nobody aboard she couldn't right herself.");
  const keel = { ...rolled, words: "rolled by a breaking wave: dismasted and flooded (breaking seas, Hs 8.1 m)" };
  assert.equal(plainEnding(keel, "lost"), "A breaking wave rolled her over out in the open ocean, in waves of 8.1 m: she lost her mast and filled with water.");
});

test("three big numbers at most, signed against the ghost", () => {
  const n = numbers(card({}), 5256, 5256, 0);
  assert.equal(n.length, 3);
  assert.deepEqual(n.map((x) => x.value), ["50.0", "5,256", "+2.3"]);
  const behind = numbers(card({ margin_days: null, verdict: "neither_finished" }), 1200, 5256, -40);
  assert.deepEqual([behind[2].value, behind[2].label], ["−40", "behind the ghost"]);
});

test("each call says what it was worth until the next one", () => {
  const lines = callLines(
    [
      { day: 2, chose: "Took the route that rides the Stream", lead: 0 },
      { day: 9, chose: "Dodged south-east (115°)", lead: 120 },
    ],
    80,
  );
  assert.deepEqual(lines, ["Day 2.0 · Took the route that rides the Stream · gained 120 km on the ghost", "Day 9.0 · Dodged south-east (115°) · lost 40 km to the ghost"]);
  // #654: 122 km behind at the call, level at the finish. That is 122 km gained, not "122 km ahead".
  assert.deepEqual(callLines([{ day: 8.2, chose: "Kept 10% power", lead: -122 }], 0), ["Day 8.2 · Kept 10% power · gained 122 km on the ghost"]);
  assert.deepEqual(callLines([{ day: 3, chose: "Held course", lead: 7 }], 7.4), ["Day 3.0 · Held course · no gain or loss on the ghost"]);
  assert.match(callLines([], 10)[0], /You let the autopilot sail/);
  assert.deepEqual(callLines([], 10, false), ["No call came up before the voyage ended."]);
  assert.deepEqual(callLines([{ day: 9.4, chose: callName("Stay on the autopilot (same as the ghost)"), lead: 0, ghost: true }], 0), ["Day 9.4 · Stayed on the autopilot (same as the ghost)"]);
  assert.deepEqual(callLines([{ day: 9.4, chose: "Held course", lead: 0, ghost: true }], 50), ["Day 9.4 · Held course · gained 50 km on the ghost"], "a gap opened: km, as before");
  assert.equal(callName("Stay on the autopilot (same as the ghost)"), "Stayed on the autopilot");
  assert.equal(callName("Hand her back to the autopilot (same as the ghost)"), "Handed her back to the autopilot");
  assert.equal(callName("Keep 30% power"), "Kept 30% power");
  assert.equal(callName("Push: 50% power"), "Pushed to 50% power");
  assert.deepEqual(callLines([{ day: 20.2, chose: "Pushed to 50% power", lead: 0 }], -5), ["Day 20.2 · Pushed to 50% power · lost 5 km to the ghost", PUSH_ODDS], "a push: the odds said under the calls");
  assert.equal(callName("Hold course: fastest, but a knockdown is likelier"), "Held course");
  assert.equal(callName("Dodge south-east (115°): safer, but a longer way round"), "Dodged south-east (115°)");
});

test("where this leaves you turns a loss into a reason to go again", () => {
  const lost = card({ verdict: "lost", boat: side("lost", 9) });
  assert.equal(leaves(lost, 0.83, "Our kayak"), "Our kayak finishes 83% of launches. This was one of the unlucky ones.");
  assert.match(leaves(lost, 0.17), /Try another design in the Boatyard\?/);
  assert.match(leaves(card({}), 0.83), /This was one of them\./);
  assert.match(leaves(lost, null), /roll of the dice/);
});

test("a voyage that ends before the start line never started (Microtransat rules, Sam)", () => {
  const both = card({ verdict: "neither_finished", margin_days: null, boat: side("lost", 3.9, silent), ghost: side("lost", 3.9, silent) });
  const none = { me: false, ghost: false };
  assert.equal(headline(both, none), "Neither boat reached the start line.");
  assert.match(story(both, none), /far out in the ocean, and she never reached it\./);
  assert.match(leaves(both, 0.83, "Our kayak", false), /never reached the start, so it doesn't count as a race\./);
  assert.equal(headline(both), "Lost on day 3.9, and so was the ghost.");
});
