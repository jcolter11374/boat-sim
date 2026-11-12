// Points of interest: wrecks, history and ocean facts along the route
// (Priya's src/boatsim/oceandata/pois.py writes public/pois.json). When a
// boat's track comes within a point's radius, the voyage replay and Take the
// helm show a card with the story and a link to its source. Display only.
//
// Everything from the file goes on the page with textContent, never innerHTML,
// and a link is only made for an https URL.

export type PoiKind = "wreck" | "history" | "ocean";

export interface Poi {
  id: string;
  kind: PoiKind;
  title: string;
  /** (lat, lon) points; a line (the Gulf Stream, the ridge) is several. */
  at: [number, number][];
  radius_km: number;
  text: string;
  source: string;
  url: string;
  /** Wrecks: how deep it lies (m) and its hull's length and beam (m). */
  depth_m?: number;
  size_m?: [number, number];
}

/** A track passing a point: when, how far off, and where the boat was. */
export interface Pass {
  poi: Poi;
  h: number;
  km: number;
  boat: [number, number];
  /** The point of the poi that was closest. */
  near: [number, number];
}

export interface Track {
  h: number[];
  lat: (number | null)[];
  lon: (number | null)[];
}

export const KIND_LABEL: Record<PoiKind, string> = { wreck: "Shipwreck", history: "History", ocean: "Ocean fact" };
export const KIND_COLOUR: Record<PoiKind, string> = { wreck: "#c9a46b", history: "#d98cb3", ocean: "#5cc8e0" };

export async function loadPois(url: string, get: (u: string) => Promise<Response> = (u) => fetch(u)): Promise<Poi[]> {
  try {
    const r = await get(url);
    if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return [];
    const j = (await r.json()) as { pois?: Poi[] };
    return (j.pois ?? []).filter((p) => p && Array.isArray(p.at) && p.at.length && p.radius_km > 0 && p.kind in KIND_LABEL);
  } catch {
    return [];
  }
}

const R = 6371;
const RAD = Math.PI / 180;

/** Great-circle distance, km. */
export function kmBetween(a: [number, number], b: [number, number]): number {
  const dlat = (b[0] - a[0]) * RAD;
  const dlon = (b[1] - a[1]) * RAD;
  const s = Math.sin(dlat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Clear ocean water shows the bottom down to about this depth (m), and only just. */
export const SEE_DEPTH = 30;

/**
 * A wreck shallow enough to see through the water, near enough to be under the boat's
 * view: where it lies from (lat, lon) in metres east (x) and south (z), and how clearly
 * it could show (0..1, fading with depth). null when there's none.
 */
export function wreckBelow(pois: Poi[], lat: number, lon: number, withinM = 400): { poi: Poi; x: number; z: number; clear: number } | null {
  let best: { poi: Poi; x: number; z: number; clear: number } | null = null;
  let bestD = Infinity;
  for (const p of pois) {
    if (p.kind !== "wreck" || p.depth_m == null || !p.size_m || p.depth_m > SEE_DEPTH) continue;
    const [la, lo] = p.at[0];
    const x = (lo - lon) * 111320 * Math.cos(lat * RAD);
    const z = -(la - lat) * 110950;
    const d = Math.hypot(x, z);
    if (d > withinM + p.size_m[0] / 2 || d >= bestD) continue;
    bestD = d;
    const t = Math.min(Math.max((p.depth_m - 10) / (SEE_DEPTH - 10), 0), 1);
    best = { poi: p, x, z, clear: 1 - t * t * (3 - 2 * t) * 0.55 };
  }
  return best;
}

/** Initial bearing from a to b, degrees clockwise from north. */
export function bearingTo(a: [number, number], b: [number, number]): number {
  const [p1, p2] = [a[0] * RAD, b[0] * RAD];
  const dl = (b[1] - a[1]) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / RAD) % 360 + 360) % 360;
}

/** Closest approach of the segment a-b to point p: distance in km and the fraction along a-b.
 *  Flat-earth about p, which is fine for the short legs between track samples. */
