/**
 * "My boat" as the top bar and title screen see it: a name, and the Boatyard link
 * that reopens it. A thin seam over src/myboat.ts (the boat remembered in the
 * browser, step 1 of the one-game plan), so the menu code doesn't depend on its shape.
 */
import { loadMyBoat, myBoatYardLink, onMyBoatChange } from "../myboat";

export interface BoatSummary {
  /** Shown in the bar, e.g. "Rev C, one rudder". */
  name: string;
  /** Boatyard link that reopens this design, relative to the site root. */
  href: string;
}

export function currentBoat(): BoatSummary | null {
  const b = loadMyBoat();
  return b ? { name: b.name, href: "./" + myBoatYardLink(b) } : null;
}

/** Calls back when my boat changes (in this tab or another). */
export function onBoatChange(cb: () => void): void {
  onMyBoatChange(() => cb());
}
