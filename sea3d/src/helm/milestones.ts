// Milestones on the crossing (#331, Leo's usability review, item 6): for 70 days the only
// progress was "5,256 km to the finish" counting down. This gives the crossing a few real places
// to pass on the way, each with a small moment (a bell, and a note about the place), and a thin
// strip that shows how far along she is.
//
// Every milestone is a real place, and it is passed when the boat is as close to the finish as
// that place is. Nothing here changes the voyage: it only reads the simulator's "km to the
// finish" and the boat's position, and words them.
//
// Pure: no page code. The page (src/helm.ts) draws the strip and shows the notes.

export type LatLon = [number, number];

/** A real place the crossing passes. Positions read off a chart, to about a tenth of a degree. */
interface Place {
  id: string;
  /** The strip's short label. */
  name: string;
  at: LatLon;
}

// GUESS (chart positions, not from a dataset): the edge of the continental shelf east of the
// Chesapeake's mouth, where the 200 m depth line runs; the Tail of the Grand Banks at 50 W,
// where the Gulf Stream is taken to end and become the North Atlantic Current; and Horta, the
// harbour on Faial in the Azores.
const SHELF_EDGE: LatLon = [36.65, -74.6];
const GULF_STREAM_END: LatLon = [40.0, -50.0];
export const HORTA: LatLon = [38.53, -28.63];
/** Where the Titanic lies (41°44' N, 49°57' W), for the note at the Grand Banks. */
export const TITANIC: LatLon = [41.73, -49.95];

const PLACES: Place[] = [
  { id: "shelf", name: "Off the shelf", at: SHELF_EDGE },
  { id: "gulfstream", name: "End of the Gulf Stream", at: GULF_STREAM_END },
  { id: "azores", name: "The Azores", at: HORTA },
];

export interface Milestone {
  id: string;
  name: string;
  /** Passed when the boat has this many km, or fewer, to the finish. */
  kmToGo: number;
}

export function kmBetween(a: LatLon, b: LatLon): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function bearingTo(a: LatLon, b: LatLon): number {
  const [la1, lo1] = a.map((v) => (v * Math.PI) / 180);
  const [la2, lo2] = b.map((v) => (v * Math.PI) / 180);
  const y = Math.sin(lo2 - lo1) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(lo2 - lo1);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const compassWord = (deg: number) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** A crossing shorter than this has no strip: a start most of the way over has nothing left to pass (GUESS). */
export const MIN_CROSSING_KM = 1500;

/**
 * The milestones for a crossing that starts with `startKm` to the finish, in the order she
 * passes them, the finish last. A place she starts beyond (a start from a port further east)
 * is left out, as is one within a day's sail of the start line or of halfway. Empty for a
 * short voyage.
 */
export function crossingMilestones(startKm: number, finish: LatLon, radiusKm: number): Milestone[] {
  if (!(startKm >= MIN_CROSSING_KM)) return [];
  const half = startKm / 2;
  const out: Milestone[] = [{ id: "half", name: "Halfway", kmToGo: half }];
  for (const p of PLACES) {
    const km = Math.max(kmBetween(p.at, finish) - radiusKm, 0);
    // Not one she has already passed at the start, and not one on top of the halfway mark.
    if (km < startKm - 5 && km > 100 && Math.abs(km - half) > 100) out.push({ id: p.id, name: p.name, kmToGo: km });
  }
  out.sort((a, b) => b.kmToGo - a.kmToGo);
  out.push({ id: "finish", name: "The finish", kmToGo: 0 });
  return out;
}

/** How far along she is, 0 at the start to 1 at the finish. */
export function fraction(startKm: number, toGoKm: number): number {
  return startKm > 0 ? Math.min(Math.max(1 - toGoKm / startKm, 0), 1) : 0;
}

/** The next milestone still ahead, or null at the finish. */
export function nextMilestone(ms: Milestone[], toGoKm: number): Milestone | null {
  return ms.find((m) => m.kmToGo < toGoKm) ?? null;
}

/** The strip's one line: what comes next and how far off it is. */
export function nextWords(ms: Milestone[], toGoKm: number, about = false): string {
  const n = nextMilestone(ms, toGoKm);
  if (!n) return "";
  if (n.id === "finish") return "Last leg: the finish is next";
  const km = Math.max(Math.round(toGoKm - n.kmToGo), 1);
  return `Next: ${n.id === "half" ? "halfway" : n.name.replace(/^(Off|End|The)\b/, (w) => w.toLowerCase())}, ${about ? "about " : ""}${km.toLocaleString("en-US")} km`;
}

/** "about 240 km to the north" from `here` to a place. */
function away(here: LatLon, place: LatLon): string {
  const km = kmBetween(here, place);
  const shown = km >= 100 ? Math.round(km / 10) * 10 : Math.max(Math.round(km), 1);
  return `about ${shown.toLocaleString("en-US")} km to the ${compassWord(bearingTo(here, place))}`;
}

/**
 * The note for a milestone just passed, with the boat at `here`: what the place is, in plain
 * words, and one true thing about it. `hl` is the part to pick out in colour. The finish has no
 * note: the arrival is its moment.
 */
export function milestoneNote(m: Milestone, here: LatLon, startKm: number): { text: string; hl: string } | null {
  switch (m.id) {
    case "shelf":
      return {
        hl: "Off the continental shelf.",
        text: "Off the continental shelf. The seabed falls away here from about 200 m to more than 2,000 m: it is open ocean from now on.",
      };
    case "gulfstream":
      return {
        hl: "The end of the Gulf Stream.",
        text: `The end of the Gulf Stream. South of the Grand Banks of Newfoundland the warm current spreads out across the Atlantic. The wreck of the Titanic lies ${away(here, TITANIC)}.`,
      };
    case "half": {
      const km = Math.round(startKm / 2).toLocaleString("en-US");
      return { hl: "Halfway.", text: `Halfway. ${km} km behind her, ${km} km to the finish.` };
    }
    case "azores":
      return {
        hl: "Passing the Azores.",
        text: `Passing the Azores. The island of Faial is ${away(here, HORTA)}. Its harbour, Horta, is the classic stop on an Atlantic crossing, but she can't call in: touching land would end her voyage.`,
      };
    default:
      return null;
  }
}

/**
 * Watches one voyage's "km to the finish" and says which milestones she has just passed.
 * Whatever is already behind her at the first look (a voyage picked up where it was left) is
 * taken as passed, quietly. A milestone is passed once: drifting back over it does not undo it.
 */
export class MilestoneWatch {
  private best = Number.POSITIVE_INFINITY;
  private first = true;

  constructor(readonly milestones: Milestone[]) {}

  /** The latest reading. Returns the milestones passed since the last one, in order. */
  see(toGoKm: number): Milestone[] {
    if (!Number.isFinite(toGoKm)) return [];
    const was = this.best;
    this.best = Math.min(this.best, toGoKm);
    if (this.first) {
      this.first = false;
      return [];
    }
    return this.milestones.filter((m) => m.kmToGo < was && m.kmToGo >= this.best);
  }

  /** Has she passed this one? */
  passed(m: Milestone): boolean {
    return m.kmToGo >= this.best;
  }
}
