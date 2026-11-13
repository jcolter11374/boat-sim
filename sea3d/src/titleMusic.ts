/**
 * The title's music (Hana, 13 Nov 2026; John: "music ... on the title screen, nautical
 * like"). One slow air of our own, sixteen bars in three-time in the D Dorian mode (the
 * scale many sea songs sit in: D E F G A B C; the menu's chime notes are in it too), plucked
 * like a small harp or a guitar over a soft low pad of open fifths, then left to the sea
 * for a while before it comes round again. Quieter than the sea: the sea is still the main
 * thing. (Elena, 13 Nov: plucked, not a reed. Nobody on the team can listen, and a made-up
 * reed tends to sound like a toy organ; plucked strings come out of code well.)
 *
 * The notes are ours, written here for this game. No existing shanty, tune or recording is
 * used, and there are no sound files: every voice is a few sine partials added up in code.
 * No partial of any note is above about 2 kHz (as in sound.ts), so nothing can grate.
 *
 * What plays in each bar is a pure function (barNotes), tested without audio; the class
 * renders offline for review clips (tools/title-sound-render.mjs).
 */
import type { OceanSound } from "./sound";

/** Slow: 56 beats a minute, three beats to the bar. */
export const BPM = 56;
export const BEAT = 60 / BPM;
export const BEATS_PER_BAR = 3;
export const BAR = BEAT * BEATS_PER_BAR;

/** No partial of any note above this (Hz). */
export const PARTIAL_CEILING_HZ = 1900;

/** D Dorian, as pitch classes (C = 0). */
export const MODE = [2, 4, 5, 7, 9, 11, 0];

/** The air: [MIDI note, beats]. Four four-bar phrases; 62 is the D above middle C. */
export const THEME: [number, number][] = [
  // 1: out from D, up to A, home.
  [62, 2], [65, 1], [69, 2], [67, 1], [65, 1], [64, 1], [60, 1], [62, 3],
  // 2: answers from A, a step higher, rests on A.
  [69, 2], [72, 1], [71, 2], [69, 1], [67, 1], [65, 1], [64, 1], [69, 3],
  // 3: the top of the tune, the high D, and down.
  [74, 2], [72, 1], [69, 2], [71, 1], [72, 1], [69, 1], [67, 1], [65, 2], [64, 1],
  // 4: climbs the home chord once more and settles.
  [62, 1], [65, 1], [69, 1], [67, 2], [64, 1], [60, 1], [64, 1], [62, 1], [62, 3],
];
export const THEME_BARS = 16;

/** The pad under each bar of the air: an open fifth [root, fifth] (MIDI), no thirds. */
export const PAD: [number, number][] = [
  [50, 57], [53, 60], [48, 55], [50, 57],
  [45, 52], [43, 50], [48, 55], [45, 52],
  [50, 57], [53, 60], [45, 52], [48, 55],
  [50, 57], [43, 50], [48, 55], [50, 57],
];

export type Voice = "pluck" | "pad";

/**
 * One time round: the pad alone, the air over the pad, then the sea alone for about as
 * long again. Then it starts over (about a minute and three quarters in all).
 */
export const FORM: { bars: number; tune: boolean; pad: boolean }[] = [
  { bars: 2, tune: false, pad: true },
  { bars: THEME_BARS, tune: true, pad: true },
  { bars: 14, tune: false, pad: false },
];
export const CYCLE_BARS = FORM.reduce((a, s) => a + s.bars, 0);

/** Peak level of one note of each voice (linear, before the master): together, under the sea. */
export const MUSIC_LEVELS: Record<Voice, number> = { pluck: 0.0085, pad: 0.0016 };

export const hzOf = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** How many harmonics of a note fit under the ceiling (at least the note itself). */
export function harmonicsUnder(hz: number, ceiling = PARTIAL_CEILING_HZ): number {
  return Math.max(1, Math.floor(ceiling / hz));
}

export interface MusicNote {
  voice: Voice;
  /** Start, seconds after the bar's start. */
  at: number;
  /** Length, s (a note may ring past the bar's end). */
  dur: number;
  hz: number;
  /** 0..1 of the voice's level. */
  level: number;
}

/** The air as notes with their place in its sixteen bars: [bar, beat in bar, MIDI, beats]. */
function themeByBar(): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let beat = 0;
  for (const [midi, beats] of THEME) {
    out.push([Math.floor(beat / BEATS_PER_BAR), beat % BEATS_PER_BAR, midi, beats]);
    beat += beats;
  }
  return out;
}

