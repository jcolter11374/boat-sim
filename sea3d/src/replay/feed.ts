// The live tracker feed (Sam, docs: /mnt/project-files/tracker/live-feed-spec.md, PR #176):
// voyage.json (every position report: the main box's daily Iridium report and the
// backup beacon's pings) and ghost.json (the simulator's forecast from the latest
// report). This turns them into the replay shape the voyage page already draws:
// the reported track up to now, then the forecast's middle path after it.
//
// Nothing is made up: between reports the boat is drawn on a straight line, the
// sea state isn't reported (the page shows a moderate sea and says so), and the
// battery is only shown from a report less than a day and a half old.

import { distanceKm, type Course, type Replay, type ReplayEvent } from "./data";

export interface Fix {
  t: string;
  src: "iridium" | "beacon" | string;
  lat: number;
  lon: number;
  rx?: string;
  soc?: number;
  hdg?: number;
  mode?: string;
  flags?: Record<string, boolean> | null;
}
export interface FeedVoyage {
  schema: number;
  updated: string;
  voyage: {
    name: string;
    start: { t: string; lat: number; lon: number };
    finish: { lat: number; lon: number; radius_km: number };
    status: string;
    rules?: { silent_days_in_a_row: number; silent_days_total: number };
    near_land_delay?: { km: number; hours: number };
    /** Present when the feed is a simulated voyage, not the real boat. */
    replay?: { weather: string };
  };
  fixes: Fix[];
  routes: { sent: string; version: number; kind: string; waypoints?: [number, number][] }[];
  summary: { days_at_sea: number; km_sailed: number; km_to_finish: number; last_fix_age_h: number; silent_days_total: number };
}
export interface FeedGhost {
  schema: number;
  from_fix: string;
  made: string;
  runs: number;
  median: [string, number, number][];
  spread: [string, number, number, number][]; // t, lat, lon, radius km
  eta: { p10: string; p50: string; p90: string };
  p_finish: number;
}

export const FEED_BASE = "https://raw.githubusercontent.com/jcolter11374/boat-sim/feed/";

/** A live voyage on the page: the replay to draw, and where "now" is in it. */
export interface Tracked {
  rep: Replay;
  /** Hours from the start to the latest report, and to the feed's "now" (latest report + its age). */
  lastFixHour: number;
  nowHour: number;
  /** Hours after nowHour are the forecast. */
  ghost: FeedGhost | null;
  simulated: boolean;
  fixes: Fix[]; // sorted by time
}

const HOUR = 3600e3;
const utc = (s: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);


/**
 * Feed -> replay. course gives the race lines (the feed only has the start and target);
 * any replay file's course will do, since every voyage uses the same race.
 */
