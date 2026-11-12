/**
 * The sea you hear follows the weather (Felix, Sound, 12 Nov 2026; plan in
 * project files simulator/sound/sound-plan.md). Everything is made in code from filtered
 * noise: no sound files, nothing bought.
 *
 * Near silence in a calm, a roar at force 8 (Beaufort). Layers: wind with gusts and lulls,
 * the rigging (shrouds sing on masted boats, a small whistle on the kayak), water against
 * the hull that follows the boat's speed, the open sea's wash in sets with the swell,
 * whitecaps and breakers, rain. Sparse events: hull slaps and spray tied to the bow
 * plunging (contact.ts), a crash for a knockdown, an alarm, the finish horn.
 *
 * Rules: nothing plays until the player clicks (no autoplay); N toggles; the beds never
 * restart, so a cinematic cut doesn't jump the mix (only the hull layer hears the camera,
 * smoothed, and never drops below -12 dB); a soft high shelf and a limiter on the master,
 * and nothing tonal above about 2 kHz, so it can't grate.
 *
 * The levels are a pure function (mixFor), tested without audio; the same class renders
 * offline (tools/sound/render.mjs) for review clips, since nobody on the team can listen.
 */

export interface SeaWeather {
  /** Wind speed, m/s. */
  wind: number;
  /** Significant wave height, m. */
  hs: number;
  /** Wave period, s. */
  tp: number;
  /** Rain, 0 none .. 1 a downpour. */
  rain: number;
  /** Distance from the camera to the boat, m (the hull's sounds fade with it, a little). */
  near: number;
  /** Boat speed through the water, m/s (the hull's wash follows it). Unknown: treated as 0. */
  stw?: number;
  /**
   * Apparent wind, m/s: the wind the boat feels, its own speed added (Sam: beating to
   * windward is loud and wet, running before the same wind is quiet). The wind and rig
   * follow it; the sea (whitecaps, breakers) follows the true wind. Unknown: the true wind.
   */
  apparent?: number;
}

/** What the boat has aloft: shrouds and a mast that sing, or only a small antenna or wing. */
export type Rig = "shrouds" | "small";

/** Boats with a mast and wire stays (shrouds). The rest get the small whistle. */
export function rigFor(boatKey: string): Rig {
  return /^stock_(cruiser31|pearson31_2|dinghy14|beachcat16)$/.test(boatKey) ? "shrouds" : "small";
}

const KEY = "boatsim-sound";
/** The remembered choice; storage can be off (privacy settings, sandboxed frames), so never throw. */
function stored(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
  } catch {
    return null;
  }
}
function store(v: "on" | "off"): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* not remembered; fine */
  }
}
/** A review render (tools/sound-render.mjs), not the page's speakers. */
const offline = (c: BaseAudioContext | null) => typeof OfflineAudioContext !== "undefined" && c instanceof OfflineAudioContext;
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
/** The master level when on: the whole mix sits about -16 dBFS (RMS) at force 8 (review render). */
const LEVEL = 2;
const db = (d: number) => (d <= -90 ? 0 : Math.pow(10, d / 20));

/** Wind speed (m/s) to Beaufort force, as a smooth number (force 4 = 5.5 to 7.9 m/s). */
export function beaufort(ms: number): number {
  return Math.pow(Math.max(ms, 0) / 0.836, 2 / 3);
}

