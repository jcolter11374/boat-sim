// The weather-challenge picker's data (helm/challenges.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleUrl, loadChallenges, startLabel, type Challenge } from "../src/helm/challenges";

const BASE = "https://example.org/boat-sim/challenges/";
const C = (id: string, n: number, season = false): Challenge => ({
  id,
  n,
  title: id,
  start: "2012-10-22T12:00:00Z",
  story: "",
  bundle: season ? "forcing_2020.npz" : `challenge_${id}.npz`,
  seed: 1,
  hurricane: false,
  season,
  weather_note: "",
  storm_boost: false,
});
const json = (body: unknown, type = "application/json") => async () => new Response(JSON.stringify(body), { headers: { "content-type": type } });

test("challenges load in list order, with the bonus last", async () => {
  const list = await loadChallenges(BASE, json({ challenges: [C("bay-mouth", 0), C("sandy", 3), C("june", 1, true)] }));
  assert.deepEqual(list.map((c) => c.id), ["june", "sandy", "bay-mouth"]);
});

test("no challenge files: an empty list, so the picker stays hidden", async () => {
  assert.deepEqual(await loadChallenges(BASE, async () => new Response("", { status: 404 })), []);
  assert.deepEqual(await loadChallenges(BASE, json("<html>", "text/html")), []); // a host's 404 page
  assert.deepEqual(await loadChallenges(BASE, async () => Promise.reject(new Error("offline"))), []);
});

test("2020 challenges reuse the Boatyard bundle; the rest name their own", () => {
  assert.equal(bundleUrl(C("june", 1, true), BASE), undefined);
  assert.equal(bundleUrl(C("sandy", 3), BASE), `${BASE}challenge_sandy.npz`);
  assert.equal(startLabel(C("sandy", 3)), "22 Oct 2012");
});