export function feedToReplay(v: FeedVoyage, ghost: FeedGhost | null, course: Course): Tracked {
  const t0 = utc(v.voyage.start.t);
  const fixes = [...v.fixes].filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon)).sort((a, b) => utc(a.t) - utc(b.t));
  // One row per report time; an Iridium report wins over a beacon ping at the same time.
  const rows: { h: number; fix: Fix; ir: boolean; bc: boolean }[] = [];
  for (const f of fixes) {
    const h = (utc(f.t) - t0) / HOUR;
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.h - h) < 1e-6) {
      if (f.src === "iridium") last.fix = f;
      last.ir ||= f.src === "iridium";
      last.bc ||= f.src === "beacon";
    } else rows.push({ h, fix: f, ir: f.src === "iridium", bc: f.src === "beacon" });
  }
  if (!rows.length || rows[0].h > 0) rows.unshift({ h: 0, fix: { t: v.voyage.start.t, src: "start", lat: v.voyage.start.lat, lon: v.voyage.start.lon }, ir: true, bc: true });

  // Comms per row: was the main box reporting? (a report within 36 h either side of the daily cycle)
  const irHours = rows.filter((r) => r.ir).map((r) => r.h);
  const bcHours = rows.filter((r) => r.bc).map((r) => r.h);
  const near = (hs: number[], h: number, gap: number) => hs.some((x) => x <= h + 1e-6 && h - x <= gap);
  const lastFixHour = rows[rows.length - 1].h;
  const nowHour = Math.max(lastFixHour, (utc(v.updated) - t0) / HOUR, lastFixHour + (v.summary?.last_fix_age_h ?? 0));

  const rep: Replay = {
    schema: 1,
    boat: v.voyage.name,
    start: new Date(t0).toISOString(),
    end: null,
    seed: 0,
    outcome: v.voyage.status,
    days: nowHour / 24,
    t_start_line: null,
    t_finish_line: null,
    course: { ...course, drop: [v.voyage.start.lat, v.voyage.start.lon], target: [v.voyage.finish.lat, v.voyage.finish.lon], target_radius_m: v.voyage.finish.radius_km * 1000 },
    h: [],
    lat: [],
    lon: [],
    heading: [],
    stw: [],
    soc: [],
    wind_u: [],
    wind_v: [],
    hs: [],
    tp: [],
    wave_dir: [],
    current_u: [],
    current_v: [],
    ghi: [],
    iridium_ok: [],
    beacon_ok: [],
    events: [],
  };
  const push = (h: number, lat: number, lon: number, hdg: number | null, speed: number | null, soc: number | null, ir: number, bc: number) => {
    rep.h.push(h);
    rep.lat.push(lat);
    rep.lon.push(lon);
    rep.heading.push(hdg);
    rep.stw.push(speed);
    rep.soc.push(soc);
    for (const c of [rep.wind_u, rep.wind_v, rep.hs, rep.tp, rep.wave_dir, rep.current_u, rep.current_v, rep.ghi]) c.push(null);
    rep.iridium_ok!.push(ir);
    rep.beacon_ok!.push(bc);
  };
  rows.forEach((r, k) => {
    const next = rows[k + 1] ?? null;
    const prev = rows[k - 1] ?? null;
    // Heading and speed over the leg ahead (or the one behind, for the last report).
    const [a, b] = next ? [r, next] : prev ? [prev, r] : [r, r];
    const hrs = b.h - a.h;
    const km = distanceKm([a.fix.lat, a.fix.lon], [b.fix.lat, b.fix.lon]);
    const speed = hrs > 0 ? (km * 1000) / (hrs * 3600) : null;
    const hdg = r.fix.hdg ?? (km > 0.01 ? bearing([a.fix.lat, a.fix.lon], [b.fix.lat, b.fix.lon]) : null);
    const ir = near(irHours, r.h, 36) ? 1 : 0;
    const bc = near(bcHours, r.h, 12) ? 1 : 0;
    push(r.h, r.fix.lat, r.fix.lon, hdg, speed, r.fix.src === "iridium" ? r.fix.soc ?? null : null, ir, bc);
  });

  // "Now": still where it last reported (no guessing between reports and now).
  const last = rows[rows.length - 1];
  if (nowHour > lastFixHour + 1e-6) {
    const k = rep.h.length - 1;
    push(nowHour, last.fix.lat, last.fix.lon, rep.heading[k], rep.stw[k], null, rep.iridium_ok![k]!, rep.beacon_ok![k]!);
  }

  // The forecast after now: the ghost's middle path (comms 0: the chart draws it as a grey dashed line).
  if (ghost?.median?.length) {
    for (const [t, lat, lon] of ghost.median) {
      const h = (utc(t) - t0) / HOUR;
      if (h <= rep.h[rep.h.length - 1] + 1e-6) continue;
      const k = rep.h.length - 1;
      const hrs = h - rep.h[k];
      const km = distanceKm([rep.lat[k]!, rep.lon[k]!], [lat, lon]);
      push(h, lat, lon, bearing([rep.lat[k]!, rep.lon[k]!], [lat, lon]), (km * 1000) / (hrs * 3600), null, 0, 0);
    }
  }

  rep.events = feedEvents(v, rows, t0);
  return { rep, lastFixHour, nowHour, ghost: ghost?.median?.length ? ghost : null, simulated: !!v.voyage.replay, fixes };
}

