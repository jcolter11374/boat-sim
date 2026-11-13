import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WHO_WORDS, watchDay, watchDays, watchLink, whoFromUrl } from "../src/helm/whoSteers.ts";
import { pickVoyage } from "../src/helm/watchSource.ts";
import type { IndexEntry } from "../src/replay/data.ts";

const index = (JSON.parse(readFileSync("public/voyages/index.json", "utf8")) as { voyages: IndexEntry[] }).voyages;

test("You is the default; a link can open the card with the autopilot picked", () => {
  assert.deepEqual(whoFromUrl(""), { who: "you", day: "2020-06-01" });
  assert.deepEqual(whoFromUrl("?who=autopilot"), { who: "autopilot", day: "2020-06-01" });
  assert.deepEqual(whoFromUrl("?who=autopilot&day=2020-04-15"), { who: "autopilot", day: "2020-04-15" });
  assert.deepEqual(whoFromUrl("?who=robot&day=tomorrow"), { who: "you", day: "2020-06-01" });
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
