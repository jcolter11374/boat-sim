/**
 * The title's music track (John, 14 Nov 2026: "Saltwater Patience", his own track, used with
 * his rights). It takes the place of the code-made air (titleMusic.ts, still there behind
 * ?music=air) and plays only while the sound is on: it goes through the sea's master, so the
 * sound switch (and N) turns it off and on with the sea.
 *
 * The file (public/music/saltwater-patience-loop.mp3) is the middle of the track, 16.0 s to
 * 103.72 s, with its last 2.5 s crossfaded into its start so it loops without a seam, brought
 * down from about -11 LUFS to -16 LUFS. Half a second of the loop's own end is put before it
 * and half a second of its start after it, so an MP3 decoder's padding at either end falls
 * outside the loop points below.
 *
 * It is fetched only once the sound is on (about 1.4 MB), never for a visitor who keeps it off.
 */
import type { OceanSound } from "./sound";

export const TRACK_URL = "./music/saltwater-patience-loop.mp3";
/** The loop's length (s) and the wrap on each side of it in the file (s). */
export const LOOP_SECONDS = 87.72;
export const WRAP_SECONDS = 0.5;
/** The usual MP3 encoder delay (LAME: 576 + 529 samples), when a decoder leaves it in. */
export const ENCODER_DELAY = 1105 / 44100;
/**
 * Level into the sea's master (linear). Measured offline: the title's sea is about -35 LUFS;
 * the track at this level lands about -36, just under it, so the sea is still the main thing.
 */
export const TRACK_LEVEL = 0.05;
/** Seconds the music takes to swell in after the sound comes on. */
export const FADE_IN = 4;

/** Where the loop starts in a decoded buffer: past the wrap, and past an encoder delay a decoder left in. */
export function loopStartOf(decodedSeconds: number): number {
  const exact = LOOP_SECONDS + 2 * WRAP_SECONDS;
  return WRAP_SECONDS + (Math.abs(decodedSeconds - exact) < 0.01 ? 0 : ENCODER_DELAY);
}

export class TitleTrack {
  private buf: AudioBuffer | null = null;
  private asked: Promise<void> | null = null;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** Whether the track plays (the sea carries on without it). */
  on = true;

  constructor(private sea: OceanSound, private url = TRACK_URL) {}

  /** Every frame while the title is up: starts the track once the sound is on and the file is in. */
  update(): void {
    const bus = this.sea.bus();
    if (!bus || !this.on) return;
    const { ctx } = bus;
    if (!this.asked) {
      this.asked = fetch(this.url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
        .then((b) => ctx.decodeAudioData(b))
        .then((b) => { this.buf = b; })
        .catch(() => { /* no music; the sea plays on */ });
    }
    if (!this.buf || (this.src && this.gain?.context === ctx)) return;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(TRACK_LEVEL, ctx.currentTime + FADE_IN);
    g.connect(bus.out);
    const s = ctx.createBufferSource();
    s.buffer = this.buf;
    s.loop = true;
    s.loopStart = loopStartOf(this.buf.duration);
    s.loopEnd = s.loopStart + LOOP_SECONDS;
    s.connect(g);
    s.start(ctx.currentTime + 0.05, s.loopStart);
    this.src = s;
    this.gain = g;
    this.sea.note("track");
  }
}
