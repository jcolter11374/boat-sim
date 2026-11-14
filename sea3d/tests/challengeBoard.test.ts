import { test } from "node:test";
import assert from "node:assert/strict";
import { boardTab, challengeRows } from "../src/challengeBoard.ts";
import type { Challenge } from "../src/helm/challenges.ts";

const C = (id: string, n: number, title: string, start: string): Challenge => ({ id, n, title, start, story: "", bundle: "", seed: 1, hurricane: false, season: false, weather_note: "", storm_boost: false });
const LIST = [C("gentle-june", 1, "Gentle June", "2020-06-15T12:00:00Z"), C("spring-gale", 2, "Spring gale", "2020-04-01T12:00:00Z"), C("sandys-shadow", 3, "Sandy's shadow", "2012-10-22T12:00:00Z"), C("bay-mouth", 0, "Dead at the Bay mouth", "2023-05-15T12:00:00Z")];

test("the leaderboard link opens the right tab: #challenges, else the designs board", () => {
  assert.equal(boardTab("#challenges"), "challenges");
  assert.equal(boardTab(""), "designs");
  assert.equal(boardTab("#v4_kayak"), "designs");
});

test("the challenges tab lists every challenge in the list's order, with your best beside the autopilot's", () => {
  const rows = challengeRows(LIST, {
    "sandys-shadow": { best: { stars: 2, finished: true, days: 6 }, boat: "Petrel", at: "2026-11-13T08:00:00Z", autopilot: { stars: 0, finished: true, days: 6 }, tries: 3 },
    "spring-gale": { best: { stars: null, finished: false, days: 3.9 }, boat: "", at: "", autopilot: { stars: null, finished: true, days: 58.2 }, tries: 1 },
  });
  assert.deepEqual(rows.map((r) => r.id), ["gentle-june", "spring-gale", "sandys-shadow", "bay-mouth"]); // the list's own order, Gentle June first
  assert.deepEqual(rows[0], { id: "gentle-june", title: "Gentle June", when: "Launches 15 Jun 2020", tried: false, yours: "Not sailed yet", detail: "", autopilot: "\u2014", ahead: null, href: "./helm.html?challenge=gentle-june", link: "Sail it" });
  assert.equal(rows[1].yours, "Lost on day 3.9");
  assert.equal(rows[1].detail, "1 try");
  assert.equal(rows[1].autopilot, "Finished in 58.2 days");
  assert.equal(rows[1].ahead, false);
  assert.equal(rows[2].yours, "★★☆ in 6.0 days");
  assert.equal(rows[2].detail, "Petrel · 3 tries");
  assert.equal(rows[2].autopilot, "☆☆☆ in 6.0 days");
  assert.equal(rows[2].ahead, true);
  assert.equal(rows[2].link, "Try again");
});

test("no money and no internal names on the challenges tab", () => {
  const text = JSON.stringify(challengeRows(LIST, {}));
  assert.doesNotMatch(text, /\$|£|€|price|cost|budget/i);
});