/** The notes that start in bar number `bar` (counted from when the music began; the form repeats). */
export function barNotes(bar: number): MusicNote[] {
  let b = ((Math.floor(bar) % CYCLE_BARS) + CYCLE_BARS) % CYCLE_BARS;
  let sec = FORM[0];
  for (const s of FORM) {
    sec = s;
    if (b < s.bars) break;
    b -= s.bars;
  }
  const out: MusicNote[] = [];
  // Before the air the pad holds the home chord; under it, the air's own chords.
  if (sec.pad) {
    const [root, fifth] = sec.tune ? PAD[b] : PAD[0];
    // Each bar's chord swells in and overlaps the next, so the pad never gaps.
    out.push({ voice: "pad", at: 0, dur: BAR * 1.25, hz: hzOf(root - 12), level: 1 });
    out.push({ voice: "pad", at: 0, dur: BAR * 1.25, hz: hzOf(fifth - 12), level: 0.7 });
    out.push({ voice: "pad", at: 0, dur: BAR * 1.25, hz: hzOf(root), level: 0.45 });
  }
  if (sec.tune) {
    for (const [nb, beat, midi, beats] of themeByBar()) {
      if (nb !== b) continue;
      // The first beat of a bar leans a little, as a player's hand would.
      out.push({ voice: "pluck", at: beat * BEAT, dur: beats * BEAT, hz: hzOf(midi), level: beat === 0 ? 1 : 0.82 });
    }
  }
  return out;
}

type Bus = NonNullable<ReturnType<OceanSound["bus"]>>;

export class TitleMusic {
  private gain: GainNode | null = null;
  private waves = new Map<string, PeriodicWave>();
  private t0 = -1;
  private nextBar = 0;
  /** Bars scheduled so far (read-only, for the checks). */
  bars = 0;
  /** Whether the music plays (the sea and its sounds carry on without it). */
  on = true;

  /** sea: the page's OceanSound (the music plays through its master, shelf and limiter). */
  constructor(private sea: OceanSound) {}

  /** Every frame while the title is up: schedules the bars that start within the next half second. */
  update(): void {
    const bus = this.sea.bus();
    if (!bus || !this.on) return;
    const { ctx } = bus;
    if (!this.gain || this.gain.context !== ctx) {
      this.gain = ctx.createGain();
      this.gain.connect(bus.out);
      this.t0 = -1;
    }
    const now = ctx.currentTime;
    // A late frame (a hidden tab, a turned-off sound) doesn't play the bars it missed all at
    // once: the music picks up at the next bar from now.
    if (this.t0 < 0 || now > this.t0 + this.nextBar * BAR + BAR) {
      const skip = this.t0 < 0 ? 0 : Math.ceil((now - this.t0) / BAR) - this.nextBar;
      if (this.t0 < 0) this.t0 = now + 2.5; // the sea is heard first, then the pad comes in
      else this.nextBar += skip;
    }
    while (this.t0 + this.nextBar * BAR < now + 0.5) {
      const start = Math.max(this.t0 + this.nextBar * BAR, now + 0.02);
      for (const n of barNotes(this.nextBar)) this.note(bus, n, start);
      if (this.nextBar % CYCLE_BARS === FORM[0].bars) this.sea.note("air");
      this.nextBar++;
      this.bars++;
    }
  }

  /** A voice's wave for a note: its harmonics up to the ceiling and no further. */
  private wave(ctx: BaseAudioContext, voice: Voice, hz: number): PeriodicWave {
    const n = Math.min(harmonicsUnder(hz), voice === "pad" ? 3 : 4);
    const key = `${voice}${n}`;
    let w = this.waves.get(key);
    if (!w) {
      const re = new Float32Array(n + 1);
      const im = new Float32Array(n + 1);
      for (let k = 1; k <= n; k++) {
        // A plucked string: the note and a few harmonics, falling away fast. The pad is
        // darker still: little more than the note itself.
        im[k] = voice === "pad" ? 1 / Math.pow(k, 2.4) : 1 / Math.pow(k, 1.7);
      }
      w = ctx.createPeriodicWave(re, im);
      this.waves.set(key, w);
    }
    return w;
  }

  private note(bus: Bus, n: MusicNote, barStart: number): void {
    const { ctx } = bus;
    const t = barStart + n.at;
    const peak = MUSIC_LEVELS[n.voice] * n.level;
    const g = ctx.createGain();
    g.connect(this.gain!);
    let end: number;
    if (n.voice === "pluck") {
      // Plucked: a quick soft start and a long fall (longer for a long note, which is left
      // to ring), with a little of it off the water.
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.006);
      g.gain.setTargetAtTime(0, t + 0.006, 0.28 + n.dur * 0.3);
      g.connect(bus.far);
      end = t + 1.4 + n.dur * 1.6;
    } else {
      // The pad: each chord swells in slowly, holds and lets go into the next.
      const a = Math.min(0.9, n.dur * 0.3);
      const r = Math.min(1.1, n.dur * 0.35);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak * 0.85, t + a);
      g.gain.linearRampToValueAtTime(peak, t + Math.max(a + 0.01, n.dur * 0.6));
      g.gain.setValueAtTime(peak, t + Math.max(a + 0.02, n.dur - r * 0.3));
      g.gain.linearRampToValueAtTime(0, t + n.dur + r * 0.7);
      end = t + n.dur + r;
    }
    // The pad is two voices a few cents apart: a slow shimmer, not a flat tone.
    for (const cents of n.voice === "pluck" ? [0] : [-4, 4]) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(this.wave(ctx, n.voice, n.hz));
      o.frequency.value = n.hz;
      o.detune.value = cents;
      o.connect(g);
      o.start(t);
      o.stop(end + 0.05);
    }
  }
}
