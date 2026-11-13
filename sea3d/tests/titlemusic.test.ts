// The title's air (titleMusic.ts): its notes, its form and its levels, checked without audio. Hana, 13 Nov 2026.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHIME_SCALE, LEVELS } from "../src/titleSound.ts";
import { BAR, BEAT, BEATS_PER_BAR, BPM, CYCLE_BARS, FORM, MODE, MUSIC_LEVELS, PAD, PARTIAL_CEILING_HZ, THEME, THEME_BARS, barNotes, harmonicsUnder, hzOf } from "../src/titleMusic.ts";

const inMode = (midi: number) => MODE.includes(((midi % 12) + 12) % 12);

test("the air is sixteen slow bars of three, every note in D Dorian, starting and ending on D", () => {
  assert.ok(BPM <= 60, "slow");
  assert.equal(THEME.reduce((a, [, beats]) => a + beats, 0), THEME_BARS * BEATS_PER_BAR);
  for (const [midi] of THEME) assert.ok(inMode(midi), `note ${midi} is outside the mode`);
  assert.equal(THEME[0][0] % 12, 2);
  assert.equal(THEME[THEME.length - 1][0] % 12, 2);
  // A singable compass (a ninth), no leap wider than a fifth, and no note tied across a bar.
  const notes = THEME.map(([m]) => m);
  assert.ok(Math.max(...notes) - Math.min(...notes) <= 14);
  for (let i = 1; i < notes.length; i++) assert.ok(Math.abs(notes[i] - notes[i - 1]) <= 7, `leap at note ${i}`);
  let beat = 0;
  for (const [, beats] of THEME) {
    assert.ok((beat % BEATS_PER_BAR) + beats <= BEATS_PER_BAR, `a note runs over the bar line at beat ${beat}`);
    beat += beats;
  }
});

test("the pad is open fifths in the mode, one per bar, home at both ends", () => {
  assert.equal(PAD.length, THEME_BARS);
  for (const [root, fifth] of PAD) {
    assert.equal(fifth - root, 7);
    assert.ok(inMode(root) && inMode(fifth));
  }
  assert.equal(PAD[0][0] % 12, 2);
  assert.equal(PAD[THEME_BARS - 1][0] % 12, 2);
});

test("it agrees with the menu's chime: every chime note is in the air's mode", () => {
  for (const hz of CHIME_SCALE) {
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    assert.ok(Math.abs(hzOf(midi) - hz) < 0.5 && inMode(midi), `chime ${hz}`);
  }
});

test("no partial of any note is above the ceiling", () => {
  assert.ok(PARTIAL_CEILING_HZ <= 2000);
  for (let bar = 0; bar < CYCLE_BARS; bar++) {
    for (const n of barNotes(bar)) {
      const k = harmonicsUnder(n.hz);
      assert.ok(k >= 1 && n.hz * k <= PARTIAL_CEILING_HZ, `${n.voice} ${n.hz.toFixed(0)} Hz x ${k}`);
      assert.ok(n.hz > 30 && n.hz < 700, `${n.voice} at ${n.hz.toFixed(0)} Hz`);
    }
  }
  assert.equal(harmonicsUnder(5000), 1);
});

test("the form: the pad alone, the tune over the pad, then the sea alone for nearly as long; and round again", () => {
  assert.equal(CYCLE_BARS, FORM.reduce((a, s) => a + s.bars, 0));
  const lead = FORM[0].bars;
  for (let bar = 0; bar < lead; bar++) {
    const n = barNotes(bar);
    assert.ok(n.length > 0 && n.every((x) => x.voice === "pad"), `bar ${bar}: the pad alone`);
  }
  let plucked = 0;
  for (let bar = lead; bar < lead + THEME_BARS; bar++) {
    const n = barNotes(bar);
    assert.ok(n.some((x) => x.voice === "pad") && n.some((x) => x.voice === "pluck"), `bar ${bar}: tune and pad`);
    for (const x of n) assert.ok(x.at >= 0 && x.at < BAR && x.level > 0 && x.level <= 1);
    plucked += n.filter((x) => x.voice === "pluck").length;
  }
  assert.equal(plucked, THEME.length, "every note of the air, once");
  const rest = CYCLE_BARS - lead - THEME_BARS;
  for (let bar = lead + THEME_BARS; bar < CYCLE_BARS; bar++) assert.equal(barNotes(bar).length, 0, `bar ${bar}: the sea alone`);
  assert.ok(rest * BAR >= 30, `the sea has ${(rest * BAR).toFixed(0)} s to itself`);
  assert.deepEqual(barNotes(CYCLE_BARS + 3), barNotes(3), "it comes round again");
  assert.deepEqual(barNotes(-CYCLE_BARS + 3), barNotes(3));
  // Sparse: under one and a half plucked notes a second while the tune plays.
  assert.ok(THEME.length / (THEME_BARS * BAR) < 1.5);
  assert.ok(Math.abs(BAR - BEAT * 3) < 1e-9);
});

test("quiet: a plucked note is no louder than the far bell buoy; the pad far below", () => {
  assert.ok(MUSIC_LEVELS.pluck <= 0.012 && MUSIC_LEVELS.pluck <= LEVELS.buoy * 1.1);
  assert.ok(MUSIC_LEVELS.pad <= MUSIC_LEVELS.pluck / 3);
});