export function segmentNearest(p: [number, number], a: [number, number], b: [number, number]): { km: number; f: number } {
  const kx = R * RAD * Math.cos(p[0] * RAD);
  const ky = R * RAD;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
  const bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const f = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
  return { km: Math.hypot(ax + f * dx, ay + f * dy), f };
}

function at(t: Track, i: number): [number, number] | null {
  const la = t.lat[i], lo = t.lon[i];
  return la == null || lo == null || !Number.isFinite(la) || !Number.isFinite(lo) ? null : [la, lo];
}

function lerp(a: [number, number], b: [number, number], f: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** The points of interest the track passes between hours h0 and h1, earliest first,
 *  skipping (and adding to) the ids in `seen`, so each card shows once. */
export function passes(track: Track, h0: number, h1: number, pois: Poi[], seen: Set<string>): Pass[] {
  const out: Pass[] = [];
  const n = track.h.length;
  if (!n || h1 < h0) return out;
  // Before the first sample the boat is at the drop: the start of the voyage counts as there.
  if (h0 <= track.h[0]) h1 = Math.max(h1, track.h[0]);
  // A track of one point (the drop) is a leg of length zero.
  const legs = n === 1 ? [[0, 0]] : Array.from({ length: n - 1 }, (_, i) => [i, i + 1]);
  for (const [i, j] of legs) {
    const ti = track.h[i], tj = track.h[j];
    if (tj < h0 || ti > h1) continue;
    let a = at(track, i), b = at(track, j);
    if (!a || !b) continue;
    // Only the part of the leg inside [h0, h1].
    const span = tj - ti;
    const f0 = span > 0 ? Math.max(0, (h0 - ti) / span) : 0;
    const f1 = span > 0 ? Math.min(1, (h1 - ti) / span) : 1;
    [a, b] = [lerp(a, b, f0), lerp(a, b, f1)];
    const ha = ti + span * f0, hb = ti + span * f1;
    for (const poi of pois) {
      if (seen.has(poi.id)) continue;
      let best: Pass | null = null;
      for (const q of poi.at) {
        // Cheap reject first: nowhere near either end of a short leg.
        if (Math.abs(q[0] - a[0]) * 111 > poi.radius_km + 500) continue;
        const { km, f } = segmentNearest(q, a, b);
        if (km <= poi.radius_km && (!best || km < best.km)) best = { poi, h: ha + (hb - ha) * f, km, boat: lerp(a, b, f), near: q };
      }
      if (best) {
        seen.add(poi.id);
        out.push(best);
      }
    }
  }
  return out.sort((x, y) => x.h - y.h);
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** "About 120 km to the north-east" from where the boat was; "Right here" when close. */
export function whereFrom(p: Pass): string {
  const km = kmBetween(p.boat, p.near);
  if (km < 10) return "Right here";
  const word = COMPASS[Math.round(bearingTo(p.boat, p.near) / 45) % 8];
  const r = km < 100 ? Math.round(km / 5) * 5 : Math.round(km / 10) * 10;
  return `About ${r} km to the ${word}`;
}

/** Only https links go on the page. */
export function safeUrl(u: string): string | null {
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const STYLE = `
.poi-card { position: fixed; right: var(--poi-right, 12px); bottom: var(--poi-bottom, 100px); top: var(--poi-top, auto); max-height: var(--poi-max, none);
  width: min(var(--poi-w, 340px), calc(100vw - 24px)); z-index: 20;
  box-sizing: border-box; padding: 11px 14px 12px; border: 1px solid rgba(160,200,255,.18); border-left: 4px solid var(--c, #5cc8e0);
  border-radius: 12px; color: #e9f1fb; background: rgba(10,22,38,.8); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.35); overflow: hidden auto;
  scrollbar-width: thin; scrollbar-color: rgba(160,200,255,.35) transparent;
  animation: poi-in .45s cubic-bezier(.2,.8,.2,1); }
.poi-card .poi-k { display: flex; align-items: flex-start; gap: 6px; font-size: 10.5px; font-weight: 600; letter-spacing: .9px;
  text-transform: uppercase; color: #9fb3c8; padding-right: 22px; }
.poi-card .poi-k .poi-where { min-width: 0; overflow-wrap: anywhere; letter-spacing: .5px; padding-top: 1px; }
.poi-card .poi-k .poi-when { white-space: nowrap; }
.poi-card .poi-k .poi-badge { flex: none;  color: #0b1726; background: var(--c, #5cc8e0); border-radius: 999px; padding: 1px 7px; letter-spacing: .6px; }
.poi-card .poi-t { font-weight: 650; font-size: 15.5px; margin: 5px 0 4px; color: #fff; }
.poi-card .poi-x-text { color: #d6e2ef; }
.poi-card .poi-src { margin-top: 7px; font-size: 11.5px; color: #9fb3c8; }
.poi-card .poi-src a { color: #8ab4ff; }
.poi-card .poi-more { margin-top: 4px; font-size: 11px; color: #9fb3c8; }
.poi-card .poi-more:empty { display: none; }
.poi-tight .poi-card .poi-more { display: none; }
.poi-card .poi-x { position: absolute; right: 6px; top: 5px; background: none; border: 0; color: #9fb3c8; font-size: 18px; line-height: 1;
  cursor: pointer; padding: 3px 6px; border-radius: 6px; }
.poi-card .poi-x:hover { color: #fff; background: rgba(255,255,255,.08); }
/* How long the card has left: a thin line along the bottom that runs down, and waits while you read (hover). */
.poi-card .poi-time { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: var(--c, #5cc8e0); opacity: .7;
  transform-origin: left; animation: poi-time var(--poi-s, 25s) linear forwards; }
.poi-card:hover .poi-time { animation-play-state: paused; }
.poi-card.poi-out { opacity: 0; transform: translateY(6px); transition: opacity .8s, transform .8s; }
@keyframes poi-in { from { transform: translateY(10px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes poi-time { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) { .poi-card, .poi-card .poi-time { animation: none; } .poi-card.poi-out { transition: none; } }
/* Compact (the helm): narrower, two lines and "Read more", then it shrinks to a tab at the edge. */
.poi-card.poi-compact { width: min(300px, calc(100vw - 24px)); padding: 9px 12px 10px; font-size: 12.5px; background: rgba(8,16,28,.72); }
.poi-card.poi-compact .poi-t { font-size: 14.5px; margin: 3px 0 2px; }
.poi-card.poi-compact:not(.poi-open) .poi-x-text { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.poi-card.poi-compact:not(.poi-open) .poi-src, .poi-card.poi-compact:not(.poi-open) .poi-more { display: none; }
.poi-card .poi-read { background: none; border: 0; padding: 0; margin-top: 3px; font: inherit; font-size: 11.5px; color: #8ab4ff; cursor: pointer; }
.poi-card.poi-open .poi-read { display: none; }
.poi-card.poi-tab { width: auto; max-width: 260px; padding: 6px 12px; cursor: pointer; }
.poi-card.poi-tab > :not(.poi-t):not(.poi-time) { display: none !important; }
.poi-card.poi-tab .poi-t { margin: 0; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.poi-card.poi-tab .poi-t::after { content: " ›"; color: var(--c, #5cc8e0); }
`;

/** One card at a time, bottom right (a page can move it with --poi-right and --poi-bottom, or hang it from --poi-top with --poi-bottom: auto and a --poi-max height). Each stays SHOW_S seconds (or until closed); points passed
 *  together (three at the drop) wait their turn. */
export class PoiCards {
  static SHOW_S = 25;
  /** Compact cards shrink to a tab after this long (Leo's helm plan, item 7). */
  static TAB_S = 12;
  readonly shown: string[] = [];
  private el: HTMLElement | null = null;
  private timer = 0;
  private waiting: [Pass, string][] = [];
  private more: HTMLElement | null = null;
  private left = 0;
  private since = 0;
  private tabTimer = 0;
  constructor(
    private doc: Document = document,
    private readonly opts: { compact?: boolean } = {},
  ) {
    if (!doc.getElementById("poi-style")) {
      const s = doc.createElement("style");
      s.id = "poi-style";
      s.textContent = STYLE;
      doc.head.appendChild(s);
    }
  }

  /** Show it now, or after the cards already up or waiting. */
  add(p: Pass, when = ""): void {
    if (this.el || this.waiting.length) {
      this.waiting.push([p, when]);
      this.countWaiting();
    } else this.show(p, when);
  }

  show(p: Pass, when = ""): HTMLElement {
    this.hide(true, false);
    const d = this.doc;
    const el = d.createElement("aside");
    el.className = "poi-card";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.style.setProperty("--c", KIND_COLOUR[p.poi.kind]);
    const add = (tag: string, cls: string, text: string) => {
      const e = d.createElement(tag);
      e.className = cls;
      e.textContent = text;
      el.appendChild(e);
      return e;
    };
    const k = add("div", "poi-k", "");
    const badge = d.createElement("span");
    badge.className = "poi-badge";
    badge.textContent = KIND_LABEL[p.poi.kind];
    const where = d.createElement("span");
    where.className = "poi-where";
    where.textContent = whereFrom(p);
    if (when) {
      // The day stays in one piece when the line wraps ("Day 0.0", never "Day" / "0.0").
      const day = d.createElement("span");
      day.className = "poi-when";
      day.textContent = `· ${when}`;
      where.append(" ", day);
    }
    k.append(badge, where);
    add("div", "poi-t", p.poi.title);
    add("div", "poi-x-text", p.poi.text);
    if (this.opts.compact) {
      el.classList.add("poi-compact");
      const read = add("button", "poi-read", "Read more");
      read.addEventListener("click", (e) => {
        e.stopPropagation();
        el.classList.add("poi-open");
        window.clearTimeout(this.tabTimer);
      });
      el.addEventListener("click", () => {
        if (!el.classList.contains("poi-tab")) return;
        el.classList.remove("poi-tab");
        el.classList.add("poi-open");
      });
      this.tabTimer = window.setTimeout(() => {
        if (this.el === el && !el.matches(":hover") && !el.classList.contains("poi-open")) el.classList.add("poi-tab");
      }, PoiCards.TAB_S * 1000);
    }
    const src = add("div", "poi-src", "Source: ");
    const url = safeUrl(p.poi.url);
    if (url) {
      const a = d.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = p.poi.source;
      src.appendChild(a);
    } else src.appendChild(d.createTextNode(p.poi.source));
    this.more = add("div", "poi-more", "");
    const x = add("button", "poi-x", "×");
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", () => this.hide());
    el.style.setProperty("--poi-s", `${PoiCards.SHOW_S}s`);
    add("div", "poi-time", "");
    d.body.appendChild(el);
    this.el = el;
    this.shown.push(p.poi.id);
    this.countWaiting();
    // It stays SHOW_S seconds, not counting the time the pointer rests on it (someone reading).
    this.left = PoiCards.SHOW_S * 1000;
    this.since = performance.now();
    this.timer = window.setTimeout(() => this.hide(), this.left);
    el.addEventListener("mouseenter", () => {
      window.clearTimeout(this.timer);
      this.left -= performance.now() - this.since;
    });
    el.addEventListener("mouseleave", () => {
      if (this.el !== el) return;
      this.since = performance.now();
      this.timer = window.setTimeout(() => this.hide(), Math.max(this.left, 1500));
    });
    return el;
  }

  /** "2 more nearby" under the card while others wait their turn. */
  private countWaiting(): void {
    if (this.more) this.more.textContent = this.waiting.length ? `${this.waiting.length} more nearby after this one` : "";
  }

  /** Take the card down: `now` at once (a jump in time), and `clear` drops the waiting ones too. */
  hide(now = false, clear = now): void {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.tabTimer);
    if (clear) this.waiting = [];
    const el = this.el;
    this.el = null;
    if (!el) return;
    if (now) el.remove();
    else {
      el.classList.add("poi-out");
      window.setTimeout(() => {
        el.remove();
        const next = this.waiting.shift();
        if (next && !this.el) this.show(...next);
      }, 900);
    }
  }
}
