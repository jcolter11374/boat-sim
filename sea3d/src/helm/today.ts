// Today's real weather on the Set sail card (DESIGN.md M6, "live weather on the Set sail card";
// the "built but not in the game" audit, 14 Nov 2026). The Today's weather workflow (forecast.yml,
// src/boatsim/oceandata/gfs.py) bakes NOAA's newest GFS and GFS-Wave forecast every 6 hours and the
// site build copies it to public/forecast/; until now no page read it.
//
// One line under the crossing: the wind and the waves at the drop point now, and the range over the
// next five days. A forecast, so it says when NOAA issued it, and it says plainly that the crossing
// itself sails the real weather of 2020. Nothing here reaches the simulator.
//
// The file layout is the sea state files' (seastate.ts): int16 [time][field][lat][lon], lat south to
// north, lon west to east, value = int x scale, -32768 = no data (land, for the wave fields).

import { FILL, gunzip } from "../seastate";

export interface TodayHeader {
  issued: string;
  t0: string;
  step_h: number;
  nt: number;
  lat0: number;
  lon0: number;
  res: number;
  nlat: number;
  nlon: number;
  fields: { name: string; scale: number }[];
}

/** One time at one point: wind (kn, and the compass point it blows from) and the total wave height (m). */
export interface TodaySample {
  hours: number;
  windKn: number;
  windFrom: number;
  hs: number | null;
}

const KN = 1.943844;
/** The drop point off the Chesapeake, where every crossing starts (helm.ts DROP). */
export const DROP_POINT: [number, number] = [36.65, -74.94];

/** Every time step at the grid cell nearest (lat, lon); null when the point is off the grid. */
export function samplesAt(h: TodayHeader, data: Int16Array, lat: number, lon: number): TodaySample[] | null {
  const i = Math.round((lat - h.lat0) / h.res);
  const j = Math.round((lon - h.lon0) / h.res);
  if (i < 0 || j < 0 || i >= h.nlat || j >= h.nlon) return null;
  const nf = h.fields.length;
  const f = (name: string) => h.fields.findIndex((x) => x.name === name);
  const at = (t: number, k: number): number | null => {
    if (k < 0) return null;
    const v = data[((t * nf + k) * h.nlat + i) * h.nlon + j];
    return v === FILL ? null : v * h.fields[k].scale;
  };
  const [fu, fv, fw, f1, f2] = ["wind_u", "wind_v", "ws_hs", "s1_hs", "s2_hs"].map(f);
  const out: TodaySample[] = [];
  for (let t = 0; t < h.nt; t++) {
    const u = at(t, fu);
    const v = at(t, fv);
    if (u === null || v === null) continue;
    // The waves' total height from their systems' energies (each system's Hs squared adds).
    const parts = [at(t, fw), at(t, f1), at(t, f2)].filter((x): x is number => x !== null && x > 0);
    const hs = parts.length ? Math.sqrt(parts.reduce((s, x) => s + x * x, 0)) : null;
    // u, v are the direction the wind blows TOWARDS; a sailor names where it comes FROM.
    const from = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
    out.push({ hours: t * h.step_h, windKn: Math.hypot(u, v) * KN, windFrom: from, hs });
  }
  return out;
}

const POINTS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
/** "the south-west": the eight main compass points, in words (John isn't a sailor). */
export function pointName(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** The forecast is too old to call "today" after this many hours past its issue time. */
export const STALE_H = 36;

/**
 * The card's two short sentences, or null when there is nothing honest to say (no data, or too old).
 * `nowMs`: the time now. The "now" sample is the step nearest it; the outlook is the rest of the forecast.
 */
export function todayWords(h: TodayHeader, s: TodaySample[] | null, nowMs: number): string[] | null {
  if (!s?.length) return null;
  const t0 = Date.parse(h.t0.replace(/Z?$/, "Z"));
  const issued = Date.parse(h.issued.replace(/Z?$/, "Z"));
  if (!Number.isFinite(t0) || !Number.isFinite(issued) || (nowMs - issued) / 3.6e6 > STALE_H) return null;
  const sinceT0 = (nowMs - t0) / 3.6e6;
  const now = s.reduce((a, b) => (Math.abs(b.hours - sinceT0) < Math.abs(a.hours - sinceT0) ? b : a));
  const ahead = s.filter((x) => x.hours >= now.hours);
  const kn = (x: number) => Math.round(x);
  const m = (x: number) => x.toFixed(1);
  const waves = now.hs !== null ? `, waves ${m(now.hs)} m` : "";
  const lo = Math.min(...ahead.map((x) => x.windKn));
  const hi = Math.max(...ahead.map((x) => x.windKn));
  const hsMax = Math.max(...ahead.map((x) => x.hs ?? 0));
  const days = Math.max(1, Math.round((ahead[ahead.length - 1].hours - now.hours) / 24));
  const when = new Date(issued).toISOString().slice(11, 16);
  return [
    `Today at the drop point, for real: wind ${kn(now.windKn)} kn from the ${pointName(now.windFrom)}${waves}. ${days === 1 ? "Next day" : `Next ${days} days`}: wind ${kn(lo)} to ${kn(hi)} kn${hsMax > 0 ? `, waves up to ${m(hsMax)} m` : ""}.`,
    `NOAA's forecast from ${when} UTC. Your crossing sails the real weather of 2020.`,
  ];
}

/** The forecast the site carries (public/forecast/), or null when this copy of the site has none. */
export async function loadToday(base = "./forecast"): Promise<{ header: TodayHeader; data: Int16Array } | null> {
  try {
    const ix = await fetch(`${base}/forecast_index.json`);
    if (!ix.ok || (ix.headers.get("content-type") ?? "").includes("text/html")) return null;
    const file = ((await ix.json()) as { file?: string }).file ?? "forecast_latest";
    const [hr, br] = await Promise.all([fetch(`${base}/${file}.json`), fetch(`${base}/${file}.bin.gz`)]);
    if (!hr.ok || !br.ok) return null;
    const header = (await hr.json()) as TodayHeader;
    const data = new Int16Array(await gunzip(await br.arrayBuffer()));
    if (data.length !== header.nt * header.fields.length * header.nlat * header.nlon) return null;
    return { header, data };
  } catch {
    return null;
  }
}
