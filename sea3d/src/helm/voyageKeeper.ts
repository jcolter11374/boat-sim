// Keeps the crossing under way saved in this browser (DESIGN.md, M3: closing the tab
// mid-crossing and coming back offers "Continue your voyage"). voyageSave.ts is the record
// and the storage; this is when to write it.
//
//   new VoyageKeeper(() => (ready ? { day, seen, over, boat, toGoKm, rate, challenge, orders } : null), () => game.save()).start();
//
// When it saves (Omar's live check, 13 Nov: a 15 s timer lost most of a day at 6 h a second):
//   - when the clock is paused or its speed changes, and when an order goes;
//   - when an hour of the voyage has gone by since the last save, whatever the speed;
//   - but never asking the simulator more than once every two seconds;
//   - when the page is hidden or closed: at once, with what is already held (the simulator's
//     code takes a moment, and a closing page doesn't wait), and then a fresh save if the
//     page lives long enough to finish it.
// So what can go unsaved is about two seconds of play: nothing in real time, an hour or two at
// an hour a second, more at the fast speeds. The save says which day was on the screen when
// the page was left (`left`), so coming back can say truthfully where it is (welcomeBack).
//
// When the voyage is over the save is cleared: an ended voyage has its results card, not a
// "continue". The page says which sessions get a keeper at all: a watched voyage, a game
// someone shared and practice sailing are not the player's crossing, and get none.

import type { StorageLike } from "../myboat";
import { clearVoyage, packVoyage, saveVoyage, worthSaving, type SavedVoyage, type VoyageNow } from "./voyageSave";

/** The voyage as the page has it now. `code` comes separately: it has to be asked for.
 *  `seen` is the voyage day on the screen (the simulator runs a little ahead of it);
 *  `orders` is anything that changes when an order goes (compared, never read). */
export type VoyageState = Omit<VoyageNow, "code" | "left"> & { over: boolean; seen?: number | null; orders?: string };

/** The most voyage time that goes by between saves, in hours, when the two-second rule allows. */
export const MAX_UNSAVED_H = 1;
/** The simulator is never asked for a code more often than this (real ms). */
export const MIN_ASK_MS = 2000;
/** How often the keeper looks at the voyage (real ms). Looking is free; only a save asks the simulator. */
export const LOOK_EVERY_MS = 500;

export class VoyageKeeper {
  /** The last record written, for tests and for the page to show. */
  last: SavedVoyage | null = null;
  private asking = false;
  private ended = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** What the voyage looked like at the last save, to tell what has changed since. */
  private kept: { day: number; rate: VoyageState["rate"]; orders: string | undefined } | null = null;
  private askedAt = -Infinity;

  /** `state` is null until a voyage is on the screen. `code` is the simulator's save code
   *  (Game.save): it may take a moment, and may fail; a failed save is simply skipped.
   *  `storage` is injectable for tests; left out, it is the browser's. */
  constructor(
    private readonly state: () => VoyageState | null,
    private readonly code: () => Promise<string>,
    private readonly storage?: StorageLike | null,
  ) {}

  /** Whether the voyage has changed enough since the last save to save again. */
  due(st: VoyageState): boolean {
    if (!worthSaving(st.day, st.over)) return false;
    const k = this.kept;
    if (!k) return true;
    if ((st.rate ?? 0) !== (k.rate ?? 0)) return true; // paused, carried on, or a new speed
    if (st.orders !== k.orders) return true; // an order went
    return (st.day - k.day) * 24 >= MAX_UNSAVED_H - 1e-6; // (the day is a float: an exact hour counts)
  }

  /** One look at the voyage: save if it is due and the simulator was last asked long enough
   *  ago. A save that is due too soon waits for a later look. `now` is injectable for tests. */
  look(now: number = Date.now()): Promise<boolean> {
    const st = this.state();
    if (!st) return Promise.resolve(false);
    if (st.over) return Promise.resolve(this.end());
    if (!this.due(st) || now - this.askedAt < MIN_ASK_MS) return Promise.resolve(false);
    return this.keep(now);
  }

  /** Save the voyage as it is now. True if a record was written. Never throws. */
  async keep(now: number = Date.now()): Promise<boolean> {
    const before = this.state();
    if (!before) return false;
    if (before.over) return this.end();
    if (!worthSaving(before.day, before.over) || this.asking) return false;
    this.asking = true;
    this.askedAt = now;
    try {
      const code = await this.code();
      // The voyage sailed on while the code was made: the words are for now, the code is the
      // voyage. If it ended meanwhile there is nothing to continue.
      const st = this.state();
      if (!st) return false;
      if (st.over) return this.end();
      const v = packVoyage({ ...st, left: st.seen, code });
      if (!v) return false;
      saveVoyage(v, this.storage);
      this.last = v;
      this.kept = { day: before.day, rate: before.rate, orders: before.orders }; // as it was when asked
      this.ended = false;
      return true;
    } catch {
      return false; // the simulator couldn't say: the last save stands
    } finally {
      this.asking = false;
    }
  }

  /** The page is going: write what is held, now, without the simulator. The code is the last
   *  save's; what is new is the day on the screen as the player leaves, and the speed. True
   *  if there was something to write. Never throws. */
  leave(): boolean {
    const st = this.state();
    if (!st || !this.last) return false;
    if (st.over) return this.end();
    const v = packVoyage({ ...this.last, left: st.seen, rate: st.rate }, new Date());
    if (!v) return false;
    saveVoyage(v, this.storage);
    this.last = v;
    return true;
  }

  /** The voyage is over: forget the save (once; a later voyage in another tab is left alone). */
  private end(): false {
    if (!this.ended) clearVoyage(this.storage);
    this.ended = true;
    this.last = null;
    this.kept = null;
    return false;
  }

  /** Look at the voyage twice a second, and save at once when the page is hidden or closed
   *  (a phone switching apps only says "hidden"; a closing tab says "pagehide"). */
  start(everyMs = LOOK_EVERY_MS): this {
    if (this.timer !== null) return this;
    this.timer = setInterval(() => void this.look(), everyMs);
    addEventListener("pagehide", this.onHide);
    document.addEventListener("visibilitychange", this.onHide);
    return this;
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    removeEventListener("pagehide", this.onHide);
    document.removeEventListener("visibilitychange", this.onHide);
  }

  private readonly onHide = (e: Event): void => {
    if (e.type === "visibilitychange" && document.visibilityState !== "hidden") return;
    this.leave(); // at once, with what is held
    void this.keep(); // and a fresh one, if the page lives to finish it
  };
}
