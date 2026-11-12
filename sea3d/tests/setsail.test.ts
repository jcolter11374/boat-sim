import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SET_SAIL, LAUNCH, SET_SAIL, fromUrl, implied, toUrl, withChoices } from "../src/helm/setsail.ts";

test("old links still land: ?practice is Annapolis practice, ?challenge=x is that challenge", () => {
  assert.equal(fromUrl("?practice").where, "annapolis");
  assert.equal(fromUrl("?practice&challenge=sandys-shadow").challenge, "", "practice has no challenge");
  const c = fromUrl("?challenge=sandys-shadow");
  assert.equal(c.where, "ocean");
  assert.equal(c.challenge, "sandys-shadow");
  assert.deepEqual(fromUrl(""), DEFAULT_SET_SAIL);
});

test("the card's choices go through the URL and back", () => {
  for (const s of [
    { ...DEFAULT_SET_SAIL, when: "rough" as const },
    { ...DEFAULT_SET_SAIL, challenge: "sandys-shadow" },
    { ...DEFAULT_SET_SAIL, where: "annapolis" as const, course: "light" as const, breeze: "fresh" as const },
    { ...DEFAULT_SET_SAIL, boat: "stock_pearson31_2" },
  ])
    assert.deepEqual(fromUrl(toUrl(s).replace(/^helm\.html/, "")), s);
  assert.equal(toUrl(DEFAULT_SET_SAIL), "helm.html");
  assert.match(toUrl(DEFAULT_SET_SAIL, true), /go=1/);
});

test("nonsense in the URL falls back to the defaults", () => {
  const s = fromUrl("?where=moon&when=stormy&course=loop&breeze=gale");
  assert.equal(s.where, "ocean");
  assert.equal(s.when, "calm");
  assert.equal(s.breeze, "good");
});

test("swapping choices into a URL keeps its other switches (quality, hour)", () => {
  const q = withChoices("?quality=low&practice&hour=21", { ...DEFAULT_SET_SAIL, where: "annapolis", course: "triangle" }, true);
  const p = new URLSearchParams(q);
  assert.equal(p.get("quality"), "low");
  assert.equal(p.get("hour"), "21");
  assert.equal(p.get("where"), "annapolis");
  assert.equal(p.has("practice"), false);
  assert.equal(p.get("go"), "1");
});

test("calm and rough stay the dates on John's open list: 23 April and 1 April 2020", () => {
  assert.equal(LAUNCH.calm, "2020-04-23");
  assert.equal(LAUNCH.rough, "0"); // the odds launch with index 0, 1 April 2020
  assert.ok(SET_SAIL.when.find((w) => w.key === "rough")!.sub.includes("1 April 2020"));
});

test("a challenge brings its own day, and Annapolis has courses instead of a start", () => {
  assert.equal(implied({ ...DEFAULT_SET_SAIL, challenge: "sandys-shadow" }).whenShown, false);
  assert.equal(implied(DEFAULT_SET_SAIL).whenShown, true);
  assert.deepEqual(implied({ ...DEFAULT_SET_SAIL, where: "annapolis" }), { whenShown: false, boatShown: false, courseShown: true });
});
