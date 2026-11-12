// Practice courses off Annapolis (Leo's plan, Maya approved 12 Nov): a small triangle laid
// to the wind in open water east of the harbour, and a longer leg down to Thomas Point
// Light. Practice only: times stay in this browser and never feed a voyage, the odds or
// the leaderboard (Maya's condition 1).

export interface LatLon {
  lat: number;
  lon: number;
}
export interface XY {
  x: number; // metres east
  y: number; // metres north
}

const M_PER_DEG = 111_320;
export const toXY = (o: LatLon, p: LatLon): XY => ({
  x: (p.lon - o.lon) * M_PER_DEG * Math.cos((o.lat * Math.PI) / 180),
  y: (p.lat - o.lat) * M_PER_DEG,
});
export const toLatLon = (o: LatLon, p: XY): LatLon => ({
  lat: o.lat + p.y / M_PER_DEG,
  lon: o.lon + p.x / (M_PER_DEG * Math.cos((o.lat * Math.PI) / 180)),
});
const offset = (o: LatLon, bearing: number, m: number): LatLon => {
  const b = (bearing * Math.PI) / 180;
  return toLatLon(o, { x: Math.sin(b) * m, y: Math.cos(b) * m });
};

/**
 * The middle of the triangle: open water about 3.5 km east-south-east of the harbour, with
 * more than 1 km to any water under 3 m (checked on the coast squares' depths, 12 Nov). The
 * town and the Naval Academy are in view behind, at the 2 to 5 km Iris says the squares
 * look best from.
 */
export const ANNAPOLIS_COURSE: LatLon = { lat: 38.9605, lon: -76.4465 };
/** Thomas Point Light (Iris's model, 12 Nov). It stands on the end of a shoal, with stones piled round its legs. */
export const THOMAS_POINT: LatLon = { lat: 38.8989, lon: -76.4358 };
/** Inside this the stones round the light's legs count as shallow water (Iris: keep 200 m off; GUESS 150 m to run aground). */
export const LIGHT_STONES_M = 150;
/** GUESS: 800 m legs (Leo), so every mark is about 460 m from the middle: 570 m+ clear of shallows (Iris: 500 m). */
export const LEG_M = 800;
/** Reaching a mark: within this (GUESS, about two boat lengths of slack at 10x). */
export const MARK_RADIUS_M = 40;
/** "Reaching" the lighthouse: within this, staying in deep water off its shoal (GUESS). */
export const LIGHT_RADIUS_M = 300;

export type CourseKind = "triangle" | "light";
export interface Course {
  kind: CourseKind;
  name: string;
  /** Where the boat starts, and the way it points. */
  start: LatLon;
  heading: number;
  /** The marks, in order, the last being the finish. */
  marks: (LatLon & { name: string })[];
  radiusM: number;
}

/**
 * The triangle, laid to the wind as a race committee would: start at the bottom left,
 * a beat up to the windward mark, a broad reach to the wing mark, a reach back to finish
 * where you started. fromDeg: the compass direction the wind blows from.
 */
export function triangle(fromDeg: number, centre: LatLon = ANNAPOLIS_COURSE, legM = LEG_M): Course {
  const r = legM / Math.sqrt(3);
  const start = offset(centre, fromDeg - 120, r);
  const windward = offset(centre, fromDeg, r);
  const wing = offset(centre, fromDeg + 120, r);
  return {
    kind: "triangle",
    name: "the triangle",
    start,
    // Close-hauled on port, about 15 degrees off the windward mark (it's 30 degrees off the wind from here).
    heading: (fromDeg + 45) % 360,
    marks: [
      { ...windward, name: "the windward mark" },
      { ...wing, name: "the wing mark" },
      { ...start, name: "the finish" },
    ],
    radiusM: MARK_RADIUS_M,
  };
}

/** From the course down to Thomas Point Light, about 7 km. */
export function toTheLight(): Course {
  const start = ANNAPOLIS_COURSE;
  const v = toXY(start, THOMAS_POINT);
  return {
    kind: "light",
    name: "the run to Thomas Point Light",
    start,
    heading: ((Math.atan2(v.x, v.y) * 180) / Math.PI + 360) % 360,
    marks: [{ ...THOMAS_POINT, name: "Thomas Point Light" }],
    radiusM: LIGHT_RADIUS_M,
  };
}

/** The breezes a player can pick (Leo: a beginner can ask for a gentle one). GUESS strengths. */
export const BREEZES = {
  light: { kn: 8, words: "light" },
  good: { kn: 12, words: "a good breeze" },
  fresh: { kn: 18, words: "fresh: reef if she leans too far" },
} as const;
export type Breeze = keyof typeof BREEZES;

/**
 * Where the wind comes from, picked at random among the Bay's usual directions (GUESS:
 * southerly sea breezes in summer, north-westerlies behind fronts).
 */
export const BAY_WINDS = [180, 200, 225, 160, 315, 340, 0, 135];

/** Practice best times, per course and breeze, in this browser only. */
const BEST_KEY = "boatsim.practice.best.v1";
export const bestKey = (c: CourseKind, b: Breeze) => `annapolis-${c}-${b}`;
export function readBest(key: string): number | null {
  try {
    const all = JSON.parse(localStorage.getItem(BEST_KEY) ?? "{}") as Record<string, number>;
    return Number.isFinite(all[key]) ? all[key] : null;
  } catch {
    return null;
  }
}
/** Record a time; returns the best before it (null: first time). */
export function saveBest(key: string, secs: number): number | null {
  const before = readBest(key);
  try {
    const all = JSON.parse(localStorage.getItem(BEST_KEY) ?? "{}") as Record<string, number>;
    if (before == null || secs < before) all[key] = Math.round(secs);
    localStorage.setItem(BEST_KEY, JSON.stringify(all));
  } catch {
    /* private mode: no best times */
  }
  return before;
}

export function runTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min ${String(s).padStart(2, "0")} s`;
}
