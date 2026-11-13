import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HelmGame } from "../src/helm/game.ts";
import { raceBase, raceCard, raceName, racePick, raceStatus, raceWorker, type RaceCard, type RaceInfo, type RaceStatus } from "../src/helm/raceSource.ts";
import { cutAt } from "../src/helm/watchSource.ts";
import type { Replay } from "../src/replay/data.ts";

const repA = JSON.parse(readFileSync("public/voyages/voyage_2020-04-01.json", "utf8")) as Replay;
const repB = JSON.parse(readFileSync("public/voyages/voyage_randolph-rev-c_2020-04-01.json", "utf8")) as Replay;

const boat = (name: string, km: number, outcome = "at_sea") => ({ name, build: name, t: "2020-04-02T12:00", lat: 37, lon: -70, heading: 80, stw: 1.5, soc: 0.8, km_to_finish: km, outcome, breakdowns: [], weather: { wind_u: 3, wind_v: 4, hs: 2 } });
const status = (day: number, over = false): RaceStatus => ({ launch: "2020-04-01T12:00", day, over, boats: [boat("Our kayak", 5000), boat("Randolph Rev C", 5100)], lead_km: 100, leader: 0 });
const card: RaceCard = { launch: "2020-04-01T12:00", seed: 7, breakdowns_on: true, boats: [{ name: "Our kayak", build: "k", outcome: "arrived", days: 67.1, battery_low: 0.2, breakdowns: [] }, { name: "Randolph Rev C", build: "c", outcome: "timeout", days: 150, battery_low: 0.5, breakdowns: ["capsize"] }], verdict: "only_one_finished", winner: 0, margin_days: null, words: "Our kayak finished; Randolph Rev C didn't (timeout).", breakdowns_differ: true };

/** A stand-in for the race's own worker: answers as src/race/worker.ts does, and keeps what it was asked. */
function fakeRace(seen: Record<string, unknown>[], replays = true) {
  let day = 0;
  const w = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    onerror: null,
    postMessage(m: Record<string, unknown>) {
      seen.push(m);
      const reps = replays && m.replays ? [cutAt(repA, day * 24), cutAt(repB, day * 24)] : null;
      let value: unknown = null;
      if (m.type === "new") value = { launches: ["2020-04-01T12:00"], status: status(0), track: [], replays: reps };
      else if (m.type === "run") {
        day += (m.hours as number) / 24;
        value = { stopped: "time", status: status(day, day >= 3), track: [], replays: replays && m.replays ? [cutAt(repA, day * 24), cutAt(repB, day * 24)] : null };
      } else if (m.type === "result") value = { card, status: status(150, true), track: [], replays: reps };
      queueMicrotask(() => {
        if (m.type === "new") w.onmessage?.({ data: { type: "progress", text: "Getting both boats ready..." } } as MessageEvent);
        w.onmessage?.({ data: { id: m.id, ok: true, value } } as MessageEvent);
      });
    },
    terminate() {},
  };
  return w as unknown as Worker;
}

test("a race plays through the helm's own game: boat A is the boat, boat B the second track", async () => {
  const seen: Record<string, unknown>[] = [];
  let info: RaceInfo | null = null;
  const said: string[] = [];
  const game = new HelmGame("base/", () => raceWorker(() => fakeRace(seen), { a: {}, b: { base: "revc" }, launch: 2, breakdowns: true }, (i) => (info = i)));
  game.onProgress = (t) => said.push(t);
  await game.warm();
  const st = await game.start(0, false, false);
  assert.deepEqual(seen[1], { id: seen[1].id, base: "base/", type: "new", a: {}, b: { base: "revc" }, launch: 2, breakdowns: true, drop: "same", replays: true });
  assert.equal(st.lead_km, 100);
  assert.equal(st.ghost.km_to_finish, 5100);
  assert.equal(game.boatBase, "");
  assert.deepEqual(info!.names, ["Our kayak", "Randolph Rev C5 (our model)"]);
  assert.deepEqual(info!.bases, ["", "revc"]);
  assert.deepEqual(said, ["Getting both boats ready..."]);
  assert.equal(game.ghost!.boat, "Randolph Rev C5 (our model)", "the second track carries its (our model) name (B2)");
  assert.equal(await game.run({ hours: 24, breakdown: true }), "time");
  assert.equal((seen.at(-1) as { hours: number }).hours, 24);
  assert.equal(game.status!.day, 1);
  assert.ok(game.boat!.h.length > 20 && game.ghost!.h.length > 20);
  assert.equal(await game.run({ hours: 48 }), "over");
  assert.equal((await game.order(90, 1).catch((e) => String(e))).toString().includes("nobody steers"), true);
  assert.deepEqual(await game.forecast(), []);
  const c = (await game.result()) as ReturnType<typeof raceCard>;
  assert.equal(c.verdict, "won");
  assert.equal(c.race.words, card.words);
  assert.equal(c.ghost.outcome, "timeout");
});

test("a simulator too old to hand over both voyages says so, as NO_RACE", async () => {
  const game = new HelmGame("", () => raceWorker(() => fakeRace([], false), { a: {}, b: { base: "revc" }, launch: 0, breakdowns: true }));
  await assert.rejects(game.start(0, false, false), /NO_RACE/);
});

test("the race's status and card in the helm's shapes", () => {
  const st = raceStatus(status(2), null);
  assert.equal(st.day, 2);
  assert.equal(st.boat.heading, 80);
  assert.equal(st.weather!.tp, 0, "weather the race leaves out is 0, not missing");
  assert.equal(st.sailing, undefined);
  assert.equal(raceCard({ ...card, winner: 1 }).verdict, "lost");
  assert.equal(raceCard({ ...card, winner: null, verdict: "draw" }).verdict, "draw");
  assert.equal(raceCard({ ...card, winner: null, verdict: "neither_finished" }).verdict, "neither_finished");
});

test("which race a link asks for: only known boats, and a safe default", () => {
  assert.deepEqual(racePick("kayak,revb", "3", null), { a: {}, b: { base: "revb" }, launch: 3, breakdowns: true });
  assert.deepEqual(racePick("", null, null), { a: {}, b: { base: "revc" }, launch: 0, breakdowns: true });
  assert.deepEqual(racePick("", null, { base: "revc", rudder: "single" }).a, { base: "revc", rudder: "single" }, "my boat is boat A when there is one");
  assert.deepEqual(racePick("revc", null, null), { a: { base: "revc" }, b: {}, launch: 0, breakdowns: true }, "never a boat against itself by default");
  assert.deepEqual(racePick("<script>,../x", "99", null), { a: {}, b: { base: "revc" }, launch: 0, breakdowns: true });
  assert.equal(raceBase({}), "");
  assert.equal(raceBase({ base: "kayak" }), "");
  assert.equal(raceBase({ base: "stock_cruiser31" }), "stock_cruiser31");
});

test("a Randolph boat is always named as our model (B2), once", () => {
  assert.equal(raceName("Randolph Rev C"), "Randolph Rev C5 (our model)");
  assert.equal(raceName("Randolph Rev B, custom"), "Randolph Rev B, custom (our model)");
  assert.equal(raceName("Randolph Rev C5 (our model)"), "Randolph Rev C5 (our model)");
  assert.equal(raceName("Our kayak"), "Our kayak");
});
