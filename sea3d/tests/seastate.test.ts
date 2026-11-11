// Checks for the real wave systems (seastate.ts) and the mixed sea (waves.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { FILL, SeaStateFeed, SeaStateMonth, TP_PER_TM01, gunzip, type SeaStateHeader } from "../src/seastate";
import { MAX_GPU_WAVES, MixedSea, SWELL, Sea, WIND_SEA, drawnTpPerTm01, hsOf } from "../src/waves";

const NAMES = ["ws_hs", "ws_tm", "ws_dir", "s1_hs", "s1_tm", "s1_dir", "s2_hs", "s2_tm", "s2_dir"];
const SCALES = [0.01, 0.01, 0.1, 0.01, 0.01, 0.1, 0.01, 0.01, 0.1];

/** A 2-step, 2 x 3 month: lat 40-41, lon -60..-58. fill(k, i, j) gives the nine values (or null = land). */
function month(fill: (k: number, i: number, j: number) => (number | null)[] | null): { h: SeaStateHeader; data: Int16Array } {
  const h: SeaStateHeader = {
    month: "2020-05",
    t0: "2020-05-01T00:00Z",
    step_h: 3,
    nt: 2,
    lat0: 40,
    lon0: -60,
    res: 1,
    nlat: 2,
    nlon: 3,
    fields: NAMES.map((name, n) => ({ name, scale: SCALES[n] })),
  };
  const data = new Int16Array(2 * 9 * 2 * 3);
  for (let k = 0; k < 2; k++)
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 3; j++) {
        const v = fill(k, i, j);
        for (let f = 0; f < 9; f++) {
          const x = v ? v[f] : null;
          data[((k * 9 + f) * 2 + i) * 3 + j] = x == null ? FILL : Math.round(x / SCALES[f]);
        }
      }
  return { h, data };
}
const T0 = Date.parse("2020-05-01T00:00Z");

test("a grid point reads back exactly, with Tp from Tm01", () => {
  const { h, data } = month(() => [1.2, 4, 225, 2.0, 10, 90, 0.5, 14, 350]);
  const m = new SeaStateMonth(h, data);
  const s = m.at(T0, 40, -59)!;
  assert.ok(Math.abs(s.ws!.hs - 1.2) < 1e-9);
  assert.ok(Math.abs(s.ws!.tp - 4 * TP_PER_TM01.windSea) < 1e-9);
  assert.ok(Math.abs(s.s1!.tp - 10 * TP_PER_TM01.swell) < 1e-9);
  assert.ok(Math.abs(s.s1!.dirFrom - 90) < 1e-6);
  assert.ok(Math.abs(s.s2!.dirFrom - 350) < 1e-6);
});

test("between points and steps: energy blends, directions wrap through north", () => {
  const { h, data } = month((k, _i, j) => [1 + k, 5, 0, 2, 10, j === 0 ? 350 : 10, 0, 0, 0]);
  const m = new SeaStateMonth(h, data);
  const s = m.at(T0 + 1.5 * 3.6e6, 40, -59.5)!; // halfway in time and between lon -60 and -59
  assert.ok(Math.abs(s.ws!.hs - Math.sqrt((1 + 4) / 2)) < 1e-9, "heights blend as energy");
  const d = s.s1!.dirFrom;
  assert.ok(d < 1e-6 || d > 360 - 1e-6, `350 and 10 average to north, got ${d}`);
  assert.equal(s.s2, null, "a zero-height system is absent");
});

test("land corners drop out; all land is null; a missing system is height 0", () => {
  const { h, data } = month((_k, _i, j) =>
    j === 0 ? null : j === 1 ? [1, 5, 180, 2, 10, 90, null, null, null] : [1, 5, 180, 2, 10, 90, 1, 12, 0],
  );
  const m = new SeaStateMonth(h, data);
  const half = m.at(T0, 40, -59.5)!; // between land (-60) and sea (-59)
  assert.ok(Math.abs(half.ws!.hs - 1) < 1e-9, "land doesn't drag the height down");
  assert.equal(m.at(T0, 40, -60), null);
  const mid = m.at(T0, 40, -58.5)!; // s2 missing at -59, 1 m at -58
  assert.ok(Math.abs(mid.s2!.hs - Math.sqrt(0.5)) < 1e-9);
  assert.equal(m.at(T0, 39, -59), null, "outside the grid");
});