function feedEvents(v: FeedVoyage, rows: { h: number; fix: Fix; ir: boolean; bc: boolean }[], t0: number): ReplayEvent[] {
  const out: ReplayEvent[] = [];
  const add = (h: number, kind: string, detail = "") => out.push({ h, kind, detail });
  // Flags turning on in the main box's reports.
  const seen = new Set<string>();
  const FLAG_EVENT: Record<string, string> = { one_thruster: "one_motor", motors_off: "motors_off", safe_box_down: "safe_box_down", lost_comms: "lost_comms", safe_mode: "safe_mode" };
  for (const r of rows) {
    if (r.fix.src !== "iridium" || !r.fix.flags) continue;
    for (const [flag, kind] of Object.entries(FLAG_EVENT)) {
      const on = !!r.fix.flags[flag];
      if (on && !seen.has(flag)) add(r.h, kind, kind === "safe_mode" ? "(reported)" : "");
      if (on) seen.add(flag);
      else seen.delete(flag);
    }
  }
  // Daily reports stopping (more than a day and a half with beacon pings but no report), and coming back.
  const ir = rows.filter((r) => r.ir).map((r) => r.h);
  for (let k = 0; k < ir.length; k++) {
    const after = ir[k + 1];
    const lastH = rows[rows.length - 1].h;
    if ((after ?? lastH) - ir[k] > 36 && rows.some((r) => r.h > ir[k] + 36)) {
      add(ir[k] + 36, "reports_stopped");
      if (after != null) add(after, "reports_back");
    }
  }
  // Routes sent from home.
  for (const r of v.routes ?? []) if (r.kind === "route") add((utc(r.sent) - t0) / HOUR, "mission_updated", `(route ${r.version})`);
  return out.sort((a, b) => a.h - b.h);
}

/** Initial compass bearing from a to b, degrees. */
export function bearing(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return ((Math.atan2(y, x) / r) % 360 + 360) % 360;
}

/** The newest main-box report at or before an hour (for the battery and the boat's own status). */
export function reportAt(tr: Tracked, hour: number): Fix | null {
  const t0 = utc(tr.rep.start);
  let best: Fix | null = null;
  for (const f of tr.fixes) {
    if ((utc(f.t) - t0) / HOUR > hour + 1e-6) break;
    if (f.src === "iridium") best = f;
  }
  return best;
}

/** Hours since the newest report of any kind at an hour. */
export function reportAgeH(tr: Tracked, hour: number): number {
  const t0 = utc(tr.rep.start);
  let last = 0;
  for (const f of tr.fixes) {
    const h = (utc(f.t) - t0) / HOUR;
    if (h > hour + 1e-6) break;
    last = h;
  }
  return hour - last;
}

export async function loadFeed(base: string): Promise<{ voyage: FeedVoyage; ghost: FeedGhost | null }> {
  // The feed is replaced hourly; ask past the browser cache so "now" is now.
  const get = (f: string) => fetch(`${base}${f}`, { cache: "no-cache" });
  const [vr, gr] = await Promise.all([get("voyage.json"), get("ghost.json").catch(() => null)]);
  if (!vr.ok) throw new Error(`tracker feed: voyage.json ${vr.status}`);
  const voyage = (await vr.json()) as FeedVoyage;
  if (voyage.schema !== 1) throw new Error(`tracker feed schema ${voyage.schema}, this page reads schema 1`);
  const ghost = gr?.ok ? ((await gr.json()) as FeedGhost) : null;
  return { voyage, ghost: ghost?.schema === 1 ? ghost : null };
}
