import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RACE_IDS, RIVAL_WORDS, WHO_WORDS, dayLabel, defaultRival, raceId, raceLink, rivalName, watchDay, watchDays, watchLink, whoFromUrl } from "../src/helm/whoSteers.ts";
import { RACE_BOATS, racePick } from "../src/helm/raceSource.ts";
import { pickVoyage } from "../src/helm/watchSource.ts";
import type { IndexEntry } from "../src/replay/data.ts";

const index = (JSON.parse(readFileSync("public/voyages/index.json", "utf8")) as { voyages: IndexEntry[] }).voyages;

test("You is the default; a link can open the card with the autopilot picked", () => {
  assert.deepEqual(whoFromUrl(""), { who: "you", day: "2020-06-01", against: "" });
  assert.deepEqual(whoFromUrl("?who=autopilot"), { who: "autopilot", day: "2020-06-01", against: "" });
  assert.deepEqual(whoFromUrl("?who=autopilot&day=2020-04-15"), { who: "autopilot", day: "2020-04-15", against: "" });
  assert.deepEqual(whoFromUrl("?who=robot&day=tomorrow"), { who: "you", day: "2020-06-01", against: "" });
});

test("the days she can be watched are plain dates, in order, with no hint of the ending", () => {
  const days = watchDays(index, "");
  assert.deepEqual(days.map((d) => d.label), ["1 Apr", "15 Apr", "1 May", "15 May", "1 Jun", "15 Jun"]);
  assert.ok(days.every((d) => d.year === "2020"));
  assert.ok(days.every((d) => !/arriv|lost|aground|finish|sank/i.test(`${d.label} ${d.year}`)));
  assert.equal(watchDays(index, "stock_cruiser31").length, 6);
  assert.equal(watchDays(index, "revc")[0].file, "voyage_randolph-rev-c_2020-04-01.json");
  assert.deepEqual(watchDays(index, "mine"), [], "a design of your own has no voyage to watch");
});

test("with the autopilot picked the default day is 1 June 2020, as Watch a voyage opens today", () => {
  const days = watchDays(index, "");
  assert.equal(watchDay(days, "2020-06-01")!.file, "voyage_2020-06-01.json");
  assert.equal(watchDay(days, "2020-05-15")!.day, "2020-05-15");
  assert.equal(watchDay(days, "2020-04-23")!.day, "2020-06-01", "Calm (23 April) has no voyage to watch: the default instead");
  assert.equal(watchDay([], "2020-06-01"), null);
});

test("setting sail with the autopilot opens that voyage on this screen and keeps the page's other switches", () => {
  const link = watchLink("?quality=low&who=autopilot&day=2020-05-01&challenge=sandys-shadow&go=1", "voyage_2020-05-01.json");
  assert.equal(link, "helm.html?quality=low&watch=voyage_2020-05-01.json");
  // The watch page finds exactly that file.
  assert.equal(pickVoyage(new URLSearchParams(link.split("?")[1]).get("watch")!, index)!.file, "voyage_2020-05-01.json");
});

test("no word a player reads on the card says how the voyage is stored (Elena), and no speed is picked (T3)", () => {
  const all = JSON.stringify(WHO_WORDS);
  assert.doesNotMatch(all, /record|replay/i);
  assert.doesNotMatch(all, /real time|per second|a second|\bfast\b/i);
  assert.equal(WHO_WORDS.autopilot.after, "You can change speed and pause; she steers herself.");
});

// ---- Race against (M2, R4)
test("a race link names both boats and the launch, and the race page's own reader takes it", () => {
  const link = raceLink("?quality=low&who=autopilot&against=revc&day=2020-05-01", "kayak", "revc", "2020-05-01");
  assert.equal(link, "helm.html?quality=low&race=kayak,revc&launch=2");
  const p = new URLSearchParams(link.split("?")[1]);
  const pick = racePick(p.get("race")!, p.get("launch"), null);
  assert.deepEqual(pick, { a: {}, b: { base: "revc" }, launch: 2, breakdowns: true });
  assert.deepEqual([...RACE_IDS], [...RACE_BOATS], "the card and the race link agree on which boats can race");
  assert.equal(new URLSearchParams(raceLink("", "mine", "kayak", "2020-04-23").split("?")[1]).get("launch"), "0", "a day that isn't one of the six: the first launch");
});

test("the card's boat as a racer: our kayak, a Randolph model or your design; a stock yacht can't race", () => {
  assert.equal(raceId(""), "kayak");
  assert.equal(raceId("mine"), "mine");
  assert.equal(raceId("revc"), "revc");
  assert.equal(raceId("stock_cruiser31"), null);
  assert.equal(defaultRival("kayak"), "revc");
  assert.equal(defaultRival("revc"), "kayak");
  assert.equal(whoFromUrl("?who=autopilot&against=revb").against, "revb");
  assert.equal(whoFromUrl("?who=autopilot&against=<b>").against, "");
});

test("a Randolph rival is always named as our model (B2), and the race's words pick no speed (T3)", () => {
  assert.equal(rivalName("revc", null), "Randolph Rev C5 (our model)");
  assert.equal(rivalName("revb", null), "Randolph Rev B (our model)");
  assert.equal(rivalName("mine", "Sea Biscuit"), "Sea Biscuit");
  assert.equal(dayLabel("2020-06-15"), "15 Jun");
  assert.doesNotMatch(JSON.stringify(RIVAL_WORDS), /record|replay|real time|per second/i);
});
