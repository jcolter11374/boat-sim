import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HelmGame } from "../src/helm/game.ts";
import { WATCH_DEFAULT_DAY, WatchSource, cutAt, pickVoyage, statusAt, watchBase, watchName, watchWorker } from "../src/helm/watchSource.ts";
import { lastHour, type IndexEntry, type Replay } from "../src/replay/data.ts";

const rep = JSON.parse(readFileSync("public/voyages/voyage_2020-06-01.json", "utf8")) as Replay;
const index = (JSON.parse(readFileSync("public/voyages/index.json", "utf8")) as { voyages: IndexEntry[] }).voyages;

test("a watched voyage never shows what's ahead: rows and events stop at the clock's hour", () => {
  const cut = cutAt(rep, 48);
  assert.ok(lastHour(cut) <= 48 && lastHour(cut) > 46);
  assert.equal(cut.lat.length, cut.h.length);
  assert.ok(cut.events.every((e) => e.h <= 48));
  assert.equal(cut.outcome, "at_sea", "the ending isn't told before the end");
  assert.equal(cut.end, null);
  assert.equal(cut.t_start_line, null, "she crosses the start line on day 6, not yet");
  assert.equal(cutAt(rep, 24 * 7).t_start_line, rep.t_start_line);
  assert.equal(cutAt(rep, 1e9), rep, "at the end it's the whole voyage");
});

test("the status at an hour is the recorded row: place, speed, weather, and the way to go", () => {
  const st = statusAt(rep, 100.167);
  assert.equal(st.day, 100.167 / 24);
  assert.equal(st.over, false);
  assert.equal(st.boat.lat, rep.lat[100]);
  assert.equal(st.boat.stw, rep.stw[100]);
  assert.equal(st.weather!.hs, rep.hs[100]);
  assert.ok(st.boat.km_to_finish > 3000 && st.boat.km_to_finish < 5300);
  assert.equal(st.boat.t.slice(0, 13), "2020-06-05T16");
  const end = statusAt(rep, 1e9);
  assert.equal(end.over, true);
  assert.equal(end.boat.outcome, "arrived");
  assert.equal(end.boat.km_to_finish, 0);
});

test("run sails on by the hours asked, and only ever stops for time or the end", () => {
  const s = new WatchSource(rep);
  assert.equal(s.start().status.day, 0);
  const a = s.run(6);
  assert.equal(a.stopped, "time");
  assert.equal(a.status.day, 0.25);
  assert.ok(lastHour(a.boat) <= 6);
  const z = s.run(1e6);
  assert.equal(z.stopped, "over");
  assert.equal(z.boat, rep);
  assert.equal(s.info.hours, lastHour(rep));
  assert.equal(s.seek(240).status.day, 10);
});

test("the helm's own game talks to it: start, run, an order refused, the ending", async () => {
  let info = null as null | { name: string; hours: number };
  const game = new HelmGame("", () => watchWorker(async () => rep, (i) => (info = i)));
  await game.warm();
  const st = await game.start(0, false, false);
  assert.equal(st.day, 0);
  assert.equal(game.boatBase, "");
  assert.equal(game.ghost, null, "no second boat in a watched voyage");
  assert.equal(info!.name, "Our kayak");
  assert.equal((await game.order(90, 1)).accepted, false);
  assert.equal(await game.run({ hours: 24 }), "time");
  assert.equal(game.status!.day, 1);
  assert.ok(lastHour(game.boat!) <= 24);
  assert.deepEqual(await game.forecast(), []);
  assert.equal(await game.preview(90, 1), null);
  assert.equal(await game.run({ hours: 24 * 400 }), "over");
  const card = await game.result();
  assert.equal(card.boat.outcome, "arrived");
  assert.equal(card.margin_days, null);
});

test("a file that won't load is an error the page can show, and can be tried again", async () => {
  let n = 0;
  const game = new HelmGame("", () =>
    watchWorker(async () => {
      if (n++ === 0) throw new Error("voyage.json: 404");
      return rep;
    }),
  );
  await assert.rejects(game.start(0, false, false), /404/);
  assert.equal((await game.start(0, false, false)).day, 0);
});

test("which voyage a link asks for: the default stays 1 June 2020, our kayak", () => {
  assert.equal(WATCH_DEFAULT_DAY, "2020-06-01");
  assert.equal(pickVoyage("", index)!.file, "voyage_2020-06-01.json");
  assert.equal(pickVoyage("2020-04-15", index)!.file, "voyage_2020-04-15.json");
  assert.equal(pickVoyage("voyage_31-ft-cruiser_2020-04-01.json", index)!.boat, "31 ft cruiser");
  assert.equal(pickVoyage("../../etc/passwd", index)!.file, "voyage_2020-06-01.json", "only files the index names");
  assert.equal(pickVoyage("", []), null);
});

test("the boat a recorded voyage is drawn as, and a Randolph boat is always our model (B2)", () => {
  assert.equal(watchBase("v4 kayak"), "");
  assert.equal(watchBase("Randolph Rev B"), "revb");
  assert.equal(watchBase("Randolph Rev C"), "revc");
  assert.equal(watchBase("31 ft cruiser"), "stock_cruiser31");
  assert.match(watchName("Randolph Rev C"), /\(our model\)$/);
  assert.match(watchName("Randolph Rev B"), /\(our model\)$/);
  assert.equal(watchName("v4 kayak"), "Our kayak");
  assert.equal(watchName("31 ft cruiser"), "31 ft cruiser");
});
