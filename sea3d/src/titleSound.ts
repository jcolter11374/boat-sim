/**
 * What the title screen sounds like (Hana, 13 Nov 2026; John: "music and sound effects on
 * the title screen, nautical like"). On top of the sea itself (sound.ts, for the hero's
 * gentle sea): a bell buoy somewhere off in the haze; a rope creaking as she rolls if she
 * has sails, or water lapping her hull if she hasn't (our kayak has motors and no rigging);
 * and a soft chime when a menu choice is touched or chosen. Sparse and quiet: the sea is
 * the main thing, and a minute has a handful of these, never on a beat.
 *
 * A far gull is written but off (Elena, 13 Nov: nobody on the team can listen, a made-up
 * gull is the likeliest to sound like a toy, and it says harbour, not open water).
 * `?gulls=1` turns it on for whoever can hear it.
 *
 * Everything is made in code (oscillators and the sea's noise loops): no sound files, nothing
 * bought. Nothing tonal sits above about 2 kHz, as in sound.ts, so it can't grate. Real gulls
 * and bells are higher; these are far off, heard through the air and off the water.
 *
 * What plays when and how loud is decided by pure functions (tested without audio); the
 * class renders offline for review clips (tools/title-sound-render.mjs), since nobody on the
 * team can listen.
 */
import { seeded, type OceanSound, type SeaWeather } from "./sound";

/** Nothing tonal above this (Hz), partials included. */
export const TONAL_CEILING_HZ = 2000;

/**
 * The hero's sea as the sound hears it: a light breeze (force 3) over the title's 0.8 m
 * swell, the boat ambling, the camera a chase boat's length or two away.
 */
export const TITLE_WEATHER: SeaWeather = { wind: 4.2, hs: 0.8, tp: 6.5, rain: 0, near: 9, stw: 0.6 };

export type TitleEventKind = "buoy" | "creak" | "lap" | "gull";

/** What the title is showing and allowing: read each time a sound comes due, so it follows a change of boat. */
export interface TitleScene {
  /** The boat has sails and ropes (they creak); without, the water laps her hull instead. */
  sails: boolean;
  /** The far gull is allowed (off unless asked for). */
  gulls: boolean;
}

/**
 * How often each sound comes (seconds): the first one after `first`, then a gap in `gap`,
 * both picked evenly at random. The buoy rings when a bigger swell rocks it; the rope creaks
 * (or the water laps) on some rolls, not all; gulls are rare.
 */
export const GAPS: Record<"buoy" | "creak" | "gull", { first: [number, number]; gap: [number, number] }> = {
  buoy: { first: [4, 9], gap: [11, 24] },
  creak: { first: [8, 15], gap: [14, 30] },
  gull: { first: [13, 22], gap: [28, 65] },
};

/** Peak levels (linear, before the master): all well under the sea's own events. */
export const LEVELS = { buoy: 0.011, creak: 0.05, lap: 0.07, gull: 0.008, hover: 0.006, press: 0.008 } as const;

const pick = (rnd: () => number, [lo, hi]: [number, number]) => lo + rnd() * (hi - lo);

/** Hands out the sounds that have come due as the title's clock runs. */
export class TitleTimeline {
  private next: Record<"buoy" | "creak" | "gull", number>;
  constructor(private rnd: () => number, private scene: TitleScene = { sails: false, gulls: false }) {
    this.next = { buoy: pick(rnd, GAPS.buoy.first), creak: pick(rnd, GAPS.creak.first), gull: pick(rnd, GAPS.gull.first) };
  }
  /** The kinds due at title time t (s), each then put off by its next gap. */
  due(t: number): TitleEventKind[] {
    const out: TitleEventKind[] = [];
    for (const k of ["buoy", "creak", "gull"] as const) {
      if (t >= this.next[k]) {
        // The roll that would creak a rope laps water on a boat without one; a gull that
        // isn't allowed stays silent (its turn still passes, so turning it on later is smooth).
        if (k === "creak") out.push(this.scene.sails ? "creak" : "lap");
        else if (k !== "gull" || this.scene.gulls) out.push(k);
        this.next[k] = t + pick(this.rnd, GAPS[k].gap);
      }
    }
    return out;
  }
}