test("the feed loads a gzipped month and answers once it is in", async () => {
  const { h, data } = month(() => [1, 5, 180, 2, 10, 90, 0, 0, 0]);
  const files: Record<string, BodyInit> = {
    "s/seastate_index.json": JSON.stringify({ months: ["2020-05"] }),
    "s/seastate_2020-05.json": JSON.stringify(h),
    "s/seastate_2020-05.bin.gz": gzipSync(Buffer.from(data.buffer)),
  };
  const feed = new SeaStateFeed("s/", async (u) => (u in files ? new Response(files[u]) : new Response("", { status: 404 })));
  assert.equal(await feed.init(), true);
  let loaded = false;
  feed.onLoad = () => (loaded = true);
  const t = new Date(T0);
  assert.equal(feed.at(t, 40.5, -59), null, "first ask starts the load");
  for (let i = 0; i < 50 && !loaded; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(loaded);
  assert.ok(Math.abs(feed.at(t, 40.5, -59)!.s1!.hs - 2) < 1e-9);
  assert.equal(feed.at(new Date("2020-07-01T00:00Z"), 40.5, -59), null, "a month that isn't there");
  const none = new SeaStateFeed("x/", async () => new Response("", { status: 404 }));
  assert.equal(await none.init(), false);
  assert.equal(none.at(t, 40.5, -59), null);
});

test("gunzip passes plain bytes through", async () => {
  const b = new Uint8Array([1, 2, 3, 4]).buffer;
  assert.deepEqual(new Uint8Array(await gunzip(b)), new Uint8Array([1, 2, 3, 4]));
});

test("the mixed sea: heights add as energy, fits the shader, and the wind sea alone is the old sea", () => {
  const mix = new MixedSea(undefined, { n: 24, smoothing: 0 });
  assert.ok(mix.n <= MAX_GPU_WAVES, `${mix.n} trains`);
  mix.setSystems({ hs: 1.2, tp: 5, dirFrom: 225 }, { hs: 2, tp: 12, dirFrom: 90 }, { hs: 0.5, tp: 15, dirFrom: 0 });
  mix.snap();
  const comps = mix.advance(10);
  assert.ok(Math.abs(hsOf(comps) - Math.hypot(1.2, 2, 0.5)) < 1e-9);
  // swell crests travel the way it is going: from the east -> westward (travel ~ pi)
  const sw = comps.slice(24, 34);
  const mean = Math.atan2(
    sw.reduce((s, c) => s + Math.sin(c.direction), 0),
    sw.reduce((s, c) => s + Math.cos(c.direction), 0),
  );
  assert.ok(Math.abs(Math.abs(mean) - Math.PI) < 0.15, `swell travels west, got ${mean}`);
  // one combined sea: the swells fade (and a fresh mix's wind sea is exactly the old single Sea)
  mix.setSeaState(1.5, 7, 270);
  mix.snap();
  assert.ok(Math.abs(hsOf(mix.advance(21)) - 1.5) < 1e-9);
  const fresh = new MixedSea(undefined, { n: 24, smoothing: 0 });
  fresh.setSeaState(1.5, 7, 270);
  fresh.snap();
  const old = new Sea(undefined, { n: 24, smoothing: 0 });
  old.setSeaState(1.5, 7, 270);
  old.snap();
  assert.deepEqual(fresh.advance(20).slice(0, 24), old.advance(20));
});

test("drawn Tp / Tm01: the wind sea near JONSWAP's 1.2, the narrow swell nearer 1", () => {
  const w = drawnTpPerTm01(24, WIND_SEA);
  const s = drawnTpPerTm01(10, SWELL, 2);
  assert.ok(w > 1.1 && w < 1.3, `wind sea ${w}`);
  assert.ok(s > 1.0 && s < w, `swell ${s}`);
});
