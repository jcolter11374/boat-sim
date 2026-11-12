import { test } from "node:test";
import assert from "node:assert/strict";
import { boardDay, nextLinks, ordinal, standing, standingText, type Board, type Grid } from "../src/results";

const row = (design: string, finish_rate: number, tier: number) => ({
  tier,
  design,
  label: design,
  finish_rate,
  ci95: [finish_rate - 0.1, finish_rate + 0.1] as [number, number],
  launches: 65,
});
const board = (fair = true, extra: Partial<Board["board"]> = {}): Board => ({
  board: { launch_set: "2015-2019 every 7 days", made: "2026-11-11T20:15Z", sha: "abc1234", ...extra },
  summary: { fair, rows: [row("k-p25", 0.8, 1), row("revc", 0.74, 1), row("revb", 0.74, 2), row("k-p10", 0.5, 3)] },
});
const grid: Grid = {
  odds_source: { years: [2012, 2021] },
  builds: [
    { id: "k-p25", label: "kayak", odds: { voyages: 100, finished: 78, odds: 0.78, low95: 0.69, high95: 0.85 } },
    { id: "k-p15", label: "kayak 15 W", odds: { voyages: 100, finished: 69, odds: 0.69, low95: 0.6, high95: 0.77 } },
    { id: "k-p20", label: "no odds yet" },
  ],
};

test("a build on a fair board: the group leads, the place is only 'by finish rate'", () => {
  const s = standing("revb", board(), grid);
  assert.equal(s.kind, "board");
  if (s.kind !== "board") return;
  assert.deepEqual([s.rank, s.of, s.tier, s.tiers, s.inTier], [2, 4, 2, 3, 1]);
  const c = standing("revc", board(), grid);
  assert.equal(c.kind === "board" ? c.rank : 0, 2); // same rate as revb: same place
  const t = standingText(s);
  assert.equal(t.head, "On the board of 11 Nov: in the 2nd of 3 groups, on its own there. It finishes 74% of 65 launches.");
  assert.equal(t.detail, "2nd of 4 by finish rate. Likely range 64% to 84%.");
  const top = standingText(standing("revc", board(), grid));
  assert.equal(top.head, "On the board of 11 Nov: in the top of 3 groups, with 1 other build it can't be told apart from. It finishes 74% of 65 launches.");
  assert.doesNotMatch(top.head, /\d(st|nd|rd|th) of \d/); // no place in the headline
});

test("one group only: no place at all", () => {
  const b = board();
  b.summary!.rows = b.summary!.rows.map((r) => ({ ...r, tier: 1 }));
  const t = standingText(standing("k-p10", b, grid));
  assert.equal(t.head, "On the board of 11 Nov: all 4 builds are in one group, which these launches can't tell apart. It finishes 50% of 65 launches.");
  assert.doesNotMatch(t.head + t.detail, /\d(st|nd|rd|th)/);
});

test("a board without its date just says \"On the leaderboard\" (older files)", () => {
  const b = board(true, { made: undefined, sha: undefined });
  assert.match(standingText(standing("revb", b, grid)).head, /^On the leaderboard: in the 2nd of 3 groups/);
  assert.equal(boardDay("2026-01-05T00:10Z"), "5 Jan");
  assert.equal(boardDay("garbage"), null);
  assert.equal(boardDay("2026-13-01T00:00Z"), null);
  assert.equal(boardDay(null), null);
});

test("the sample board is never used for a place", () => {
  assert.equal(standing("revb", board(true, { sample: true }), grid).kind, "none");
  assert.equal(standing("k-p25", board(true, { sample: true }), grid).kind, "odds");
});

test("the board wins over the Boatyard's odds when the build is on both", () => {
  assert.equal(standing("k-p25", board(), grid).kind, "board");
});

test("an unfair board is never used for a place", () => {
  const s = standing("revb", board(false), grid);
  assert.equal(s.kind, "none");
  assert.equal(standing("k-p25", board(false), grid).kind, "odds");
});

test("off the board: the Boatyard's odds, with no place (another launch set)", () => {
  const s = standing("k-p15", board(), grid);
  assert.equal(s.kind, "odds");
  const t = standingText(s);
  assert.equal(t.head, "Not on the leaderboard yet. The simulator gives it 69% over 100 launches (2012 to 2021).");
  assert.doesNotMatch(t.head + t.detail, /\d(st|nd|rd|th) of/);
  assert.equal(standing("k-p15", null, grid).kind, "odds");
});

test("no board and no odds: says so; a grid build without odds doesn't count", () => {
  assert.equal(standing("k-p20", board(), grid).kind, "none");
  assert.equal(standing("anything", null, null).kind, "none");
  assert.equal(standingText({ kind: "none" }).head, "No odds for this build yet.");
});

test("odds without the years still read cleanly", () => {
  const t = standingText(standing("k-p15", null, { builds: grid.builds }));
  assert.equal(t.head, "Not on the leaderboard yet. The simulator gives it 69% over 100 launches.");
});

test("ordinals", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"]);
});

test("the ways on: back to the Boatyard, race it, the build's leaderboard row", () => {
  assert.deepEqual(nextLinks("revc-drive.wing"), [
    { label: "Back to the Boatyard", href: "./boatyard.html" },
    { label: "Race it", href: "./race.html" },
    { label: "Leaderboard", href: "./leaderboard.html#revc-drive.wing" },
  ]);
  assert.equal(nextLinks("k-p25", "./boatyard.html#base=revc&rudder=single")[0].href, "./boatyard.html#base=revc&rudder=single");
});
