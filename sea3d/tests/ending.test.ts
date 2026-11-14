import assert from "node:assert/strict";
import { test } from "node:test";
import { raceCardLink, watchCardLink, waysOn, type EndMode } from "../src/helm/ending";

const ids = (w: { id: string }[]) => w.map((x) => x.id);

test("every ending opens with its own Play again and keeps the four ways on in one order", () => {
  const order = ["again", "follow", "sail", "boat", "race", "board"];
  for (const mode of ["crossing", "challenge", "watch", "race"] as EndMode[]) {
    const { main } = waysOn(mode, { search: "", build: "kayak_v4", followName: "Rev C5", sailHref: "helm.html?who=you", rival: "revc" });
    assert.equal(main[0].id, "again", mode);
    assert.ok(main.some((w) => w.id === "board"), `${mode} has the leaderboard`);
    const at = ids(main).map((id) => order.indexOf(id));
    assert.deepEqual(at, [...at].sort((a, b) => a - b), `${mode}: ${ids(main)}`);
  }
  assert.deepEqual(ids(waysOn("crossing", { search: "" }).main), ["again", "boat", "race", "board"]);
});

test("Play again is worded for the mode", () => {
  const word = (m: EndMode) => waysOn(m, { search: "" }).main[0].label;
  assert.deepEqual((["crossing", "challenge", "watch", "race"] as EndMode[]).map(word), ["Play again", "Try again", "Watch again", "Race again"]);
});

test("no way on leads to the old race or replay pages", () => {
  for (const mode of ["crossing", "challenge", "watch", "race"] as EndMode[]) {
    const w = waysOn(mode, { search: "?quality=low", build: "x", sailHref: "helm.html?who=you", canLook: true });
    for (const x of [...w.main, ...w.quiet]) assert.ok(!/race\.html|voyage\.html/.test(x.href ?? ""), `${mode} ${x.id}: ${x.href}`);
  }
});

test("Race it opens the Set sail card with the autopilot and another boat, on the same day", () => {
  const race = (raceId?: string | null) => waysOn("crossing", { search: "?quality=low&sail=1", raceId, day: "2020-06-01T12:00:00Z" }).main.find((w) => w.id === "race");
  assert.equal(race("kayak")!.href, "./helm.html?who=autopilot&against=revc&day=2020-06-01&quality=low");
  assert.equal(race(undefined)!.href, race("kayak")!.href, "no boat named: our kayak");
  assert.match(race("revc")!.href!, /against=kayak/, "the Rev C5 can't race herself");
  assert.match(race("mine")!.href!, /against=revc/);
  assert.equal(race(null), undefined, "a boat the race can't run has no Race it");
});

test("a race has no Race it: Change the boats goes back to the card with the same rival", () => {
  const w = waysOn("race", { search: "?race=kayak,revb&launch=2&quality=low", rival: "revb", followName: "Rev B" });
  assert.deepEqual(ids(w.main), ["again", "follow", "boat", "board"]);
  assert.equal(w.main[1].label, "Follow Rev B to the end");
  assert.equal(w.main[2].label, "Change the boats");
  assert.equal(w.main[2].href, "./helm.html?quality=low&who=autopilot&against=revb");
  assert.deepEqual(ids(waysOn("race", { search: "" }).main), ["again", "boat", "board"], "nobody left to follow");
});

test("a challenge keeps its own day: no other launch day, no race", () => {
  const w = waysOn("challenge", { search: "", build: "kayak_v4", boatyard: "./boatyard.html#base=revc" });
  assert.deepEqual(ids(w.main), ["again", "boat", "board"]);
  assert.equal(w.main[1].href, "./boatyard.html#base=revc");
  assert.equal(w.main[2].href, "./leaderboard.html#challenges", "the weather challenges' own tab (W5)");
  assert.equal(waysOn("crossing", { search: "", build: "kayak v4" }).main[3].href, "./leaderboard.html#kayak%20v4");
  assert.deepEqual(w.quiet, []);
});

test("a watched voyage offers to sail it, race it, save a postcard and look around", () => {
  const w = waysOn("watch", { search: "?watch=2020-06-01", sailHref: "helm.html?who=you&day=2020-06-01", day: "2020-06-01", canLook: true });
  assert.deepEqual(ids(w.main), ["again", "sail", "race", "board"]);
  assert.deepEqual(ids(w.quiet), ["postcard", "look"]);
  assert.equal(w.main[2].href, "./helm.html?who=autopilot&against=revc&day=2020-06-01");
});

test("the card links keep the page's switches and drop the card's own picks", () => {
  assert.equal(raceCardLink("?quality=low&who=you&against=revb&race=kayak,revc&launch=3", "nonsense"), "./helm.html?quality=low&who=autopilot&against=revc");
  assert.equal(watchCardLink("?quality=low&sail=1", "2020-04-23"), "./helm.html?quality=low&who=autopilot&day=2020-04-23");
  assert.equal(watchCardLink("", "not a day"), "./helm.html?who=autopilot");
});

test("practice: the course again, another course, and the ocean crossing; no race or board (one practice yacht)", () => {
  const w = waysOn("practice", { search: "?practice", again: "Race your best run" });
  assert.deepEqual(w.main.map((x) => x.label), ["Race your best run", "Another course"]);
  assert.deepEqual(w.quiet.map((x) => [x.label, x.href]), [["Sail across the Atlantic", "./helm.html"]]);
  assert.deepEqual(ids(waysOn("practice", { search: "" }).main), ["course"], "a drill has no course to sail again");
});
