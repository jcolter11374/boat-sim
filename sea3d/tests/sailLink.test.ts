// The Sea page's way into the game (src/sailLink.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SEA_CHALLENGE, askedChallenge, helmHref } from "../src/sailLink";
import { SEA_STATES } from "../src/waves";

test("each sea state opens the helm in matching weather", () => {
  assert.equal(helmHref("calm"), "./helm.html?challenge=gentle-june");
  assert.equal(helmHref("gale"), "./helm.html?challenge=spring-gale");
  assert.equal(helmHref("moderate"), "./helm.html");
  assert.equal(helmHref("no-such-sea"), "./helm.html");
});

test("every sea state on the page has a mapping", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const options = [...html.matchAll(/<select id="sea">([\s\S]*?)<\/select>/g)][0][1];
  const keys = [...options.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), Object.keys(SEA_CHALLENGE).sort());
  for (const k of keys) assert.ok(k in SEA_STATES, `${k} is a sea state`);
  assert.match(html, /<a id="sail" href="\.\/helm\.html"/);
  assert.match(html, /<a id="build" href="\.\/boatyard\.html"/);
});

test("the helm takes an offered challenge from the link, and nothing else", () => {
  const offered = ["gentle-june", "spring-gale", "dorian"];
  assert.equal(askedChallenge("?challenge=spring-gale", offered, false), "spring-gale");
  assert.equal(askedChallenge("?quality=low&challenge=gentle-june", offered, false), "gentle-june");
  assert.equal(askedChallenge("?challenge=made-up", offered, false), null);
  assert.equal(askedChallenge("", offered, false), null);
  // A shared game keeps its own weather.
  assert.equal(askedChallenge("?g=abc&c=dorian&challenge=spring-gale", offered, true), null);
});

test("the mapped challenges are 2020 ones the helm can always sail", () => {
  // Gentle June and Spring gale sail on the 2020 bundle the helm already loads
  // (season: true in oceandata/challenges.py), so the link needs no extra download.
  const py = readFileSync(new URL("../../src/boatsim/oceandata/challenges.py", import.meta.url), "utf8");
  for (const id of Object.values(SEA_CHALLENGE).filter((x): x is string => !!x)) assert.ok(py.includes(`"${id}"`), `${id} is a challenge`);
});
