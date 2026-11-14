import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HelmGame } from "../src/helm/game.ts";
import { raceBase, raceCard, raceGone, raceHeadline, raceLabel, raceName, racePick, raceStatus, raceWorker, seasonCell, seasonWords, swapSides, type RaceCard, type SeasonVerdict, type RaceCardBoat, type RaceInfo, type RaceStatus } from "../src/helm/raceSource.ts";
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
      else if (m.type === "season_launch") value = { a: { start: "2020-04-01T12:00", seed: 1, outcome: "arrived", days: 61.4 }, b: { start: "2020-04-01T12:00", seed: 1, outcome: "sunk", days: 9 } };
      else if (m.type === "season_verdict") value = { finished: [1, 0] };
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

// ---- the ending's words (Elena's list)
const cardOf = (a: Partial<RaceCardBoat>, b: Partial<RaceCardBoat>, rest: Partial<RaceCard> = {}): RaceCard => ({
  launch: "2020-05-01T12:00",
  boats: [
    { name: "Our kayak", outcome: "arrived", days: 70, battery_low: 0.3, breakdowns: [], ...a },
    { name: "Randolph Rev B", outcome: "arrived", days: 60, battery_low: 0.3, breakdowns: [], ...b },
  ],
  verdict: "",
  winner: null,
  margin_days: null,
  words: "",
  breakdowns_differ: false,
  ...rest,
});
const NAMES: [string, string] = ["Our kayak", "Randolph Rev B (our model)"];

test("a race's headline gives the most important fact first, and the time limit is not a result", () => {
  const lostAndOut = cardOf({ outcome: "lost", days: 3.9 }, { outcome: "timeout", days: 150 });
  assert.equal(raceHeadline(lostAndOut, NAMES), "Our kayak was lost on day 3.9. Randolph Rev B (our model) was still at sea after 150 days.");
  assert.equal(raceLabel(lostAndOut.boats[1], "Randolph Rev B"), "Randolph Rev B: still at sea after 150 days");
  assert.equal(raceLabel(lostAndOut.boats[0], "Our kayak"), "Our kayak: lost on day 3.9");
  // The lost boat is the news even when she is boat B.
  assert.equal(raceHeadline(cardOf({ outcome: "timeout", days: 150 }, { outcome: "sunk", days: 12.4 }), NAMES), "Randolph Rev B (our model) sank on day 12.4. Our kayak was still at sea after 150 days.");
  assert.equal(raceHeadline(cardOf({}, {}, { winner: 1, margin_days: -10 }), NAMES), "Randolph Rev B (our model) finished first, 10.0 days ahead.");
  assert.equal(raceHeadline(cardOf({}, { outcome: "lost", days: 20.2 }, { winner: 0 }), NAMES), "Our kayak finished in 70.0 days. Randolph Rev B (our model) was lost on day 20.2.");
  assert.equal(raceHeadline(cardOf({}, {}, { verdict: "draw" }), NAMES), "A draw: both finished within a day of each other.");
});

test("when your boat is lost and the other sails on, the ending tells only her fate, and she is not drawn sailing", () => {
  const c = cardOf({ outcome: "lost", days: 3.9 }, { outcome: "timeout", days: 150 });
  assert.equal(raceHeadline(c, NAMES, 0), "Our kayak was lost on day 3.9.");
  assert.equal(raceGone(c.boats[0]), true);
  assert.equal(raceGone(c.boats[1]), false, "still at sea is not gone");
  assert.equal(raceGone(cardOf({}, {}).boats[0]), false);
});

test("following the other boat swaps the sides once, even when the page's two statuses are the one object", () => {
  const mk = () => ({ boat: { soc: 0.1 }, ghost: { soc: 0.9 }, lead_km: -2585 }) as unknown as Parameters<typeof swapSides>[0] & { boat: { soc: number }; ghost: { soc: number }; lead_km: number };
  const st = mk();
  swapSides(st, st);
  assert.equal(st.boat.soc, 0.9);
  assert.equal(st.ghost.soc, 0.1);
  assert.equal(st.lead_km, 2585);
  const a = mk();
  const b = mk();
  swapSides(a, b, null);
  assert.equal(a.boat.soc, 0.9);
  assert.equal(b.boat.soc, 0.9);
});

test("Race all 6 launch days: the season's two asks pass through a race untouched", async () => {
  const seen: Record<string, unknown>[] = [];
  const game = new HelmGame("base/", () => raceWorker(() => fakeRace(seen), { a: {}, b: { base: "revc" }, launch: 0, breakdowns: true }));
  await game.start(0, false, false);
  const r = await game.raceSeasonLaunch<{ a: { outcome: string }; b: { outcome: string } }>(3);
  assert.deepEqual(seen.at(-1), { id: seen.at(-1)!.id, base: "base/", type: "season_launch", i: 3 });
  assert.equal(r.a.outcome, "arrived");
  assert.equal(r.b.outcome, "sunk");
  assert.deepEqual(await game.raceSeasonVerdict(), { finished: [1, 0] });
  assert.equal(seen.at(-1)!.type, "season_verdict");
});

const verdict = (a_only: number, b_only: number, clear: boolean): SeasonVerdict => ({
  launches: Array.from({ length: 6 }, () => ({ launch: "2020-04-01T12:00", a: { outcome: "arrived", days: 60 }, b: { outcome: "sunk", days: 9 } })),
  finished: [4, 2],
  pair: { n: 6, a_only, b_only, clear, gap: (a_only - b_only) / 6 },
});
const NAMES2: [string, string] = ["Our kayak", "Randolph Rev C5 (our model)"];

test("the season in plain words: a clear winner, too close to call, or no difference; full names (B2)", () => {
  const [fin, clear] = seasonWords(verdict(4, 0, true), NAMES2);
  assert.equal(fin, "Finished: Our kayak 4 of 6 launch days, Randolph Rev C5 (our model) 2 of 6.");
  assert.equal(clear, "Our kayak is the better boat this spring: she finished on 4 launch days where Randolph Rev C5 (our model) didn't, and Randolph Rev C5 (our model) on 0 where she didn't.");
  assert.match(seasonWords(verdict(0, 3, true), NAMES2)[1], /^Randolph Rev C5 \(our model\) is the better boat/);
  assert.match(seasonWords(verdict(2, 1, false), NAMES2)[1], /^Too close to call: Our kayak finished on 2 launch days where .* on 1 where she didn't\. 6 days is a small sample/);
  assert.match(seasonWords(verdict(1, 1, false), NAMES2)[1], /1 launch day where/);
  assert.match(seasonWords(verdict(0, 0, false), NAMES2)[1], /^Every launch day ended the same way for both/);
  for (const line of seasonWords(verdict(2, 1, false), NAMES2)) assert.doesNotMatch(line, /p =|95%|sign test/, "no statistics on the card");
});

test("a season cell: days for a finish, the fate otherwise", () => {
  assert.equal(seasonCell({ outcome: "arrived", days: 61.4 }), "finished, 61 days");
  assert.equal(seasonCell({ outcome: "sunk", days: 9 }), "sank");
  assert.equal(seasonCell({ outcome: "timeout", days: 150 }), "still at sea");
  assert.equal(seasonCell({ outcome: "left_data_box" }), "sailed off the edge of our weather map");
});
