// Voyage replay files (schema 1, written by boatsim.runner.replay, PR #132).
//
// The page draws only what is in these files. Between two logged hours it
// interpolates (straight line for numbers, shortest way round for angles), so
// at each logged hour the page shows exactly the logged value.

export interface Course {
  drop: [number, number] | null; // lat, lon
  west_line: [number, number][];
  east_line: [number, number][];
  target: [number, number];
  target_radius_m: number;
}

export interface ReplayEvent {
  h: number;
  kind: string;
  detail: string;
}

export type Col = (number | null)[];

export interface Replay {
  schema: number;
  boat: string;
  start: string; // ISO, UTC
  end: string | null;
  seed: number;
  outcome: string;
  days: number;
  t_start_line: string | null;
  t_finish_line: string | null;
  course: Course;
  h: number[];
  lat: Col;
  lon: Col;
  heading: Col;
  stw: Col;
  soc: Col;
  wind_u: Col;
  wind_v: Col;
  hs: Col;
  tp: Col;
  wave_dir: Col;
  current_u: Col;
  current_v: Col;
  ghi: Col;
  events: ReplayEvent[];
}

export interface IndexEntry {
  file: string;
  boat: string;
  start: string;
  outcome: string;
  days: number;
}

export async function loadIndex(base: string): Promise<IndexEntry[]> {
  const r = await fetch(`${base}/index.json`);
  if (!r.ok) throw new Error(`no voyages found (${base}/index.json: ${r.status})`);
  const j = (await r.json()) as { voyages: IndexEntry[] };
  return j.voyages;
}

export async function loadReplay(base: string, file: string): Promise<Replay> {
  const r = await fetch(`${base}/${file}`);
  if (!r.ok) throw new Error(`${file}: ${r.status}`);
  const rep = (await r.json()) as Replay;
  if (rep.schema !== 1) throw new Error(`${file}: replay schema ${rep.schema}, this page reads schema 1`);
  return rep;
}

/** Index i and fraction f with h[i] <= hour <= h[i+1] (clamped to the ends). */
export function locate(h: number[], hour: number): [number, number] {
  const n = h.length;
  if (n === 0) return [0, 0];
  if (hour <= h[0]) return [0, 0];
  if (hour >= h[n - 1]) return [n - 1, 0];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (h[mid] <= hour) lo = mid;
    else hi = mid;
  }
  const span = h[hi] - h[lo];
  return [lo, span > 0 ? (hour - h[lo]) / span : 0];
}

/** Last non-null value at or before i, else the first non-null after it, else null. */
function nearest(col: Col, i: number): number | null {
  for (let k = i; k >= 0; k--) if (col[k] != null) return col[k];
  for (let k = i + 1; k < col.length; k++) if (col[k] != null) return col[k];
  return null;
}

export function valueAt(rep: Replay, col: Col, hour: number): number | null {
  const [i, f] = locate(rep.h, hour);
  const a = col[i] ?? nearest(col, i);
  if (f === 0 || i + 1 >= col.length) return a;
  const b = col[i + 1] ?? a;
  if (a == null || b == null) return a ?? b;
  return a + (b - a) * f;
}

/** Angle in degrees, interpolated the short way round. */
export function angleAt(rep: Replay, col: Col, hour: number): number | null {
  const [i, f] = locate(rep.h, hour);
  const a = col[i] ?? nearest(col, i);
  if (f === 0 || i + 1 >= col.length) return a;
  const b = col[i + 1] ?? a;
  if (a == null || b == null) return a ?? b;
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + d * f) % 360) + 360) % 360;
}

/** Boat position (lat, lon) at an hour. Exactly the logged values at logged hours. */
export function positionAt(rep: Replay, hour: number): [number, number] {
  return [valueAt(rep, rep.lat, hour) ?? NaN, valueAt(rep, rep.lon, hour) ?? NaN];
}

export function lastHour(rep: Replay): number {
  return rep.h.length ? rep.h[rep.h.length - 1] : 0;
}

/** Great-circle distance, km. */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const r = Math.PI / 180;
  const dlat = (b[0] - a[0]) * r;
  const dlon = (b[1] - a[1]) * r;
  const s = Math.sin(dlat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Plain words for an event, for John. */
export function describeEvent(e: ReplayEvent): string {
  const d = e.detail ? `: ${e.detail}` : "";
  switch (e.kind) {
    case "start_line":
      return "Crossed the race's starting line";
    case "finish_line":
      return "Crossed the race's finish line" + d;
    case "arrived":
      return "Reached the finish target";
    case "part_failed":
      return "Part failed" + d;
    case "capsize":
      return "Knocked over by a wave" + d;
    case "safe_mode":
      return "Backup controller took over" + d;
    case "battery_empty":
      return "Battery ran flat" + d;
    case "ship_strike":
      return "Hit by a ship" + d;
    case "lost":
      return "Boat lost" + d;
    case "aground":
      return "Ran aground" + d;
    case "disqualified":
      return "Disqualified" + d;
    case "timeout":
      return "Still at sea when the simulation stopped";
    case "mission_updated":
      return "New route from home" + d;
    default:
      return e.kind.replace(/_/g, " ") + d;
  }
}

/** Events worth a marker and a pop-up (routine messages are left out). */
export function isNotable(e: ReplayEvent): boolean {
  return !["message_sent", "message_received", "mission_updated"].includes(e.kind);
}

export type Tone = "good" | "bad" | "warn" | "info";
export function toneOf(e: ReplayEvent): Tone {
  if (["arrived", "start_line", "finish_line"].includes(e.kind)) return "good";
  if (["lost", "aground", "disqualified", "ship_strike", "battery_empty"].includes(e.kind)) return "bad";
  if (["part_failed", "capsize", "safe_mode", "timeout"].includes(e.kind)) return "warn";
  if (/silent|iridium|comms/i.test(e.detail)) return "warn";
  return "info";
}
