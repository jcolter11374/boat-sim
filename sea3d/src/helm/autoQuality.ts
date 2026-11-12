// The helm's starting picture quality, picked for the computer it runs on (Maya, Elena, 12 Nov).
// Start on Medium. Under the goal card, time the frames for about 3 s, after the first frames
// (shader compiling) have passed; if the typical frame is slower than about 36 ms (under
// 30 a second), step down to Low once. "Typical" is the mean with the slowest 5% dropped, not the
// median: a browser can call back every 16.7 ms and stall on every few frames (the graphics card
// can't keep up), and a median would miss those stalls entirely. Never step up by itself. A level
// the player picked is remembered and always wins; software graphics (no graphics card) start on Low; ?quality=
// pins it for tests and screenshots.

export type Level = "low" | "medium" | "high";
export const LEVELS: Level[] = ["low", "medium", "high"];
export const PREF_KEY = "boatsim.helm.quality";

/** Where the starting level came from. Only "auto" may step down by itself. */
export type Source = "url" | "player" | "software" | "auto";

export function isLevel(x: unknown): x is Level {
  return x === "low" || x === "medium" || x === "high";
}

/** The level to start on, and why. `stored` is the player's remembered pick, if any. */
export function startLevel(search: string, stored: string | null, software: boolean): { level: Level; source: Source } {
  const q = new URLSearchParams(search).get("quality");
  if (isLevel(q)) return { level: q, source: "url" };
  if (isLevel(stored)) return { level: stored, source: "player" };
  if (software) return { level: "low", source: "software" };
  return { level: "medium", source: "auto" };
}

export interface JudgeOptions {
  /** Frames to skip at the start, whatever their speed (first draws compile shaders). */
  skipFrames: number;
  /** And at least this long (ms) from the first frame before timing starts. */
  skipMs: number;
  /** How long to time frames for (ms). */
  windowMs: number;
  /** A typical frame (mean, slowest 5% dropped) slower than this (ms) means: step down. */
  slowMs: number;
  /** A gap longer than this (ms) is a pause (a hidden tab, a stall), not a frame: it isn't timed. */
  pauseMs: number;
}
// 36 ms, not 33: a screen refreshing 30 times a second gives every frame 33.3 ms, and that's smooth (Kai).
export const JUDGE: JudgeOptions = { skipFrames: 20, skipMs: 1000, windowMs: 3000, slowMs: 36, pauseMs: 500 };

/**
 * Times frames once and gives one verdict. Feed it each frame's duration in ms; it answers
 * "wait" until it has seen `windowMs` of frames after the skip, then "slow" or "ok" once, then "done".
 */
export class FrameJudge {
  private seen = 0;
  private sinceStart = 0;
  private timed = 0;
  private readonly dts: number[] = [];
  private verdict: "slow" | "ok" | null = null;
  private told = false;
  constructor(private readonly o: JudgeOptions = JUDGE) {}

  tick(dtMs: number): "wait" | "slow" | "ok" | "done" {
    if (this.told) return "done";
    if (!(dtMs > 0) || !Number.isFinite(dtMs) || dtMs > this.o.pauseMs) return "wait";
    this.seen++;
    this.sinceStart += dtMs;
    if (this.seen <= this.o.skipFrames || this.sinceStart < this.o.skipMs) return "wait";
    this.dts.push(dtMs);
    this.timed += dtMs;
    if (this.timed < this.o.windowMs) return "wait";
    this.verdict = this.typical() > this.o.slowMs ? "slow" : "ok";
    this.told = true;
    return this.verdict;
  }

  /** The mean of the timed frames (ms) with the slowest 5% left out (one-off hitches; at least one
   * from 10 frames up, so a short window on a slow computer still drops its one hitch: Kai), or NaN before any. */
  typical(): number {
    const n = this.dts.length;
    if (!n) return NaN;
    const s = [...this.dts].sort((a, b) => a - b);
    const drop = n >= 10 ? Math.max(1, Math.floor(n * 0.05)) : 0;
    const keep = s.slice(0, n - drop);
    return keep.reduce((a, b) => a + b, 0) / keep.length;
  }

  /** The median of the timed frames (ms), or NaN before any. */
  median(): number {
    if (!this.dts.length) return NaN;
    const s = [...this.dts].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  get frames(): number {
    return this.dts.length;
  }
}

/** What each level costs the graphics card: the drawing resolution and the glow. */
export function levelSettings(level: Level, devicePixelRatio: number, software: boolean): { ratio: number; bloom: boolean; sea: "low" | "high" } {
  if (level === "high") return { ratio: Math.min(devicePixelRatio, 2), bloom: true, sea: "high" };
  if (level === "medium") return { ratio: Math.min(devicePixelRatio, 1), bloom: false, sea: "high" };
  return { ratio: software ? 0.5 : 0.75, bloom: false, sea: "low" };
}