/** Piecewise-linear lookup in a table of [x, y] rows sorted by x (held flat past the ends). */
function table(rows: readonly (readonly [number, number])[], x: number): number {
  if (x <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++) {
    const [x1, y1] = rows[i];
    if (x <= x1) {
      const [x0, y0] = rows[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return rows[rows.length - 1][1];
}

// Layer levels in dB by Beaufort force (the noise sources are near full scale; the review
// render measures the whole mix: tools/sound/render.mjs). -99 is silent.
const WIND_LO: [number, number][] = [[0, -99], [0.6, -60], [1, -50], [2, -41], [3, -35], [4, -29], [5, -24], [6, -19.5], [7, -16], [8, -13], [10, -10]];
const WIND_HI: [number, number][] = [[3, -99], [3.5, -62], [4, -50], [5, -40], [6, -33], [7, -28], [8, -24], [10, -21]];
const SHROUDS: [number, number][] = [[4.5, -99], [5, -46], [6, -35], [7, -29], [8, -25], [10, -23]];
const SMALL_RIG: [number, number][] = [[5.5, -99], [6, -54], [7, -44], [8, -38], [10, -35]];
const SIZZLE: [number, number][] = [[3, -99], [3.5, -60], [4, -46], [5, -38], [6, -32], [7, -27], [8, -23], [10, -20]];
/**
 * Lift for the quiet end (Milo, 12 Nov): a true calm at -47 dBFS sounds broken on laptop
 * speakers, so the beds come up at light winds and meet the unlifted mix at force 6.
 */
const LIFT: [number, number][] = [[0, 11], [1, 11], [2, 8.8], [3, 6], [4, 3.6], [5, 1.5], [6, 0]];
/** The sea's wash by wave height (m): a lap at a calm, a heavy rush in a big sea. */
const WASH: [number, number][] = [[0, -44], [0.3, -40], [1, -33], [2, -27], [4, -21], [7, -16]];

export interface Mix {
  /** Beaufort force. */
  force: number;
  windLo: number;
  windLoHz: number;
  windHi: number;
  windHiHz: number;
  rig: number;
  rigHz: number;
  hull: number;
  hullHz: number;
  wash: number;
  washHz: number;
  sizzle: number;
  rain: number;
  /** Whitecap bursts per second near the boat. */
  breaksPerSec: number;
  /** Weight (0..1) of a hull slap, before distance. */
  slap: number;
  /** Chance a wave the boat meets ends in a slam (bow falling off a crest) with spray. */
  slam: number;
  /** Rain drops ticking on deck, per second. */
  dropsPerSec: number;
  /** Halyard taps per second (masted boats, light airs). */
  tapsPerSec: number;
  /** Chance per wave of the boom and sails slatting across as she rolls (masted, light airs). */
  slat: number;
}

/**
 * The target mix for this weather. gust: about -0.5 (a lull) .. +0.8 (a strong gust);
 * set: 0..1, where the swell is in its sets (1 the biggest waves of a set).
 */
export function mixFor(w: SeaWeather, rig: Rig, gust = 0, set = 0.5): Mix {
  const f = beaufort(w.wind); // the sea's force
  const fa = beaufort(w.apparent ?? w.wind); // the wind the boat feels
  const g = 1 + gust;
  const hs = Math.max(w.hs, 0);
  const kn = Math.max(w.stw ?? 0, 0) * 1.943844;
  const sp = clamp(kn / 7);
  const wc = clamp((f - 3) / 5); // whitecaps: first at force 3-4, everywhere by force 8
  const setK = 0.7 + 0.6 * set;
  const shrouds = rig === "shrouds";
  const lift = db(table(LIFT, Math.min(f, fa)));
  // Stopped is never silent at sea: waves chuckle against the hull, more in a swell (Sam).
  const lap = 0.1 + 0.15 * clamp(hs / 2);
  const hullK = Math.max(sp, lap);
  return {
    force: f,
    windLo: db(table(WIND_LO, fa)) * g * lift,
    windLoHz: 170 + 85 * Math.min(fa, 10) + 120 * gust,
    windHi: db(table(WIND_HI, fa)) * Math.max(g, 0) ** 1.5 * lift,
    windHiHz: Math.min(800 + 130 * fa + 250 * gust, 2200),
    // The rig sings in the gusts, not between them; soft even at force 8 (Elena).
    rig: db(table(shrouds ? SHROUDS : SMALL_RIG, fa)) * clamp(0.35 + 0.9 * gust + 0.35, 0, 1.6),
    rigHz: shrouds ? clamp(380 + 45 * (fa - 5) + 60 * gust, 330, 700) : clamp(950 + 70 * (fa - 6) + 90 * gust, 900, 1400),
    hull: db(-44 + 24 * hullK) * Math.sqrt(hullK) * (0.8 + 0.4 * set) * lift,
    hullHz: 320 + 650 * hullK + 80 * clamp(hs / 4),
    // The lift fills silence; it never makes a swell in light air louder than a sailing breeze (Milo).
    wash: Math.max(db(table(WASH, hs)), Math.min(db(table(WASH, hs)) * lift, db(-31))) * setK,
    washHz: Math.min(220 + 70 * hs, 650),
    sizzle: db(table(SIZZLE, f)) * (0.75 + 0.5 * set) * Math.max(0.6, g),
    rain: w.rain > 0.01 ? db(-38 + 24 * clamp(w.rain)) : 0,
    breaksPerSec: wc > 0 ? (0.04 + 0.5 * wc * wc + 0.1 * clamp((hs - 2) / 4)) * setK * Math.max(g, 0.4) : 0,
    slap: clamp(0.15 + hs / 4.5, 0, 1),
    slam: f >= 5.5 ? clamp((hs - 2) / 5) * 0.35 * setK : 0,
    dropsPerSec: w.rain > 0.02 ? 2 + 26 * clamp(w.rain) : 0,
    // Light airs, rolling: a loose halyard taps the mast; once the sails fill (force 4 up) it stops.
    tapsPerSec: shrouds && fa > 0.8 && fa < 3.6 ? 0.2 * clamp(1 - Math.abs(fa - 2) / 1.8) + 0.05 : 0,
    slat: shrouds && fa < 3.5 && hs > 0.2 ? 0.45 * clamp((3.5 - fa) / 2) * clamp(hs / 0.8) : 0,
  };
}

/** How much of the hull layer the camera hears at this distance (m): never below -12 dB. */
export function nearGain(dist: number): number {
  return Math.max(0.25, 1 / (1 + Math.max(dist - 4, 0) / 10));
}

/** A small seeded random generator (mulberry32), so review renders repeat exactly. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type NoiseKind = "white" | "pink" | "brown";

function noise(ctx: BaseAudioContext, kind: NoiseKind, seconds: number, rnd: () => number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    if (kind === "white") d[i] = w * 0.5;
    else if (kind === "pink") {
      // Paul Kellet's cheap pink filter.
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  // Fade the ends together so the loop doesn't click.
  const f = Math.min(4000, n >> 4);
  for (let i = 0; i < f; i++) {
    const k = i / f;
    d[i] = d[i] * k + d[n - f + i] * (1 - k);
  }
  return buf;
}

interface Layer {
  gain: GainNode;
  filter: BiquadFilterNode;
}

export class OceanSound {
  private ctx: BaseAudioContext | null = null;
  private master: GainNode | null = null;
  private duckGain: GainNode | null = null;
  private L: Record<"windLo" | "windHi" | "rig" | "rig2" | "hull" | "wash" | "sizzle" | "rain", Layer> | null = null;
  private bufs: Record<NoiseKind, AudioBuffer> | null = null;
  private rnd: () => number = Math.random;
  // Slow weather in the sound: a gust that builds and passes (5 to 20 s), lulls now and
  // then, and the swell arriving in sets, so a steady roar never turns into a loop.
  private gust = 0;
  private gustAim = 0;
  private gustNext = 0;
  private lull = 1;
  private lullUntil = 0;
  private lullNext = 30;
  private swell = 0;
  private sets = 0;
  private nearS = -1;
  private nextBreak = 0;
  private nextSlap = 0;
  private nextDrop = 0;
  private nextTap = 0;
  private nextSlat = 0;
  private lastSplash = -99;
  private lastMix: Mix | null = null;
  private armed = false;
  /** What's aloft on the boat being shown (set by the page when the boat changes). */
  rig: Rig = "small";
  /** True while sound is playing (not muted). */
  on = false;
  /** Set when the viewer has turned it off on purpose; remembered between visits. */
  muted = stored() === "off";
  /** The viewer turned sound on last visit: it comes back at their first click or key, never on load. */
  readonly remembered = stored() === "on";
  /** Called after on changes (for the page's button). */
  onChange: (() => void) | null = null;

  constructor() {
    if (this.remembered && typeof window !== "undefined") {
      // A click or key is consent the browser accepts; this is the player's own choice from before.
      this.armed = true;
      const go = () => {
        removeEventListener("pointerdown", go, true);
        removeEventListener("keydown", go, true);
        if (this.armed && !this.on && !this.muted) this.enable();
      };
      addEventListener("pointerdown", go, true);
      addEventListener("keydown", go, true);
    }
    if (typeof document !== "undefined") {
      // Fade out and let the audio thread sleep when the tab is hidden; back when it returns.
      document.addEventListener("visibilitychange", () => {
        const ctx = this.ctx;
        if (!ctx || offline(ctx) || !this.on) return;
        if (document.hidden) {
          this.master!.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
          setTimeout(() => document.hidden && void (ctx as AudioContext).suspend(), 500);
        } else {
          void (ctx as AudioContext).resume();
          this.master!.gain.setTargetAtTime(LEVEL, ctx.currentTime, 0.5);
        }
      });
    }
  }

  /** Start (from a click). Does nothing if Web Audio isn't there. */
  enable(): void {
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.attach(new Ctx());
      }
      if (!offline(this.ctx)) void (this.ctx as AudioContext).resume();
      this.master!.gain.setTargetAtTime(LEVEL, this.ctx!.currentTime, 0.2);
      // A calm is meant to be near silent, which can sound like "broken" (Milo): say hello
      // with one soft lap of water against the hull, then settle to the true level.
      if (!this.on) this.hello();
      this.on = true;
      this.muted = false;
      this.armed = false;
      store("on");
    } catch {
      this.on = false;
    }
    this.onChange?.();
  }

  disable(remember = true): void {
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
    this.on = false;
    this.armed = false;
    if (remember) {
      this.muted = true;
      store("off");
    }
    this.onChange?.();
  }

  toggle(): void {
    if (this.on) this.disable();
    else this.enable();
  }

  /**
   * Build the sound on a context. The page does this from enable(); the review render passes
   * an OfflineAudioContext and a seed, and drives update() itself.
   */
  attach(ctx: BaseAudioContext, seed?: number): void {
    this.ctx = ctx;
    if (seed != null) this.rnd = seeded(seed);
    const rnd = this.rnd;
    this.bufs = { white: noise(ctx, "white", 4, rnd), pink: noise(ctx, "pink", 6, rnd), brown: noise(ctx, "brown", 7, rnd) };
    // Master: on/off fade -> duck (cinematic fades) -> soft high shelf -> limiter.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);
    const shelf = ctx.createBiquadFilter();
    shelf.type = "highshelf";
    shelf.frequency.value = 4500;
    shelf.gain.value = -8;
    shelf.connect(limiter);
    this.duckGain = ctx.createGain();
    this.duckGain.connect(shelf);
    this.master = ctx.createGain();
    this.master.gain.value = offline(ctx) ? LEVEL : 0; // a review render plays from the start
    this.master.connect(this.duckGain);
    const layer = (buf: AudioBuffer, type: BiquadFilterType, freq: number, q: number): Layer => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = 0.9 + rnd() * 0.2;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master!);
      src.start(0, rnd() * buf.duration);
      return { gain, filter };
    };
    const b = this.bufs;
    this.L = {
      windLo: layer(b.pink, "lowpass", 500, 0.6),
      windHi: layer(b.pink, "bandpass", 1200, 0.8),
      // Wind in wires: narrow bands of noise, not pure tones, so it sings softly.
      rig: layer(b.white, "bandpass", 450, 16),
      rig2: layer(b.white, "bandpass", 670, 20),
      hull: layer(b.white, "bandpass", 600, 1.3),
      wash: layer(b.brown, "lowpass", 400, 0.5),
      sizzle: layer(b.pink, "bandpass", 1500, 0.6),
      rain: layer(b.white, "bandpass", 3200, 0.5),
    };
    // The hull's water bubbles: two slow wobbles on its level, at rates that never line up.
    for (const [hz, depth] of [[3.1, 0.35], [7.3, 0.25]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      const d = ctx.createGain();
      d.gain.value = 0;
      o.connect(d).connect(this.L.hull.gain.gain);
      o.start();
      (this.wobble ??= []).push({ d, depth });
    }
  }

  private wobble: { d: GainNode; depth: number }[] | undefined;

  /** The audio clock, s. */
  private get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** A one-off noise burst through a filter, with an attack and a decay, `delay` s from now. */
  private burst(kind: NoiseKind, type: BiquadFilterType, freq: number, peak: number, attack: number, decay: number, delay = 0, q = 0.6): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.bufs![kind];
    src.playbackRate.value = 0.7 + this.rnd() * 0.6;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0, t + attack, decay / 3);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, this.rnd() * 3);
    src.stop(t + attack + decay * 1.6);
  }

  private get live(): boolean {
    return !!this.ctx && (this.on || offline(this.ctx));
  }

  /** One soft lap of water against the hull, about -20 dB for a second. */
  hello(): void {
    if (this.ctx) this.burst("brown", "lowpass", 380, 0.1, 0.18, 0.9, 0.08);
  }

  /** A breaking wave landing on the boat (a knockdown, #329): a roar of water and a thump. */
  crash(): void {
    if (!this.live) return;
    this.burst("white", "lowpass", 1400, 0.6, 0.04, 2.4);
    this.burst("brown", "lowpass", 130, 0.9, 0.008, 0.5);
  }

  /** Spray flying off the bow (strength 0..1): a short hiss, darker when it's small. */
  spray(strength = 0.5): void {
    if (!this.live) return;
    const s = clamp(strength);
    this.burst("white", "lowpass", 1500 + 1500 * s, 0.05 + 0.13 * s, 0.03, 0.35 + 0.5 * s, 0.05);
    // Then the drops landing on deck and sails, a patter like rain (Sam).
    const n = 4 + Math.round(14 * s);
    for (let i = 0; i < n; i++) this.burst("white", "bandpass", 1600 + this.rnd() * 1600, (0.01 + 0.025 * s) * this.rnd(), 0.002, 0.03, 0.35 + this.rnd() * 0.6, 3);
  }

  /**
   * The bow just dropped into the water (contact.ts, strength 0..1): a slap against the hull,
   * and spray on a big one. When the page sends these, the hull's own timing steps aside.
   */
  splash(strength: number): void {
    if (!this.live || strength <= 0) return;
    this.lastSplash = this.now;
    const m = this.lastMix;
    const near = nearGain(Math.max(this.nearS, 0));
    const s = clamp(strength) * (m ? 0.5 + 0.5 * m.slap : 0.7);
    this.slapAt(0, s * near);
    if (strength > 0.45) this.spray(strength * near);
  }

  /** Two short beeps, like an instrument's alarm: something broke (#329). */
  alarm(): void {
    if (!this.live) return;
    for (const at of [0, 0.22]) this.tone([1046], "triangle", 0.07, at, 0.12, 2200);
  }

  /** A ship's horn for the finish (#329): two low notes together. */
  horn(): void {
    if (!this.live) return;
    this.tone([110, 165], "sawtooth", 0.16, 0, 1.8, 900);
  }

  /**
   * Dip the whole mix about 2 dB for a fade to black between cinematic sequences, and come
   * back as the picture does. The beds keep running: it's a breath, not a restart.
   */
  duck(seconds = 0.8): void {
    if (!this.ctx || !this.duckGain) return;
    const t = this.ctx.currentTime;
    const g = this.duckGain.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0.78, t, seconds * 0.2);
    g.setTargetAtTime(1, t + seconds * 0.6, seconds * 0.25);
  }

  /** Oscillators at the given pitches, through a low-pass, for `hold` seconds. */
  private tone(freqs: number[], type: OscillatorType, peak: number, delay: number, hold: number, cut: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = cut;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.04);
    g.gain.setValueAtTime(peak, t + hold);
    g.gain.linearRampToValueAtTime(0, t + hold + 0.25);
    f.connect(g).connect(this.master!);
    for (const hz of freqs) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz;
      o.connect(f);
      o.start(t);
      o.stop(t + hold + 0.3);
    }
  }

  /** Water slapping the hull: a low knock and a short splash on top. */
  private slapAt(delay: number, w: number): void {
    if (w < 0.01) return;
    const r = this.rnd;
    this.burst("brown", "lowpass", 150 + r() * 140, (0.25 + 0.45 * w) * w, 0.006, 0.1 + r() * 0.1, delay);
    this.burst("white", "bandpass", 700 + r() * 500, 0.06 * w, 0.01, 0.25 + r() * 0.2, delay + 0.03, 0.8);
  }

  /** Follow the weather; call every frame (cheap when off). */
  update(dt: number, w: SeaWeather): void {
    const L = this.L;
    if (!this.live || !L) return;
    dt = Math.min(Math.max(dt, 0), 0.25);
    const t = this.now;
    const r = this.rnd;
    // Gusts: a new aim every 5 to 20 s, eased into, so each gust builds and passes.
    if (t >= this.gustNext) {
      this.gustAim = (r() - 0.35) * 0.9; // skewed: gusts up more than lulls down
      this.gustNext = t + 5 + r() * 15;
    }
    this.gust += (this.gustAim - this.gust) * Math.min(1, dt / 3);
    // A lull every minute or two: the wind eases for 8 to 20 s.
    if (t >= this.lullNext) {
      this.lullUntil = t + 8 + r() * 12;
      this.lullNext = this.lullUntil + 45 + r() * 75;
    }
    this.lull += ((t < this.lullUntil ? 0.6 : 1) - this.lull) * Math.min(1, dt / 4);
    const gust = clamp(this.gust * this.lull + (this.lull - 1), -0.6, 0.8);
    // The swell: each wave, and sets of bigger ones every 6 to 8 waves.
    const tp = Math.max(w.tp, 3);
    this.swell += (dt * 2 * Math.PI) / tp;
    this.sets += (dt * 2 * Math.PI) / (tp * 7);
    const wave = 0.5 + 0.5 * Math.sin(this.swell);
    const set = clamp(0.5 + 0.5 * Math.sin(this.sets) * (0.8 + 0.2 * Math.sin(this.sets * 0.37)));
    // The camera's distance, smoothed over a couple of seconds, so a cut never pops the hull.
    this.nearS = this.nearS < 0 ? w.near : this.nearS + (w.near - this.nearS) * Math.min(1, dt / 2);
    const near = nearGain(this.nearS);
    const m = mixFor(w, this.rig, gust, set);
    this.lastMix = m;
    const go = (l: Layer, v: number, hz: number | null, tc = 0.3) => {
      l.gain.gain.setTargetAtTime(v, t, tc);
      if (hz != null) l.filter.frequency.setTargetAtTime(hz, t, tc * 1.5);
    };
    go(L.windLo, m.windLo, m.windLoHz, 0.5);
    go(L.windHi, m.windHi, m.windHiHz, 0.4);
    go(L.rig, m.rig, m.rigHz, 0.6);
    go(L.rig2, m.rig * 0.55, m.rigHz * 1.49, 0.7);
    const hull = m.hull * near * (0.7 + 0.3 * wave);
    go(L.hull, hull, m.hullHz, 0.15);
    for (const o of this.wobble ?? []) o.d.gain.setTargetAtTime(hull * o.depth, t, 0.15);
    go(L.wash, m.wash * (0.65 + 0.35 * wave), m.washHz + 80 * wave, 0.35);
    go(L.sizzle, m.sizzle, null, 0.6);
    go(L.rain, m.rain, null, 0.8);
    // Whitecaps hissing nearby; heavy breakers in a gale (longer, lower, louder).
    if (m.breaksPerSec > 0 && t >= this.nextBreak) {
      const big = clamp((m.force - 6) / 3) * r();
      const wc = clamp((m.force - 3) / 5);
      this.burst("white", "bandpass", (big > 0.5 ? 450 : 700) + r() * 700, (0.03 + 0.12 * wc) * (0.4 + 0.6 * r()) * (1 + big), 0.2 + r() * 0.4 + big * 0.3, 0.8 + 1.6 * wc + big * 1.5);
      this.nextBreak = t + (-Math.log(1 - r() * 0.98) / m.breaksPerSec);
    }
    // The hull meeting waves, on the wave's own timing, unless the page sends the bow's splashes.
    if (t - this.lastSplash > 8 && t >= this.nextSlap) {
      const kn = (w.stw ?? 0) * 1.943844;
      if (w.hs > 0.15 || kn > 0.5) {
        const wt = m.slap * (0.4 + 0.6 * r()) * (0.6 + 0.4 * set);
        this.slapAt(0, wt * near * 0.8);
        if (r() < m.slam) {
          // Falling off a crest: a slam and a sheet of spray.
          this.burst("brown", "lowpass", 90 + r() * 40, 0.55 * near, 0.006, 0.45, 0.02);
          this.spray(0.5 + 0.5 * r());
        }
      }
      this.nextSlap = t + tp * (0.35 + r() * 0.6);
    }
    // Rain ticking on the deck.
    if (m.dropsPerSec > 0 && t >= this.nextDrop) {
      this.burst("white", "bandpass", 1800 + r() * 1400, 0.012 + 0.03 * r() * clamp(w.rain), 0.002, 0.03, 0, 3);
      this.nextDrop = t + (-Math.log(1 - r() * 0.98) / m.dropsPerSec);
    }
    // A loose halyard tapping the mast in light airs, as the boat rolls.
    if (m.tapsPerSec > 0 && t >= this.nextTap) {
      const k = 0.02 + 0.03 * r();
      this.burst("white", "bandpass", 1300 + r() * 400, k * near, 0.002, 0.05, 0, 5);
      if (r() < 0.4) this.burst("white", "bandpass", 1300 + r() * 400, k * 0.6 * near, 0.002, 0.04, 0.12 + r() * 0.1, 5);
      this.nextTap = t + (-Math.log(1 - r() * 0.98) / m.tapsPerSec);
    }
    // Slatting: no wind to fill the sails, the boat rolls and the boom bangs across, blocks clunk.
    if (m.slat > 0 && t >= this.nextSlat) {
      if (r() < m.slat) {
        this.burst("brown", "lowpass", 260 + r() * 120, 0.07 * near * (0.6 + 0.4 * r()), 0.02, 0.28);
        this.burst("white", "bandpass", 800 + r() * 300, 0.035 * near, 0.003, 0.07, 0.04, 3);
      }
      this.nextSlat = t + tp * (0.45 + r() * 0.5);
    }
  }
}
