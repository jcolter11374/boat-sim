/**
 * Ocean sound that follows the weather (John, Nov 11): wind, rain, the wash of the
 * sea, waves breaking and the hull slapping, all made in code from filtered noise
 * (no sound files). Louder and rougher as the wind, waves and rain get up.
 * Nothing plays until the viewer clicks something (browsers require that anyway).
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
  /** Distance from the camera to the boat, m (the hull's sounds fade with it). */
  near: number;
}

const KEY = "boatsim-sound";
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));

function noise(ctx: AudioContext, kind: "white" | "pink" | "brown", seconds = 3): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
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
  const f = Math.min(2000, n >> 4);
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
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private wind: Layer | null = null;
  private whistle: Layer | null = null;
  private wash: Layer | null = null;
  private rain: Layer | null = null;
  private bufs: Record<"white" | "pink" | "brown", AudioBuffer> | null = null;
  private nextBreak = 0;
  private nextSlap = 0;
  private gust = 0;
  private phase = 0;
  /** True while sound is playing (not muted). */
  on = false;
  /** Set when the viewer has turned it off on purpose; remembered between visits. */
  muted = typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "off";
  /** Called after on changes (for the page's button). */
  onChange: (() => void) | null = null;

  /** Start (from a click). Does nothing if Web Audio isn't there. */
  enable(): void {
    try {
      if (!this.ctx) this.build();
      void this.ctx!.resume();
      this.master!.gain.setTargetAtTime(0.9, this.ctx!.currentTime, 0.6);
      this.on = true;
      this.muted = false;
      localStorage.setItem(KEY, "on");
    } catch {
      this.on = false;
    }
    this.onChange?.();
  }

  disable(remember = true): void {
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
    this.on = false;
    if (remember) {
      this.muted = true;
      localStorage.setItem(KEY, "off");
    }
    this.onChange?.();
  }

  toggle(): void {
    if (this.on) this.disable();
    else this.enable();
  }

  private build(): void {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.bufs = { white: noise(ctx, "white"), pink: noise(ctx, "pink", 4), brown: noise(ctx, "brown", 5) };
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp);
    const layer = (buf: AudioBuffer, type: BiquadFilterType, freq: number, q: number): Layer => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = 0.9 + Math.random() * 0.2;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master!);
      src.start(0, Math.random() * buf.duration);
      return { gain, filter };
    };
    this.wind = layer(this.bufs.pink, "bandpass", 500, 0.7);
    this.whistle = layer(this.bufs.white, "bandpass", 1500, 9);
    this.wash = layer(this.bufs.brown, "lowpass", 420, 0.5);
    this.rain = layer(this.bufs.white, "highpass", 2600, 0.4);
  }

  /** A one-off noise burst through a filter, with an attack and a decay. */
  private burst(kind: "white" | "brown", type: BiquadFilterType, freq: number, peak: number, attack: number, decay: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.bufs![kind];
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = 0.6;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0, t + attack, decay / 3);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 2);
    src.stop(t + attack + decay * 1.5);
  }

  /** A breaking wave landing on the boat (a knockdown, #329): a roar of water and a thump. */
  crash(): void {
    if (!this.ctx || !this.on) return;
    this.burst("white", "lowpass", 1600, 0.75, 0.04, 2.4);
    this.burst("brown", "lowpass", 140, 1, 0.008, 0.5);
  }

  /** Two short beeps, like an instrument's alarm: something broke (#329). */
  alarm(): void {
    if (!this.ctx || !this.on) return;
    for (const at of [0, 0.22]) this.tone([1046], "square", 0.06, at, 0.12, 2200);
  }

  /** A ship's horn for the finish (#329): two low notes together. */
  horn(): void {
    if (!this.ctx || !this.on) return;
    this.tone([110, 165], "sawtooth", 0.16, 0, 1.8, 900);
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

  /** Follow the weather; call every frame (cheap when off). */
  update(dt: number, w: SeaWeather): void {
    const ctx = this.ctx;
    if (!ctx || !this.on || !this.wind || !this.whistle || !this.wash || !this.rain) return;
    const t = ctx.currentTime;
    // Wind: a breathy roar that gusts, with a whistle in the rigging once it's strong.
    this.gust = clamp(this.gust + (Math.random() - 0.5) * dt * 1.6 - this.gust * dt * 0.3, -0.6, 0.6);
    const wn = clamp((w.wind - 1.5) / 20);
    this.wind.gain.gain.setTargetAtTime(0.06 + Math.pow(wn, 1.4) * 0.65 * (1 + this.gust * 0.5), t, 0.3);
    this.wind.filter.frequency.setTargetAtTime(260 + wn * 700 + this.gust * 180, t, 0.4);
    this.whistle.gain.gain.setTargetAtTime(clamp((w.wind - 12) / 14) * 0.05 * (1 + this.gust), t, 0.4);
    this.whistle.filter.frequency.setTargetAtTime(1300 + wn * 900 + this.gust * 300, t, 0.5);
    // The wash of the sea rises and falls with each swell.
    this.phase += (dt * 2 * Math.PI) / Math.max(w.tp, 3);
    const hn = clamp(w.hs / 5);
    this.wash.gain.gain.setTargetAtTime((0.18 + hn * 0.55) * (0.75 + 0.25 * Math.sin(this.phase)), t, 0.25);
    this.wash.filter.frequency.setTargetAtTime(300 + hn * 400, t, 0.5);
    // Rain hiss.
    this.rain.gain.gain.setTargetAtTime(clamp(w.rain) * 0.32, t, 0.5);
    // Waves breaking: whitecaps once the wind passes about 7 m/s, more often and longer in a storm.
    const breaks = clamp((w.wind - 6.5) / 12) * 0.9 + clamp((w.hs - 2) / 4) * 0.4;
    if (breaks > 0 && t > this.nextBreak) {
      this.burst("white", "bandpass", 700 + Math.random() * 900, (0.08 + breaks * 0.22) * (0.5 + Math.random() * 0.5), 0.25 + Math.random() * 0.4, 1.2 + breaks * 2);
      this.nextBreak = t + (1.5 + Math.random() * 5) / (0.3 + breaks);
    }
    // Hull slap: low thumps as the kayak meets the waves, close up only.
    const near = 1 / (1 + Math.max(w.near - 3, 0) / 5);
    if (near > 0.08 && t > this.nextSlap) {
      this.burst("brown", "lowpass", 180 + Math.random() * 160, (0.2 + hn * 0.5) * near * (0.4 + Math.random() * 0.6), 0.006, 0.12 + Math.random() * 0.1);
      this.nextSlap = t + Math.max(w.tp, 3) * (0.25 + Math.random() * 0.6) / (0.6 + hn);
    }
  }
}
