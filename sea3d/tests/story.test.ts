// Checks for the launch-day game's story beats (src/replay/story.ts), on the
// real replay files in public/voyages.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import type { Replay } from "../src/replay/data";
import { guessVerdict, outcomeLine, storyBeats } from "../src/replay/story";

const DIR = "public/voyages";
const files = readdirSync(DIR).filter((f) => /^voyage_.*\.json$/.test(f));
const load = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")) as Replay;

test("every voyage has a story that starts with the launch and runs in order", () => {
  assert.ok(files.length > 0);
  for (const f of files) {
    const rep = load(f);
    const beats = storyBeats(rep);
    assert.equal(beats[0].kind, "launch", f);
    for (let i = 1; i < beats.length; i++) assert.ok(beats[i].h >= beats[i - 1].h, `${f}: beats out of order`);
    assert.ok(beats.length <= 14, `${f}: ${beats.length} beats is too many to sit through`);
    assert.ok(beats.filter((b) => b.kind === "storm").length <= 3, `${f}: too many storm stops`);
    for (const b of beats) assert.ok(b.h <= rep.h[rep.h.length - 1] + 1e-9, `${f}: beat after the end`);
  }
});

test("the words stay plain: no sailing or simulator jargon", () => {
  const jargon = /\b(Hs|knockdown|thruster|starboard|port side|electronics_|iridium|SOC|stw|capsize|leak_)\b/i;
  for (const f of files) {
    const rep = load(f);
    for (const b of storyBeats(rep)) assert.ok(!jargon.test(b.title + " " + b.text), `${f}: "${b.text}"`);
    assert.ok(!jargon.test(outcomeLine(rep)), `${f}: "${outcomeLine(rep)}"`);
  }
});

test("a voyage that finishes passes halfway, and the radio going quiet gets a stop", () => {
  for (const f of files) {
    const rep = load(f);
    const kinds = storyBeats(rep).map((b) => b.kind);
    if (rep.outcome === "arrived") {
      assert.ok(kinds.includes("halfway"), `${f}: no halfway`);
      assert.ok(kinds.includes("near"), `${f}: no last stretch`);
    }
    if (rep.outcome === "disqualified") assert.ok(kinds.includes("quiet") || kinds.includes("silent"), `${f}: no quiet beat`);
  }
});

test("parts that break together make one stop; the Randolph boat is always our model", () => {
  const both = load("voyage_2020-05-01.json"); // both computer boxes fail in the same hour
  assert.equal(storyBeats(both).filter((b) => b.kind === "broke").length, 1);
  for (const f of files.filter((x) => x.includes("randolph"))) {
    assert.match(storyBeats(load(f))[0].text, /^Our model of the Randolph boat/);
  }
});

test("the guess is scored against the outcome", () => {
  const done = load("voyage_2020-04-15.json");
  const lost = load("voyage_2020-05-01.json");
  assert.equal(guessVerdict(done, true).right, true);
  assert.equal(guessVerdict(done, false).right, false);
  assert.equal(guessVerdict(lost, false).right, true);
  assert.equal(guessVerdict(lost, true).text, "You said it would make it, but it didn't.");
  // 58 days since #285 (a late route no longer sends the boat back for a waypoint it has passed); 70 before.
  assert.match(outcomeLine(done), /^Made it to the finish off Portugal in 58 days\.$/);
});
