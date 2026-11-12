/**
 * Held keys at the helm (Rosa, Gameplay): steering and power that feel like a helm,
 * not a form. One press nudges the value; holding the key keeps it moving, faster the
 * longer you hold; Shift gives the fine step. The page sees every change at once
 * (preview: the dial and the text) but the simulator is only told now and then
 * (commit), so a held key sends a handful of orders, not one per frame.
 *
 * No DOM and no clock of its own: the page feeds it key events and frame times, so it
 * is unit-tested with made-up times (tests/keys.test.ts).
 */

export interface AxisOptions {
  /** One press, and the fine (Shift) press. */
  step: number;
  fine: number;
  /** How long a key is held before it starts to repeat on its own, ms. */
  delayMs: number;
  /** Speed of a held key, units a second: starts at `rate`, reaches `maxRate` after `rampMs`. */
  rate: number;
  maxRate: number;
  rampMs: number;
  /** Fine (Shift) held speed, units a second. */
  fineRate: number;
  /** While held, the simulator is told at most this often, ms. Always on release. */
  commitMs: number;
  /** Heading: values wrap round 0..360. Otherwise they're clamped to [min, max]. */
  wrap?: number;
  min?: number;
  max?: number;
  /** First press snaps to a multiple of the step (so 93 -> 95 -> 100, not 98 -> 103). */
  snap?: boolean;
}

export interface AxisHost {
  /** Where to start from when a key goes down (the current order, or the boat's heading). */
  value(): number;
  /** Show this value now: dial, text. Cheap; called every frame while held. */
  preview(v: number): void;
  /** Tell the simulator. */
  commit(v: number): void;
}

export const HEADING: AxisOptions = { step: 5, fine: 1, delayMs: 280, rate: 15, maxRate: 45, rampMs: 1500, fineRate: 4, commitMs: 400, wrap: 360, snap: true };
export const POWER: AxisOptions = { step: 0.05, fine: 0.01, delayMs: 280, rate: 0.25, maxRate: 0.6, rampMs: 1200, fineRate: 0.05, commitMs: 400, min: 0, max: 1, snap: true };

const EPS = 1e-9;

/** One value (heading or power) driven by a pair of keys. */
export class HeldAxis {
  private dir: -1 | 0 | 1 = 0;
  private fine = false;
  private since = 0; // when the key went down
  private last = 0; // last tick time
  private v = 0;
  private sent = NaN; // last committed value
  private sentAt = -Infinity;

  constructor(
    private readonly host: AxisHost,
    readonly o: AxisOptions,
  ) {}

  get held(): boolean {
    return this.dir !== 0;
  }

  get current(): number {
    return this.v;
  }

  private norm(v: number): number {
    const o = this.o;
    if (o.wrap) return ((v % o.wrap) + o.wrap) % o.wrap;
    return Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));
  }

  private round(v: number): number {
    // Whole degrees, whole percent: what the panel shows is what gets sent.
    // Divide by a whole number, so 35 % is 0.35 exactly, not 0.35000000000000003.
    const per = Math.round(1 / this.o.fine);
    return this.norm(Math.round(v * per) / per);
  }

  /** A key went down (ignore the browser's own key repeat: call this once per press). */
  down(dir: -1 | 1, fine: boolean, now: number): void {
    if (this.dir === dir) return;
    const start = this.dir === 0 ? this.host.value() : this.v;
    const s = fine ? this.o.fine : this.o.step;
    let next: number;
    if (this.o.snap && !fine) {
      const snapped = Math.round(start / s) * s;
      // Off the grid: the first press lands on the next mark in that direction.
      next = Math.abs(snapped - start) > EPS && Math.sign(snapped - start) === dir ? snapped : snapped + dir * s;
    } else next = start + dir * s;
    this.dir = dir;
    this.fine = fine;
    this.since = this.last = now;
    this.set(this.round(next), now, true);
  }

  /** The key came up: stop, and tell the simulator where it ended. */
  up(dir: -1 | 1, now: number): void {
    if (this.dir !== dir) return;
    this.dir = 0;
    this.flush(now);
  }

  /** Shift pressed or released while a key is held. */
  setFine(fine: boolean): void {
    this.fine = fine;
  }

  /** Window lost focus: keys may never come up, so let go of everything. */
  release(now: number): void {
    if (!this.dir) return;
    this.dir = 0;
    this.flush(now);
  }

  /** Once a frame. Returns true while the value is moving. */
  tick(now: number): boolean {
    if (!this.dir) return false;
    const dt = Math.max(0, now - this.last) / 1000;
    this.last = now;
    const heldMs = now - this.since;
    if (heldMs < this.o.delayMs) return true;
    const o = this.o;
    const ramp = Math.min(1, (heldMs - o.delayMs) / o.rampMs);
    const rate = this.fine ? o.fineRate : o.rate + (o.maxRate - o.rate) * ramp;
    const raw = this.norm(this.v + this.dir * rate * dt);
    this.v = raw; // keep the fractional part between frames, so slow rates still move
    this.host.preview(this.round(raw));
    if (now - this.sentAt >= o.commitMs) this.send(now);
    // Clamped at an end: nothing more to do until the key comes up.
    return !(o.wrap === undefined && (raw <= (o.min ?? -Infinity) || raw >= (o.max ?? Infinity)));
  }

  private set(v: number, now: number, commit: boolean): void {
    this.v = v;
    this.host.preview(v);
    if (commit) this.send(now);
  }

  private flush(now: number): void {
    const v = this.round(this.v);
    this.v = v;
    this.host.preview(v);
    this.send(now);
  }

  private send(now: number): void {
    const v = this.round(this.v);
    this.sentAt = now;
    if (v === this.sent) return;
    this.sent = v;
    this.host.commit(v);
  }
}

/**
 * Calls to an async sink, one at a time, keeping only the newest while one is in flight:
 * a held key can't queue up a backlog of stale orders in the simulator's worker.
 */
export function latestOnly<T>(send: (v: T) => Promise<unknown>): (v: T) => void {
  let busy = false;
  let pending: { v: T } | null = null;
  const go = (v: T): void => {
    busy = true;
    void send(v)
      .catch(() => undefined)
      .finally(() => {
        busy = false;
        const p = pending;
        pending = null;
        if (p) go(p.v);
      });
  };
  return (v: T) => {
    if (busy) pending = { v };
    else go(v);
  };
}

/** Which axis and direction a key drives at the helm, or null. */
export function keyAxis(code: string): { axis: "heading" | "power"; dir: -1 | 1 } | null {
  switch (code) {
    case "ArrowLeft":
      return { axis: "heading", dir: -1 };
    case "ArrowRight":
      return { axis: "heading", dir: 1 };
    case "ArrowUp":
      return { axis: "power", dir: 1 };
    case "ArrowDown":
      return { axis: "power", dir: -1 };
    default:
      return null;
  }
}
