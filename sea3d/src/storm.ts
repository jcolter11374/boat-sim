// How a blow looks, by the Beaufort scale (the sailor's 0-12 wind scale, each force
// with a description of the sea). The sea shader, the spindrift and the haze read
// these numbers, so a gale looks like a gale whichever page shows it.
//
//   force 6 (22-27 kn)  large waves begin to form; white foam crests are more extensive
//   force 7 (28-33 kn)  sea heaps up; white foam from breaking waves begins to be blown in streaks
//   force 8 (34-40 kn)  edges of crests begin to break into spindrift; foam blown in well-marked streaks
//   force 9 (41-47 kn)  dense streaks of foam; spray may affect visibility
//   force 10 (48-55 kn) the sea takes on a white appearance; visibility affected
//   force 12 (64+ kn)   the air filled with foam and spray; sea completely white
// (World Meteorological Organization, Beaufort scale descriptions.)

import * as THREE from "three";

const smooth = THREE.MathUtils.smoothstep;

/** Beaufort force (fractional) for a wind in m/s: v = 0.836 B^(3/2). */
export function beaufort(windMs: number): number {
  return Math.pow(Math.max(windMs, 0) / 0.836, 2 / 3);
}

/** Share of the sea white with breaking crests (Monahan and O'Muircheartaigh 1980), up to a third. */
export function whitecaps(windMs: number): number {
  return THREE.MathUtils.clamp(3.84e-6 * Math.max(windMs, 0) ** 3.41, 0, 0.3);
}

/** Share of the sea under streaks of blown foam: none below force 7, well marked by force 8
 *  (the WMO's words), most of it by force 10. GUESS: the steepness is display tuning (Elena). */
export function foamStreaks(windMs: number): number {
  return 0.6 * smooth(beaufort(windMs), 7, 10);
}

/**
 * Share of the sea that looks white from crests, for drawing: Monahan's fit (whitecaps())
 * counts only the crests breaking now; the foam they leave behind covers a few times more
 * (Monahan and Woolf 1989), and from force 6 up the WMO's descriptions put white crests over
 * a good share of the sea (Elena: "the HUD says 37 kn, the sea has to look it").
 * GUESS: the factor, 1 up to force 5, about 3.3 at force 8, 3.5 from 8.5 up.
 */
export function whiteCrests(windMs: number): number {
  return Math.min(whitecaps(windMs) * (1 + 2.5 * smooth(beaufort(windMs), 5.5, 8.5)), 0.6);
}

/** All the white on the sea, crests and streaks: about half at force 10, nearly all at 12. */
export function whiteSea(windMs: number): number {
  return Math.min(whitecaps(windMs) + foamStreaks(windMs), 0.95);
}

/** Spray torn off the crests and blown downwind (spindrift), 0..1: begins at force 8, thick by 10. */
export function spindrift(windMs: number): number {
  return smooth(beaufort(windMs), 7.5, 10.5);
}

/**
 * How far you can see through the spray (m), or Infinity when it doesn't matter:
 * a few km at force 9, about a kilometre at 10, a few hundred metres at 12.
 */
export function sprayVisibility(windMs: number): number {
  const b = beaufort(windMs);
  if (b < 8.5) return Infinity;
  return 300 + 6000 * Math.exp(-(b - 8.5) * 1.15);
}
