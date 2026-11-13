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
  /** Rain rate, mm per hour (ERA5 total precipitation), in newer replays. */
  rain?: Col;
  wind_v: Col;
  hs: Col;
  tp: Col;
  wave_dir: Col;
  current_u: Col;
  current_v: Col;
  ghi: Col;
  iridium_ok?: Col; // 1/0 per hour (from PR #135); absent in older files
  beacon_ok?: Col;
  /** A yacht's lean, deg, + = to starboard (stock vessels; runner/replay.py). */
  heel?: Col;
  /** A yacht's sails: "full", "reef1", "reef2", "storm", "main_only" or "down". */
  sail_plan?: (string | null)[];
  /** 1 = a yacht's engine is running. */
  engine?: Col;
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

/**
 * A replay file. `file` is a path under `base`, or a full URL on this page's own
 * origin (a Boatyard launch hands over blob: URLs made in the browser).
 */
export async function loadReplay(base: string, file: string): Promise<Replay> {
  const r = await fetch(replayUrl(base, file));
  if (!r.ok) throw new Error(`${file}: ${r.status}`);
  const rep = (await r.json()) as Replay;
  if (rep.schema !== 1) throw new Error(`${file}: replay schema ${rep.schema}, this page reads schema 1`);
  return rep;
}

/** Where a replay lives: same-origin absolute URLs (blob: included) as they are, else under base. */
export function replayUrl(base: string, file: string, origin = globalThis.location?.origin): string {
  if (/^(blob:|https?:)/.test(file)) {
    if (new URL(file).origin !== origin) throw new Error(`${file}: replays are only read from this site`);
    return file;
  }
  return `${base}/${file}`;
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

/** The sail plan in force at an hour (the last logged one), or null if the replay has none. */
export function planAt(rep: Replay, hour: number): string | null {
  if (!rep.sail_plan) return null;
  const [i] = locate(rep.h, hour);
  for (let k = i; k >= 0; k--) if (rep.sail_plan[k] != null) return rep.sail_plan[k];
  return null;
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

/** Turned over for good by `hour` (a dinghy or cat with nobody to right it): the voyage ended "capsized
 * ... stayed over". The log's last row can come a little before the final event, so at the last row it counts. */
export function stayedOver(rep: Replay, hour: number): boolean {
  const atEnd = hour >= lastHour(rep) - 1e-6;
  return rep.events.some((e) => (e.h <= hour || atEnd) && e.kind === "lost" && /capsiz|stayed over/i.test(e.detail));
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
/** A part_failed event's part name ("rudder") and the log's reason ("knockdown"). */
export function failedPart(e: ReplayEvent): { part: string; why: string } {
  const m = /^(\w+)\s*(?:\((.*)\))?/.exec(e.detail ?? "");
  return { part: m?.[1] ?? "", why: m?.[2] ?? "" };
}

/** Plain names for the parts that can break, for the equipment card. */
export const PART_NAME: Record<string, string> = {
  thruster_port: "Left motor",
  thruster_starboard: "Right motor",
  rudder: "Rudder",
  sail: "Wing sail",
  electronics_main: "Main computer",
  electronics_safe: "Backup computer",
  comms_silent: "Satellite radio",
  beacon: "Backup beacon",
  leak_main_tub: "Hull",
  leak_safe_tub: "Hull",
  entangled: "No snags",
};

/** Plain-English pop-up for a broken part (no sailing words). boat: the replay's boat name. */
export function partText(e: ReplayEvent, boat = ""): string {
  const { part, why } = failedPart(e);
  const sailboat = /randolph/i.test(boat);
  switch (part) {
    case "thruster_port":
      return "The left motor broke. The right one keeps the boat going, a bit slower.";
    case "thruster_starboard":
      return "The right motor broke. The left one keeps the boat going, a bit slower.";
    case "rudder":
      if (/knockdown/i.test(why)) return "A big wave broke the rudder. It swings loose now, so the boat can't steer well.";
      return sailboat
        ? "The steering motor failed. A spring holds the rudder straight, so the boat goes where wind and current take it."
        : "The steering motor failed. A spring holds the rudder straight; the boat steers by running its two motors at different speeds.";
    case "sail":
      return "A big wave knocked the boat flat and tore the wing sail. It can barely sail now.";
    case "electronics_main":
      return sailboat
        ? "The boat's only computer box failed. It can't steer or call home any more."
        : "The main computer box failed. The backup box takes over.";
    case "electronics_safe":
      return "The backup computer box failed.";
    case "comms_silent":
      return sailboat
        ? "The satellite radio stopped working. Only the small backup tracker can say where the boat is now."
        : "The satellite radio stopped working. Only the small backup beacon can say where the boat is now.";
    case "beacon":
      return sailboat ? "The small backup tracker stopped working." : "The small backup beacon stopped working.";
    case "leak_main_tub":
    case "leak_safe_tub":
      return "Water is getting into the hull.";
    case "entangled":
      return "Fishing line or seaweed got caught on the boat and slows it down.";
    default:
      return "Something broke" + (e.detail ? `: ${e.detail}` : "");
  }
}

/** Parts broken by this hour, with the log's reason. */
export function failuresAt(rep: Replay, hour: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of rep.events) {
    if (e.h > hour) break;
    if (e.kind !== "part_failed") continue;
    const { part, why } = failedPart(e);
    if (part && !out.has(part)) out.set(part, why);
  }
  return out;
}

/** The plain-English line for each event kind made from the feed. */
export const FEED_EVENTS: Record<string, string> = {
  reports_stopped: "The main box's daily reports stopped. Only the backup beacon is heard now.",
  reports_back: "Daily reports from the main box are back.",
  beacon_quiet: "The backup beacon has gone quiet.",
  one_motor: "The boat reports one motor down.",
  motors_off: "The boat switched its motors off to save the battery.",
  safe_box_down: "The boat reports its backup box is down.",
  lost_comms: "The boat says it hasn't heard from home for a while.",
};

export function describeEvent(e: ReplayEvent, boat = ""): string {
  if (FEED_EVENTS[e.kind]) return FEED_EVENTS[e.kind];
  const d = e.detail ? `: ${e.detail}` : "";
  switch (e.kind) {
    case "start_line":
      return "Crossed the race's starting line";
    case "finish_line":
      return "Crossed the race's finish line" + d;
    case "arrived":
      return "Reached the finish target";
    case "part_failed":
      return partText(e, boat);
    case "capsize": {
      const m = /(\d+) knockdown\(s\), Hs ([\d.]+) m/.exec(e.detail);
      if (m) return `Knocked flat by a breaking wave${m[1] !== "1" ? ` (${m[1]} times)` : ""}, waves ${m[2]}\u00a0m`; // no-break space: "m" never wraps alone (audit A1)
      return "Knocked flat by a breaking wave" + d;
    }
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
  if (["part_failed", "capsize", "safe_mode", "timeout", "reports_stopped", "beacon_quiet", "one_motor", "motors_off", "safe_box_down", "lost_comms"].includes(e.kind)) return "warn";
  if (/silent|iridium|comms/i.test(e.detail)) return "warn";
  return "info";
}

/** Comms at an hour: "ok", "beacon" (only the backup beacon), "silent", or null if the file doesn't say. */
export function commsAt(rep: Replay, hour: number): "ok" | "beacon" | "silent" | null {
  if (!rep.iridium_ok) return null;
  const [i] = locate(rep.h, hour);
  const ir = rep.iridium_ok[i];
  const bc = rep.beacon_ok?.[i];
  if (ir == null) return null;
  if (ir) return "ok";
  return bc ? "beacon" : "silent";
}