/** Every sound in the first `seconds` of a title visit with this seed (for tests and reviews). */
export function timeline(seed: number, seconds: number, scene: TitleScene = { sails: false, gulls: false }, step = 1 / 30): { t: number; kind: TitleEventKind }[] {
  const line = new TitleTimeline(seeded(seed), scene);
  const out: { t: number; kind: TitleEventKind }[] = [];
  for (let t = step; t <= seconds; t += step) for (const kind of line.due(t)) out.push({ t: +t.toFixed(3), kind });
  return out;
}

/** The buoy's bell: strike note (Hz) and its partials [ratio, level, ring-out s]: hum, strike, minor third, fifth, octave, one above. */
export const BUOY_HZ = 392;
export const BUOY_PARTIALS: [number, number, number][] = [[0.5, 0.4, 5], [1, 1, 4], [1.183, 0.5, 3], [1.506, 0.35, 2.4], [2, 0.25, 1.7], [2.514, 0.12, 1.1]];

/**
 * One rocking of the buoy: the clapper lands one to three times, unevenly (it swings with
 * the swell, not a hand), each a different weight.
 */
export function buoyStrikes(rnd: () => number): { delay: number; level: number }[] {
  const n = 1 + Math.floor(rnd() * 3);
  const out: { delay: number; level: number }[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    out.push({ delay: +t.toFixed(3), level: +(0.45 + 0.55 * rnd()).toFixed(3) });
    t += 0.55 + rnd() * 1.1;
  }
  return out;
}

/**
 * A gull far off: one long falling cry, then one to three short ones stepping down. Each
 * call slides up to its peak and falls away: [start, peak, end] Hz, all under the ceiling.
 */
export function gullCalls(rnd: () => number): { delay: number; dur: number; hz: [number, number, number]; level: number }[] {
  const out: { delay: number; dur: number; hz: [number, number, number]; level: number }[] = [];
  const top = 1500 + rnd() * 250;
  out.push({ delay: 0, dur: 0.5 + rnd() * 0.2, hz: [1000 + rnd() * 150, top, 900 + rnd() * 100], level: 1 });
  const n = 1 + Math.floor(rnd() * 3);
  let t = out[0].dur + 0.12 + rnd() * 0.1;
  for (let i = 0; i < n; i++) {
    const peak = top * (0.94 - 0.05 * i);
    const dur = 0.2 + rnd() * 0.08;
    out.push({ delay: +t.toFixed(3), dur: +dur.toFixed(3), hz: [peak * 0.72, peak, peak * 0.66], level: +(0.8 - 0.15 * i).toFixed(3) });
    t += dur + 0.07 + rnd() * 0.08;
  }
  return out;
}

/**
 * A rope taking the strain as she rolls: a low rasp (the fibres sticking and slipping, `hz`
 * from..to) heard through the rope's own ring (`ring` Hz), in two to four short pulls.
 */
export function creakPlan(rnd: () => number): { hz: [number, number]; ring: [number, number]; pulls: { at: number; len: number; level: number }[] } {
  const from = 48 + rnd() * 20;
  const pulls: { at: number; len: number; level: number }[] = [];
  const n = 2 + Math.floor(rnd() * 3);
  let t = 0;
  for (let i = 0; i < n; i++) {
    const len = 0.12 + rnd() * 0.22;
    pulls.push({ at: +t.toFixed(3), len: +len.toFixed(3), level: +(0.5 + 0.5 * rnd()).toFixed(3) });
    t += len + 0.05 + rnd() * 0.14;
  }
  return { hz: [from, from * (1.25 + rnd() * 0.3)], ring: [560 + rnd() * 180, 1050 + rnd() * 250], pulls };
}

/**
 * Water lapping the hull as she rolls: two or three soft slaps of water, each a little
 * different in weight and colour (`hz`: where its body sits).
 */
