import { test } from "node:test";
import assert from "node:assert/strict";
import { launchSetWords, launchSetYears, sharedKayakBadges, versusWords } from "../src/boardwords";

test("launch sets in words", () => {
  assert.equal(launchSetWords("2015-2019-AprJun-every7d-v1"), "April to June launches every 7 days, 2015 to 2019");
  assert.equal(launchSetWords("2021-2021-AprJun-every7d-v1"), "April to June launches every 7 days, 2021");
  assert.equal(launchSetWords("2020-AJ-v1"), "2020-AJ-v1"); // unknown shape: as it is
  assert.equal(launchSetYears("2021-2021-AprJun-every7d-v1"), "2021");
  assert.equal(launchSetYears("2020-2021-AprJun-every7d-v1"), "2020 to 2021");
});

test("against our kayak, without statistician's notation", () => {
  const worse = versusWords({ gap: -0.17, ci95: [-0.29, -0.05], gained: 2, lost: 13, clear: true });
  assert.equal(worse.head, "Clearly worse: about 17 fewer finishes per 100 launches");
  assert.equal(worse.tone, "bad");
  assert.equal(worse.detail, "Likely range −29 to −5 finishes per 100. It finished 2 launches our kayak didn't, and missed 13 launches our kayak made.");
  const better = versusWords({ gap: 0.12, ci95: [0.03, 0.21], gained: 9, lost: 1, clear: true });
  assert.equal(better.head, "Clearly better: about 12 more finishes per 100 launches");
  assert.match(better.detail, /missed 1 launch our kayak made\.$/);
  const close = versusWords({ gap: 0.0, ci95: [-0.09, 0.09], gained: 3, lost: 3, clear: false });
  assert.equal(close.head, "About the same as our kayak on these launches");
  assert.equal(close.tone, "");
  const unsure = versusWords({ gap: -0.06, ci95: [-0.15, 0.03], gained: 2, lost: 6, clear: false });
  assert.equal(unsure.head, "Can't tell apart from our kayak on these launches: about 6 fewer per 100, which could be luck");
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
