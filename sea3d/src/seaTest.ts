// Test hook for pictures of the sea (never in a player-facing link): fixed sea
// states and suns, so before/after frames compare like with like.
//
//   voyage.html?voyage=2020-04-15&seatest=f8&sun=dusk
//
// seatest: calm (Beaufort 1), f5 (Beaufort 5), f8 (Beaufort 8) or bay (Chesapeake, Beaufort 4). Wind speeds
// sit mid-band (WMO Beaufort table); the wind sea is the fully developed sea for
// that wind where the fetch allows (Pierson-Moskowitz, Hs = 0.0246 U^2, capped
// for force 8 at a typical North Atlantic 5 m), with a swell from another
// direction, as the open Atlantic usually has (crossed seas, Elena).
// sun: noon (60 deg up), dusk (3 deg up) or night (25 deg down: the moon's light), in the direction the camera faces
// for the long-lens shot (light from behind the boat).

import type { WaveSystem } from "./waves";

export interface SeaTest {
  name: string;
  wind: number; // m/s, 10 m above the sea
  ws: WaveSystem; // wind sea, from the wind's direction
  s1: WaveSystem | null; // swell
  bay?: boolean; // Chesapeake Bay water
}

/** Wind and swell directions are compass degrees the waves come FROM. */
export const SEA_TESTS: Record<string, SeaTest> = {
  calm: { name: "Calm, force 1", wind: 1.5, ws: { hs: 0.05, tp: 1.5, dirFrom: 250 }, s1: { hs: 0.5, tp: 11, dirFrom: 300 } },
  f5: { name: "Force 5", wind: 9.4, ws: { hs: 2.0, tp: 6.6, dirFrom: 250 }, s1: { hs: 1.0, tp: 11, dirFrom: 300 } },
  // Chesapeake Bay in a moderate breeze (12 kt, Sam's checklist): fetch-limited chop
  // over ~30 km of Bay (place.ts fetchSea gives Hs 0.55 m, Tp 3.6 s), no ocean swell.
  bay: { name: "Bay, force 4", wind: 6.2, ws: { hs: 0.55, tp: 3.6, dirFrom: 200 }, s1: null, bay: true },
  f8: { name: "Force 8", wind: 19, ws: { hs: 5.5, tp: 10.5, dirFrom: 250 }, s1: { hs: 1.5, tp: 13, dirFrom: 300 } },
};

export const SUN_TESTS: Record<string, { el: number; az: number }> = {
  noon: { el: 60, az: 200 },
  dusk: { el: 3, az: 250 },
  golden: { el: 9, az: 250 }, // Hana's sky frames
  blue: { el: -4, az: 250 },
  night: { el: -25, az: 250 },
};

/** The test sea and sun this page was asked for, if any. */
export function seaTestFrom(search: string): { sea: SeaTest | null; sun: { el: number; az: number } | null } {
  const q = new URLSearchParams(search);
  return { sea: SEA_TESTS[q.get("seatest") ?? ""] ?? null, sun: SUN_TESTS[q.get("sun") ?? ""] ?? null };
}