export function lapPlan(rnd: () => number): { at: number; hz: number; level: number }[] {
  const n = 2 + Math.floor(rnd() * 2);
  const out: { at: number; hz: number; level: number }[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    out.push({ at: +t.toFixed(3), hz: Math.round(380 + rnd() * 320), level: +(0.55 + 0.45 * rnd()).toFixed(3) });
    t += 0.28 + rnd() * 0.3;
  }
  return out;
}

/** The menu's notes: a five-note sea-song scale on D (no half steps, so any order sits well). */
export const CHIME_SCALE = [587.33, 659.26, 783.99, 880, 987.77];

/**
 * A menu choice's chime: its note by its place in the menu, with a soft octave below; a
 * press adds the fifth above, like a small bell. [Hz, level] pairs, all under the ceiling.
 */
export function chimeParts(index: number, press: boolean): [number, number][] {
  const n = CHIME_SCALE.length;
  const f = CHIME_SCALE[((Math.floor(index) % n) + n) % n];
  const parts: [number, number][] = [[f, 1], [f / 2, 0.35]];
  if (press && f * 1.5 < TONAL_CEILING_HZ) parts.push([f * 1.5, 0.3]);
  return parts;
}

/**
 * Whether the title's sound starts at this click or key: yes unless it's already playing or
 * the visitor has turned sound off (now or on an earlier visit). Never on page load: the
 * page only asks this from a click or a key.
 */
export function startsAtFirstTouch(on: boolean, muted: boolean): boolean {
  return !on && !muted;
}

type Bus = NonNullable<ReturnType<OceanSound["bus"]>>;

export class TitleSound {
  private line: TitleTimeline;
  private rnd: () => number;
  private t = 0;
  private lastHover = -1;
  /** What the title is showing (the page sets `sails` when the boat changes) and allowing. */
  readonly scene: TitleScene = { sails: false, gulls: false };

  /** sea: the page's OceanSound (this plays through its master). seed: for review renders. */
  constructor(private sea: OceanSound, seed?: number) {
    this.rnd = seed != null ? seeded(seed) : Math.random;
    this.line = new TitleTimeline(this.rnd, this.scene);
  }

  /** Every frame while the title is up: the sea for the hero's weather, and whatever has come due. */
  update(dt: number): void {
    const bus = this.sea.bus();
    if (!bus) return;
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
    this.sea.update(dt, TITLE_WEATHER);
    this.t += dt;
    for (const kind of this.line.due(this.t)) this.play(kind);
  }

  /** Play one of the title's sounds now (the timeline calls this; so do the review renders). */
  play(kind: TitleEventKind): void {
    const bus = this.sea.bus();
    if (!bus) return;
    this.sea.note(kind);
    if (kind === "buoy") this.buoy(bus);
    else if (kind === "creak") this.creak(bus);
    else if (kind === "lap") this.lap(bus);
    else this.gull(bus);
  }

