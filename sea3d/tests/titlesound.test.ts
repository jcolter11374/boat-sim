// What the title plays, when, and how loud (titleSound.ts): checked without audio. Hana, 13 Nov 2026.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beaufort, mixFor, seeded } from "../src/sound.ts";
import { BUOY_HZ, BUOY_PARTIALS, CHIME_SCALE, GAPS, LEVELS, TITLE_WEATHER, TONAL_CEILING_HZ, buoyStrikes, chimeParts, creakPlan, gullCalls, startsAtFirstTouch, timeline } from "../src/titleSound.ts";

test("the title's sea is a gentle one: a light breeze, no whitecaps, no slamming, no rain", () => {
  const f = beaufort(TITLE_WEATHER.wind);
  assert.ok(f > 2 && f < 3.5, `force ${f.toFixed(1)}`);
  const m = mixFor(TITLE_WEATHER, "small");
  assert.ok(m.wash > 0 && m.hull > 0, "the wash and the hull's lap are there");
  assert.equal(m.rain, 0);
  assert.equal(m.slam, 0);
  assert.ok(m.breaksPerSec < 0.2, `whitecaps ${m.breaksPerSec}`);
});

test("the title's sounds are sparse: a handful a minute, never crowding, the first within 10 s", () => {
  for (const seed of [1, 7, 42, 2026, 99999]) {
    const ev = timeline(seed, 300);
    const perMin = ev.length / 5;
    assert.ok(perMin >= 4 && perMin <= 11, `seed ${seed}: ${perMin} a minute`);
    assert.ok(ev[0].t <= 10, `seed ${seed}: first sound at ${ev[0].t} s`);
    for (const kind of ["buoy", "creak", "gull"] as const) {
      const ts = ev.filter((e) => e.kind === kind).map((e) => e.t);
      assert.ok(ts.length >= 3, `seed ${seed}: ${kind} came ${ts.length} times in 5 minutes`);
      assert.ok(ts[0] >= GAPS[kind].first[0] && ts[0] <= GAPS[kind].first[1] + 0.1, `seed ${seed}: first ${kind} at ${ts[0]}`);
      for (let i = 1; i < ts.length; i++) {
        const gap = ts[i] - ts[i - 1];
        assert.ok(gap >= GAPS[kind].gap[0] - 0.1 && gap <= GAPS[kind].gap[1] + 0.1, `seed ${seed}: ${kind} gap ${gap.toFixed(1)} s`);
      }
    }
    // Gulls are the rarest, the buoy the commonest.
    const count = (k: string) => ev.filter((e) => e.kind === k).length;
    assert.ok(count("gull") < count("buoy"), `seed ${seed}: more gulls than bells`);
  }
});

test("the same seed gives the same title; another seed, another", () => {
  assert.deepEqual(timeline(5, 120), timeline(5, 120));
  assert.notDeepEqual(timeline(5, 120), timeline(6, 120));
});

test("nothing tonal above 2 kHz: bell partials, gull cries, the rope's ring, menu chimes", () => {
  for (const [k] of BUOY_PARTIALS) assert.ok(BUOY_HZ * k * 1.002 < TONAL_CEILING_HZ, `bell partial ${BUOY_HZ * k}`);
  const rnd = seeded(3);
  for (let i = 0; i < 200; i++) {
    for (const c of gullCalls(rnd)) for (const hz of c.hz) assert.ok(hz > 500 && hz < TONAL_CEILING_HZ, `gull ${hz}`);
    const p = creakPlan(rnd);
    for (const hz of p.ring) assert.ok(hz < TONAL_CEILING_HZ, `rope ring ${hz}`);
    assert.ok(p.hz[0] >= 40 && p.hz[1] <= 120 && p.hz[1] > p.hz[0], `rope rasp ${p.hz}`);
  }
  for (let i = -3; i < 12; i++) for (const press of [false, true]) for (const [hz] of chimeParts(i, press)) assert.ok(hz > 200 && hz < TONAL_CEILING_HZ, `chime ${hz}`);
});

test("the buoy rings one to three uneven strikes; a gull cries once long, then short ones stepping down", () => {
  const rnd = seeded(11);
  const counts = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const s = buoyStrikes(rnd);
    counts.add(s.length);
    assert.ok(s.length >= 1 && s.length <= 3);
    assert.equal(s[0].delay, 0);
    for (let j = 1; j < s.length; j++) assert.ok(s[j].delay - s[j - 1].delay >= 0.5, "strikes don't pile up");
    for (const x of s) assert.ok(x.level > 0.4 && x.level <= 1);
    const g = gullCalls(rnd);
    assert.ok(g.length >= 2 && g.length <= 4);
    assert.ok(g[0].dur >= 0.5 && g[1].dur < 0.3, "one long cry, then short ones");
    for (let j = 1; j < g.length; j++) {
      assert.ok(g[j].delay >= g[j - 1].delay + g[j - 1].dur, "cries don't overlap");
      assert.ok(g[j].hz[1] < g[j - 1].hz[1], "stepping down");
      assert.ok(g[j].hz[1] > g[j].hz[0] && g[j].hz[1] > g[j].hz[2], "each rises then falls");
    }
    const p = creakPlan(rnd);
    assert.ok(p.pulls.length >= 2 && p.pulls.length <= 4);
    const end = p.pulls[p.pulls.length - 1];
    assert.ok(end.at + end.len < 2.2, "a creak is short");
  }
  assert.deepEqual([...counts].sort(), [1, 2, 3]);
});

test("the menu's chime: each choice its own note from a five-note scale; a press is fuller and louder, both quiet", () => {
  const notes = [0, 1, 2, 3, 4].map((i) => chimeParts(i, false)[0][0]);
  assert.deepEqual(notes, CHIME_SCALE);
  assert.equal(chimeParts(5, false)[0][0], CHIME_SCALE[0], "wraps round");
  assert.equal(chimeParts(-1, false)[0][0], CHIME_SCALE[4]);
  for (let i = 1; i < CHIME_SCALE.length; i++) assert.ok(CHIME_SCALE[i] / CHIME_SCALE[i - 1] > 1.1, "no half steps");
  assert.ok(chimeParts(0, true).length > chimeParts(0, false).length);
  assert.ok(LEVELS.press > LEVELS.hover);
  // Quiet: every level is under the ship's bell on the helm (0.018) except the rope, whose
  // narrow filters pass only a little of it.
  for (const k of ["buoy", "gull", "hover", "press"] as const) assert.ok(LEVELS[k] < 0.018, k);
  assert.ok(LEVELS.creak <= 0.06);
});

test("the first click or key starts the sound, unless it's playing or the visitor turned it off", () => {
  assert.equal(startsAtFirstTouch(false, false), true);
  assert.equal(startsAtFirstTouch(true, false), false);
  assert.equal(startsAtFirstTouch(false, true), false, "turned off before: it stays off");
});
