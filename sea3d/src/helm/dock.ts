// Launching from the dock (John, 24 Nov 2026: "launch from a dock and not start in the middle
// of the water"). Before a crossing the boat lies alongside a pier at Annapolis, the town behind
// her, in place of an empty sea 100 km out. Set sail casts her off: she motors out of the harbour
// while the simulator loads, then the view cuts to the drop point off the Bay mouth, where the
// crossing has always started. Display only: nothing of it reaches the simulator, and the trip
// down the Bay is skipped and doesn't count (the cut says so), as in the harbour prologue.

import { toXY, type LatLon } from "./course";

/**
 * The way out, from alongside the pier (a public pier on the Annapolis side of the harbour, from
 * the town file's piers: its outer 10 m, on the side that faces the harbour mouth) round into the
 * channel and on past the harbour mouth to the Severn. Checked against the town's ground and its
 * other piers (docs/qa/dock-launch-2026-11.md).
 */
export const DOCK_WAY: LatLon[] = [
  { lat: 38.976755, lon: -76.484165 }, // alongside, 3 m off the pier
  { lat: 38.976524, lon: -76.483813 }, // clear of its end
  { lat: 38.976093, lon: -76.482889 }, // out in the harbour
  { lat: 38.976363, lon: -76.480693 }, // towards the harbour mouth
  { lat: 38.977, lon: -76.4791 }, // the harbour mouth
  { lat: 38.9746, lon: -76.4674 }, // the Severn's mouth
  { lat: 38.967, lon: -76.4572 }, // the end of the channel
];
/** Looking this way past the boat shows the pier, the town and the State House dome (compass degrees). */
export const DOCK_LOOK = 262;
/** At the dock the camera stands this many times further back than at sea (GUESS, by eye on the pictures). */
export const DOCK_PULL = 1.7;
/** The harbour's own small chop (m, s): sheltered water, not the ocean swell of the drop point (GUESS). */
export const DOCK_SEA = { hs: 0.1, tp: 1.8 };
/** She is up to speed this long after casting off (s). */
export const DOCK_RAMP_S = 4;
/** The leaving is watched for at least this long, even when the simulator is ready at once (s). */
export const DOCK_MIN_S = 7;
/** Leaving speed (m/s): her own cruising speed, but no slower than a walk and no faster than a harbour allows (6 knots). */
export const dockSpeed = (cruise: number): number => Math.min(3.1, Math.max(1.2, cruise));

// Arriving at a dock in Portugal (John, 24 Nov 2026: "Azores and a dock in Portugal"). The finish line
// is 330 km out to sea and stays exactly where the race's rules put it (John, 9 Nov). After it, and
// after the clock has stopped, the view moves on to Cascais, the harbour town west of Lisbon, where
// she comes alongside a pontoon of the marina with the old town behind. Display only, like the leaving.

/**
 * The way in: the last 40 m to the marina's outer pontoon (the town file's piers[9], its bay side,
 * 3 m off, half way along), from the open bay. Checked against the town's ground and its other piers
 * (docs/qa/portugal-dock-2026-11.md).
 */
export const LANDING_WAY: LatLon[] = [
  { lat: 38.691477, lon: -9.41731 }, // in the bay, 14 m off the pontoon
  { lat: 38.691694, lon: -9.417265 }, // on the line of her berth
  { lat: 38.691785, lon: -9.417153 }, // alongside, 3 m off the pontoon
];
/** Looking this way past the boat shows the pontoon, the marina and the old town (compass degrees). */
export const LANDING_LOOK = 315;
/** She is watched coming in for this long (s), then the results come up with her still in view behind them; a click or a key brings them sooner. */
export const LANDING_S = 14;
/** How hard she slows for her berth (m/s2, GUESS: gentle, by eye). */
export const LANDING_SLOW = 0.12;

const bearingOf = (a: LatLon, b: LatLon): number => {
  const v = toXY(a, b);
  return ((Math.atan2(v.x, v.y) * 180) / Math.PI + 360) % 360;
};

export interface DockState {
  lat: number;
  lon: number;
  /** Compass degrees. */
  heading: number;
  /** Through the water, m/s. */
  stw: number;
}

/** The boat at the dock and on her way out: where she is for a distance sailed along the way. */
export class Dock {
  private readonly legs: { from: LatLon; to: LatLon; m: number; bearing: number }[] = [];
  /** Metres sailed from the pier. */
  sailed = 0;
  /** Seconds since she cast off; -1 while she is tied up. */
  away = -1;
  speed = 0;

  constructor(
    readonly way: LatLon[] = DOCK_WAY,
    /** Her cruising speed through the water (m/s). */
    public cruise = 1.5,
    /** An arrival: she slows as the way runs out and stops at its end, where a leaving carries on. */
    readonly stops = false,
  ) {
    for (let i = 1; i < way.length; i++) {
      const v = toXY(way[i - 1], way[i]);
      this.legs.push({ from: way[i - 1], to: way[i], m: Math.hypot(v.x, v.y), bearing: bearingOf(way[i - 1], way[i]) });
    }
  }

  get castOff(): boolean {
    return this.away >= 0;
  }
  /** Let go the lines. */
  leave(): void {
    if (this.away < 0) this.away = 0;
  }
  /** Back alongside (a start that failed). */
  reset(): void {
    this.away = -1;
    this.sailed = 0;
    this.speed = 0;
  }
  /** One frame: she gathers way smoothly, then holds her leaving speed. */
  advance(dt: number): void {
    if (this.away < 0) return;
    this.away += dt;
    const k = Math.min(1, this.away / DOCK_RAMP_S);
    this.speed = dockSpeed(this.cruise) * k * k * (3 - 2 * k);
    if (this.stops) {
      // No faster than she can lose again by her berth; never past it.
      const left = Math.max(0, this.length - this.sailed);
      this.speed = Math.min(this.speed, Math.sqrt(2 * LANDING_SLOW * left));
      this.sailed = Math.min(this.length, this.sailed + Math.max(this.speed, left > 0 ? 0.05 : 0) * dt);
      if (this.sailed >= this.length) this.speed = 0;
      return;
    }
    this.sailed += this.speed * dt;
  }
  /** The whole way (m). */
  get length(): number {
    return this.legs.reduce((a, g) => a + g.m, 0);
  }
  /** An arrival has reached her berth. */
  get alongside(): boolean {
    return this.stops && this.sailed >= this.length;
  }
  /** Where she is now. Past the end of the way she carries on down the last leg. */
  get state(): DockState {
    let left = this.sailed;
    for (let i = 0; i < this.legs.length; i++) {
      const g = this.legs[i];
      if (left <= g.m || i === this.legs.length - 1) {
        const f = left / g.m;
        return { lat: g.from.lat + (g.to.lat - g.from.lat) * f, lon: g.from.lon + (g.to.lon - g.from.lon) * f, heading: g.bearing, stw: this.speed };
      }
      left -= g.m;
    }
    return { lat: this.way[0].lat, lon: this.way[0].lon, heading: 90, stw: 0 };
  }
}

/** Whether a start leaves from the dock: your own crossing from the usual drop (or Annapolis), not a challenge with its own start. */
export function leavesFromDock(port: string, challenge: boolean): boolean {
  return !challenge && (port === "" || port === "annapolis");
}