  /** A menu choice touched (soft, short) or chosen (a small bell). index: its place in the menu. */
  chime(index: number, press = false): void {
    const bus = this.sea.bus();
    if (!bus) return;
    const { ctx } = bus;
    const t = ctx.currentTime;
    // Sweeping the pointer down the menu plays a few notes, not a rattle.
    if (!press && t - this.lastHover < 0.09) return;
    if (!press) this.lastHover = t;
    else this.sea.note("chime");
    const out = ctx.createGain();
    out.gain.value = press ? LEVELS.press : LEVELS.hover;
    out.connect(bus.out);
    if (press) out.connect(bus.far);
    const ring = press ? 1.3 : 0.4;
    for (const [hz, a] of chimeParts(index, press)) {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(a, t + 0.012); // a soft mallet, no click
      g.gain.setTargetAtTime(0, t + 0.012, ring / 4);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + ring * 1.6);
    }
  }

  private buoy(bus: Bus): void {
    const { ctx } = bus;
    // Far off: mostly heard off the water (the echo send), dulled by the air.
    const air = ctx.createBiquadFilter();
    air.type = "lowpass";
    air.frequency.value = 1500;
    const near = ctx.createGain();
    near.gain.value = 0.5;
    air.connect(near).connect(bus.out);
    air.connect(bus.far);
    for (const s of buoyStrikes(this.rnd)) {
      const t = ctx.currentTime + s.delay;
      const out = ctx.createGain();
      out.gain.value = LEVELS.buoy * s.level;
      out.connect(air);
      for (const [k, a, len] of BUOY_PARTIALS) {
        const o = ctx.createOscillator();
        o.frequency.value = BUOY_HZ * k * (1 + (this.rnd() - 0.5) * 0.003);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(a, t + 0.008);
        g.gain.setTargetAtTime(0, t + 0.008, len / 4);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + len * 1.6);
      }
    }
  }

  private lap(bus: Bus): void {
    const { ctx } = bus;
    for (const l of lapPlan(this.rnd)) {
      const t = ctx.currentTime + l.at;
      // A slap of water: a short swell of noise around a few hundred Hz, with a darker tail.
      const src = ctx.createBufferSource();
      src.buffer = bus.noise.white;
      src.playbackRate.value = 0.7 + this.rnd() * 0.5;
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.setValueAtTime(l.hz, t);
      f.frequency.exponentialRampToValueAtTime(l.hz * 0.6, t + 0.4);
      f.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(LEVELS.lap * l.level, t + 0.035);
      g.gain.setTargetAtTime(0, t + 0.035, 0.09);
      src.connect(f).connect(g).connect(bus.out);
      src.start(t, this.rnd() * 5);
      src.stop(t + 0.7);
    }
  }

  private gull(bus: Bus): void {
    const { ctx } = bus;
    const air = ctx.createBiquadFilter();
    air.type = "lowpass";
    air.frequency.value = 1900;
    air.Q.value = 0.5;
    const near = ctx.createGain();
    near.gain.value = 0.6;
    air.connect(near).connect(bus.out);
    air.connect(bus.far);
    for (const c of gullCalls(this.rnd)) {
      const t = ctx.currentTime + c.delay;
      const o = ctx.createOscillator();
      // A plain tone with a quick waver in it (a far gull's cry has lost its edge on the way);
      // any reedier wave would put overtones above the ceiling.
      const waver = ctx.createOscillator();
      waver.frequency.value = 26 + this.rnd() * 8;
      const depth = ctx.createGain();
      depth.gain.value = 28;
      waver.connect(depth).connect(o.frequency);
      waver.start(t);
      waver.stop(t + c.dur + 0.05);
      o.frequency.setValueAtTime(c.hz[0], t);
      o.frequency.linearRampToValueAtTime(c.hz[1], t + c.dur * 0.3);
      o.frequency.exponentialRampToValueAtTime(c.hz[2], t + c.dur);
      const g = ctx.createGain();
      const peak = LEVELS.gull * c.level;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + c.dur * 0.25);
      g.gain.setValueAtTime(peak, t + c.dur * 0.55);
      g.gain.linearRampToValueAtTime(0, t + c.dur);
      o.connect(g).connect(air);
      o.start(t);
      o.stop(t + c.dur + 0.05);
    }
  }

  private creak(bus: Bus): void {
    const { ctx } = bus;
    const p = creakPlan(this.rnd);
    const t0 = ctx.currentTime;
    const end = p.pulls[p.pulls.length - 1];
    const total = end.at + end.len;
    // Stick and slip: a slow sawtooth is a train of little snaps; the rope's own ring (two
    // narrow bands) turns them into a creak that bends as the strain comes on.
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(p.hz[0], t0);
    o.frequency.linearRampToValueAtTime(p.hz[1], t0 + total);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    for (const pull of p.pulls) {
      const a = t0 + pull.at;
      g.gain.setValueAtTime(0, a);
      g.gain.linearRampToValueAtTime(LEVELS.creak * pull.level, a + pull.len * 0.4);
      g.gain.linearRampToValueAtTime(0, a + pull.len);
    }
    for (const hz of p.ring) {
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = hz;
      f.Q.value = 7;
      o.connect(f).connect(g);
    }
    const top = ctx.createBiquadFilter(); // the rasp's upper snaps stay under the ceiling
    top.type = "lowpass";
    top.frequency.value = 1700;
    g.connect(top).connect(bus.out);
    o.start(t0);
    o.stop(t0 + total + 0.05);
  }
}
