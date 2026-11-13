// Keeps the crossing under way saved in this browser (DESIGN.md, M3: closing the tab
// mid-crossing and coming back offers "Continue your voyage"). voyageSave.ts is the record
// and the storage; this is when to write it: every few seconds while the voyage is under
// way, when the page is hidden or closed, and not at all once the voyage is over (then the
// save is cleared: an ended voyage has its results card, not a "continue").
//
//   new VoyageKeeper(() => (ready ? { day, over, boat, toGoKm, rate, challenge } : null), () => game.save()).start();
//
// The page says which sessions get a keeper at all: a watched voyage, a game someone shared
// and practice sailing are not the player's crossing, and get none.

import type { StorageLike } from "../myboat";
import { clearVoyage, packVoyage, saveVoyage, worthSaving, type SavedVoyage, type VoyageNow } from "./voyageSave";

/** The voyage as the page has it now. `code` comes separately: it has to be asked for. */
export type VoyageState = Omit<VoyageNow, "code"> & { over: boolean };

/** How often a voyage under way is saved (real seconds). Closing the tab loses at most this
 *  much of the orders; the simulator sails the rest again from the code. */
export const KEEP_EVERY_MS = 15_000;

export class VoyageKeeper {
  /** The last record written, for tests and for the page to show. */
  last: SavedVoyage | null = null;
  private asking = false;
  private ended = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** `state` is null until a voyage is on the screen. `code` is the simulator's save code
   *  (Game.save): it may take a moment, and may fail; a failed save is simply skipped.
   *  `storage` is injectable for tests; left out, it is the browser's. */
  constructor(
    private readonly state: () => VoyageState | null,
    private readonly code: () => Promise<string>,
    private readonly storage?: StorageLike | null,
  ) {}

  /** Save the voyage as it is now. True if a record was written. Never throws. */
  async keep(): Promise<boolean> {
    const before = this.state();
    if (!before) return false;
    if (before.over) return this.end();
    if (!worthSaving(before.day, before.over) || this.asking) return false;
    this.asking = true;
    try {
      const code = await this.code();
      // The voyage sailed on while the code was made: the words are for now, the code is the
      // voyage. If it ended meanwhile there is nothing to continue.
      const st = this.state();
      if (!st) return false;
      if (st.over) return this.end();
      const v = packVoyage({ ...st, code });
      if (!v) return false;
      saveVoyage(v, this.storage);
      this.last = v;
      this.ended = false;
      return true;
    } catch {
      return false; // the simulator couldn't say: the last save stands
    } finally {
      this.asking = false;
    }
  }

  /** The voyage is over: forget the save (once; a later voyage in another tab is left alone). */
  private end(): false {
    if (!this.ended) clearVoyage(this.storage);
    this.ended = true;
    this.last = null;
    return false;
  }

  /** Save on a timer, and when the page is hidden or closed (a phone switching apps only
   *  says "hidden"; a closing tab says "pagehide"). The timer's save is the one to count on:
   *  a closing page may not wait for the simulator's answer. */
  start(everyMs = KEEP_EVERY_MS): this {
    if (this.timer !== null) return this;
    this.timer = setInterval(() => void this.keep(), everyMs);
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
    void this.keep();
  };
}
