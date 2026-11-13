import { test } from "node:test";
import assert from "node:assert/strict";
import { groupSummary, launchSetWords, launchSetYears, sharedKayakBadges, tierName, versusWords } from "../src/boardwords";

test("launch sets in words", () => {
  assert.equal(launchSetWords("2015-2019-AprJun-every7d-v1"), "April to June launches every 7 days, 2015 to 2019");
  assert.equal(launchSetWords("2021-2021-AprJun-every7d-v1"), "April to June launches every 7 days, 2021");
  assert.equal(launchSetWords("2020-AJ-v1"), "2020-AJ-v1"); // unknown shape: as it is
  assert.equal(launchSetYears("2021-2021-AprJun-every7d-v1"), "2021");
  assert.equal(launchSetYears("2020-2021-AprJun-every7d-v1"), "2020 to 2021");
});

test("against our kayak, without statistician's notation", () => {
  const worse = versusWords({ gap: -0.17, ci95: [-0.29, -0.05], gained: 2, lost: 13, clear: true });
  assert.equal(worse.head, "Clearly worse: about 17 fewer finishes per 100 launch days");
  assert.equal(worse.tone, "bad");
  assert.equal(worse.detail, "Likely range −29 to −5 finishes per 100. It finished 2 launch days our kayak didn't, and missed 13 launch days our kayak made.");
  const better = versusWords({ gap: 0.12, ci95: [0.03, 0.21], gained: 9, lost: 1, clear: true });
  assert.equal(better.head, "Clearly better: about 12 more finishes per 100 launch days");
  assert.match(better.detail, /missed 1 launch day our kayak made\.$/);
  const close = versusWords({ gap: 0.0, ci95: [-0.09, 0.09], gained: 3, lost: 3, clear: false });
  assert.equal(close.head, "About the same as our kayak on these launch days");
  assert.equal(close.tone, "");
  const unsure = versusWords({ gap: -0.06, ci95: [-0.15, 0.03], gained: 2, lost: 6, clear: false });
  assert.equal(unsure.head, "Can't tell apart from our kayak on these launch days: about 6 fewer per 100, which could be luck");
  assert.match(versusWords({ gap: 0.04, ci95: [-0.05, 0.13], gained: 5, lost: 2, clear: false }).head, /about 4 more per 100/);
  for (const w of [worse, better, close, unsure]) assert.doesNotMatch(w.head, /95%|points|\+0/);
  // A clear result's range ends round away from zero: never "−0".
  const edge = versusWords({ gap: -0.12, ci95: [-0.231, -0.004], gained: 1, lost: 9, clear: true });
  assert.match(edge.detail, /^Likely range −24 to −1 finishes per 100\./);
});

test("the kayak's length note is said once, not on every row", () => {
  const cap = "3.05 m hull: breaks the race's 2.4 m cap";
  const rows = [
    { design: "k-p25", badges: [cap] },
    { design: "k-p20", badges: [cap, "something else"] },
    { design: "revc", badges: ["our model of Randolph Rev C"] },
  ];
  assert.deepEqual(sharedKayakBadges(rows), [cap]);
  assert.deepEqual(sharedKayakBadges(rows.slice(0, 1)), []); // one kayak: nothing to fold
  assert.deepEqual(sharedKayakBadges([...rows, { design: "revb", badges: [cap] }]), []); // not kayak-only
});

test("short words in the comparison cell (Milo M8)", () => {
  assert.equal(versusWords({ gap: -0.12, ci95: [-0.23, -0.02], gained: 1, lost: 9, clear: true }).short, "Worse: 12 fewer finishes in 100");
  assert.equal(versusWords({ gap: 0.12, ci95: [0.03, 0.21], gained: 9, lost: 1, clear: true }).short, "Better: 12 more finishes in 100");
  assert.equal(versusWords({ gap: 0.02, ci95: [-0.03, 0.09], gained: 2, lost: 0, clear: false }).short, "Same as ours");
  assert.equal(versusWords({ gap: -0.06, ci95: [-0.15, 0.03], gained: 2, lost: 6, clear: false }).short, "Maybe worse (could be luck)");
});

test("groups are named and fold to one row (Milo M6, M7)", () => {
  assert.deepEqual([1, 2, 3].map((t) => tierName(t, 3)), ["Best", "Good", "Long shot"]);
  assert.deepEqual([1, 2].map((t) => tierName(t, 2)), ["Best", "Long shot"]);
  assert.equal(tierName(1, 1), "Best");
  assert.deepEqual([1, 2, 3, 4].map((t) => tierName(t, 4)), ["Best", "Good", "Good", "Long shot"]);
  for (let g = 1; g <= 6; g++) for (let t = 1; t <= g; t++) assert.doesNotMatch(tierName(t, g), /poor|bad|worst/i);
  const five = ["Our kayak", "Our kayak + wing sail and motors", "Our kayak, bigger panels and batteries", "Our kayak, motors turned up (30 W)", "Our kayak, motors turned down (20 W)"];
  assert.equal(groupSummary(five, true), "Our kayak and 4 boats just as good");
  assert.equal(groupSummary(["Randolph Rev C5, as built", "Randolph Rev B, as built"], false), "Randolph Rev C5 and Rev B");
  assert.equal(groupSummary(["A", "B", "C"], false), "A, B and C");
  assert.equal(groupSummary(five, false), "Our kayak and 4 more");
  assert.equal(groupSummary(["Our kayak"], true), "Our kayak");
  for (const best of [false]) assert.doesNotMatch(groupSummary(["Randolph Rev C5, as built", "Randolph Rev B, as built"], best), /just as good/);
});
