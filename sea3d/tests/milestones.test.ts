import { test } from "node:test";
import assert from "node:assert/strict";
import { HORTA, MilestoneWatch, TITANIC, crossingMilestones, fraction, kmBetween, milestoneNote, nextMilestone, nextWords } from "../src/helm/milestones.ts";

const FINISH: [number, number] = [39.5, -13.5];
const DROP: [number, number] = [36.65, -74.94];
const START_KM = kmBetween(DROP, FINISH) - 25;
const list = () => crossingMilestones(START_KM, FINISH, 25);

test("the crossing from the drop point passes the shelf, the Gulf Stream's end, halfway, the Azores, then the finish", () => {
  const ms = list();
  assert.deepEqual(ms.map((m) => m.id), ["shelf", "gulfstream", "half", "azores", "finish"]);
  // Each is nearer the finish than the one before, and the first is within a day's sail of the start.
  for (let k = 1; k < ms.length; k++) assert.ok(ms[k].kmToGo < ms[k - 1].kmToGo);
  assert.ok(START_KM - ms[0].kmToGo > 10 && START_KM - ms[0].kmToGo < 80, `shelf ${START_KM - ms[0].kmToGo} km out`);
  assert.equal(ms[2].kmToGo, START_KM / 2);
  // The Azores are as far from the finish as Horta is, about 1,300 km.
  assert.ok(Math.abs(ms[3].kmToGo - (kmBetween(HORTA, FINISH) - 25)) < 1e-9);
  assert.ok(ms[3].kmToGo > 1200 && ms[3].kmToGo < 1400);
  assert.equal(ms[4].kmToGo, 0);
});

test("a start further east leaves out the places already behind it; a short voyage has no strip", () => {
  const fromMidOcean = crossingMilestones(2000, FINISH, 25);
  assert.deepEqual(fromMidOcean.map((m) => m.id), ["azores", "half", "finish"]);
  assert.deepEqual(crossingMilestones(900, FINISH, 25), []);
  assert.deepEqual(crossingMilestones(Number.NaN, FINISH, 25), []);
});

test("how far along, and what comes next", () => {
  const ms = list();
  assert.equal(fraction(START_KM, START_KM), 0);
  assert.equal(fraction(START_KM, 0), 1);
  assert.equal(fraction(START_KM, START_KM * 2), 0);
  assert.equal(fraction(0, 10), 0);
  assert.equal(nextMilestone(ms, START_KM)?.id, "shelf");
  assert.equal(nextWords(ms, START_KM / 2 + 412), "Next: halfway, 412 km");
  assert.equal(nextWords(ms, START_KM / 2 + 412, true), "Next: halfway, about 412 km");
  assert.match(nextWords(ms, START_KM / 2 - 1), /^Next: the Azores, [\d,]+ km$/);
  assert.match(nextWords(ms, START_KM - 1), /^Next: off the shelf, \d+ km$/);
  assert.equal(nextWords(ms, 800), "Last leg: the finish is next");
  assert.equal(nextWords(ms, 0), "");
});

test("a milestone is passed once, in order, and never at the first look", () => {
  const ms = list();
  const w = new MilestoneWatch(ms);
  assert.deepEqual(w.see(START_KM), []);
  assert.deepEqual(w.see(START_KM - 5), []);
  assert.deepEqual(w.see(ms[0].kmToGo - 1).map((m) => m.id), ["shelf"]);
  assert.ok(w.passed(ms[0]) && !w.passed(ms[1]));
  // Blown back over it and on again: no second moment.
  assert.deepEqual(w.see(ms[0].kmToGo + 30), []);
  assert.deepEqual(w.see(ms[0].kmToGo - 2), []);
  // A long hop past two at once gives both, in order.
  assert.deepEqual(w.see(ms[2].kmToGo - 1).map((m) => m.id), ["gulfstream", "half"]);
  assert.deepEqual(w.see(Number.NaN), []);
  assert.deepEqual(w.see(0).map((m) => m.id), ["azores", "finish"]);
});

test("a voyage picked up part way is quiet about what is already behind her", () => {
  const ms = list();
  const w = new MilestoneWatch(ms);
  assert.deepEqual(w.see(ms[2].kmToGo - 300), []);
  assert.ok(w.passed(ms[0]) && w.passed(ms[1]) && w.passed(ms[2]) && !w.passed(ms[3]));
  assert.deepEqual(w.see(ms[3].kmToGo).map((m) => m.id), ["azores"]);
});

test("the notes say where the place is from the boat, in plain words, and never mention money", () => {
  const ms = list();
  const by = (id: string) => ms.find((m) => m.id === id)!;
  const half = milestoneNote(by("half"), [40, -44], START_KM)!;
  const km = Math.round(START_KM / 2).toLocaleString("en-US");
  assert.equal(half.text, `Halfway. ${km} km behind her, ${km} km to the finish.`);
  // 160 km due south of the wreck.
  const gs = milestoneNote(by("gulfstream"), [TITANIC[0] - 160 / 111.19, TITANIC[1]], START_KM)!;
  assert.match(gs.text, /The wreck of the Titanic lies about 160 km to the north\.$/);
  const az = milestoneNote(by("azores"), [41.5, -28.63], START_KM)!;
  assert.match(az.text, /^Passing the Azores\. The island of Faial is about 330 km to the south\./);
  assert.equal(milestoneNote(by("finish"), FINISH, START_KM), null);
  for (const m of ms) {
    const n = milestoneNote(m, [40, -40], START_KM);
    if (!n) continue;
    assert.ok(n.text.startsWith(n.hl), m.id);
    assert.doesNotMatch(n.text, /[$€£]|dollar|cost|price/i);
    assert.doesNotMatch(n.text, /abeam|isobath|nautical/i);
  }
});
