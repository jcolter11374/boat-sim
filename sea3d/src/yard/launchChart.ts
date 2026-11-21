// The Boatyard's test, drawn (#332): a small chart of the Atlantic where each
// voyage's track appears as it finishes, with a tick (made it) or a cross
// (didn't) at its end, and the odds as gauges, in place of a timer and a table.
//
// Nothing here changes a result: the tracks are the simulator's own positions
// (the replay's lat/lon, schema 1) and the marks its own outcomes.

/** A voyage's path over the ground, as the replay files give it. */
export interface Track {
  lat: number[];
  lon: number[];
}
export type Who = "yours" | "planned";

/** The part of the Atlantic the chart shows (the land mask covers 25..62 N, -82..5 E). */
export const CHART_BOX = { latMin: 28, latMax: 56, lonMin: -80, lonMax: 0 } as const;
/** The finish: the target on the race's eastern line, west of Lisbon (runner/arrival.py). */
export const FINISH = { lat: 39.5, lon: -13.5 } as const;

/** Where a position falls on a chart w by h pixels (plain latitude and longitude, north up). */
export function project(lat: number, lon: number, w: number, h: number): [number, number] {
  const b = CHART_BOX;
  return [((lon - b.lonMin) / (b.lonMax - b.lonMin)) * w, ((b.latMax - lat) / (b.latMax - b.latMin)) * h];
}

/** The usable points of a track, in pixels: bad readings dropped, lengths matched. */
export function trackPoints(t: Track | null | undefined, w: number, h: number): [number, number][] {
  if (!t || !Array.isArray(t.lat) || !Array.isArray(t.lon)) return [];
  const out: [number, number][] = [];
  const n = Math.min(t.lat.length, t.lon.length);
  for (let i = 0; i < n; i++) {
    const la = t.lat[i];
    const lo = t.lon[i];
    if (typeof la === "number" && typeof lo === "number" && Number.isFinite(la) && Number.isFinite(lo)) out.push(project(la, lo, w, h));
  }
  return out;
}

/** The mark at a track's end: a tick for a finish, a cross for anything else. */
export const endMark = (outcome: string): "tick" | "cross" => (outcome === "arrived" ? "tick" : "cross");

/** One voyage on the chart: the same launch day sailed by both boats makes two. */
export const voyageKey = (who: Who, start: string): string => `${who}|${start.slice(0, 16)}`;

/** The sentence under the chart while it fills, and once it has. */
export function tally(done: { who: Who; outcome: string }[], total: number | null, own = true): string {
  const mine = done.filter((d) => d.who === "yours");
  if (!mine.length) return total ? `Your ${total} voyages will appear here as each one ends.` : "Each voyage appears here as it ends.";
  const made = mine.filter((d) => d.outcome === "arrived").length;
  const of = total && total > mine.length ? ` of ${total}` : "";
  // Voyages of another build (the closest one our servers have tested) are never called the player's.
  const whose = own ? "your voyages" : "the closest tested boat's voyages";
  return `${mine.length}${of} of ${whose} drawn: ${made} made it${mine.length - made ? `, ${mine.length - made} didn't` : ""}.`;
}

// ---------- the gauge ----------
const R = 40; // the arc's radius, in a 100 x 58 box
const ARC = Math.PI * R;

/** How much of the half-circle is filled for these odds (0..1), as SVG dash lengths. */
export function gaugeDash(odds: number | null): [number, number] {
  const f = odds === null || !Number.isFinite(odds) ? 0 : Math.max(0, Math.min(1, odds));
  return [+(f * ARC).toFixed(2), +ARC.toFixed(2)];
}

const SVG = "http://www.w3.org/2000/svg";
/** A half-circle gauge with the odds in the middle ("?" when there are none). */
export function gauge(odds: number | null, who: Who): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `gauge ${who}`;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 100 58");
  svg.setAttribute("aria-hidden", "true");
  const d = `M ${50 - R} 52 A ${R} ${R} 0 0 1 ${50 + R} 52`;
  const back = document.createElementNS(SVG, "path");
  back.setAttribute("d", d);
  back.setAttribute("class", "g-back");
  const fill = document.createElementNS(SVG, "path");
  fill.setAttribute("d", d);
  fill.setAttribute("class", "g-fill");
  const [on, all] = gaugeDash(odds);
  fill.setAttribute("stroke-dasharray", `${on} ${all}`);
  svg.append(back, fill);
  // The number keeps the "odds" class the page has always used for it.
  const num = Object.assign(document.createElement("div"), { className: "odds", textContent: odds === null ? "?" : `${Math.round(odds * 100)}%` });
  wrap.append(svg, num);
  return wrap;
}

// ---------- the chart ----------
const COLOURS: Record<Who, string> = { yours: "#ff8a2a", planned: "#8fa9c4" };
const SEA = "#0e2238";
const LAND = "#3a5068";
const DRAW_MS = 700; // a track draws itself in this long

interface Drawn {
  who: Who;
  outcome: string;
  pts: [number, number][];
  t0: number;
}

/**
 * The chart itself. `add` a voyage when it ends; it draws its track from the start
 * to where it ended, then the tick or cross. A voyage added twice (the live run,
 * then the final result) is drawn once.
 */
export class LaunchChart {
  readonly el = document.createElement("div");
  private canvas = document.createElement("canvas");
  private line = document.createElement("div");
  private land: HTMLImageElement | null = null;
  private drawn = new Map<string, Drawn>();
  private total: number | null = null;
  private raf = 0;
  private w = 268;
  private h = 100;
  private still: boolean;
  private own = true;
  /** Goes up each time the chart is cleared: a track still being fetched for an earlier test checks it and stays off. */
  gen = 0;
  private keyYours = document.createElement("span");
  private keyPlanned = document.createElement("span");

  constructor(landUrl = "./land.png") {
    this.el.className = "launch-chart";
    this.canvas.setAttribute("role", "img");
    this.line.className = "muted";
    const key = document.createElement("div");
    key.className = "muted chart-key";
    const dash = (cls: string) => Object.assign(document.createElement("i"), { className: `k ${cls}` });
    this.keyYours.append(dash("yours"), "Yours");
    this.keyPlanned.append(dash("planned"), "To compare");
    this.keyPlanned.hidden = true; // until there is a boat to compare with on the chart
    const ends = document.createElement("span");
    ends.innerHTML = '<b class="ok">&#10003;</b> made it &nbsp;<b class="no">&#10007;</b> didn\'t';
    key.append(this.keyYours, this.keyPlanned, ends);
    this.el.append(this.canvas, key, this.line);
    this.still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const img = new Image();
    img.onload = () => {
      this.land = img;
      this.paint();
    };
    img.src = landUrl;
    this.say();
  }

  /** How many voyages of the player's boat are coming, for the line under the chart. */
  expect(total: number): void {
    this.total = total;
    this.say();
  }

  /** Whose voyages the orange tracks are: the player's own design (true), or the closest build our servers have tested. */
  whose(own: boolean): void {
    this.own = own;
    this.keyYours.lastChild!.textContent = own ? "Yours" : "Closest tested boat";
    this.say();
  }

  /**
   * Keep only the voyages of `who` that are in the final result, with the same ending. After a
   * crash mid-run the result comes from our servers, and a track drawn live from the browser's
   * own run must not stand beside a table that says otherwise.
   */
  keep(who: Who, result: { start: string; outcome: string }[]): void {
    const ok = new Map(result.map((r) => [voyageKey(who, r.start), r.outcome]));
    for (const [k, d] of [...this.drawn]) if (d.who === who && ok.get(k) !== d.outcome) this.drawn.delete(k);
    this.say();
    this.paint();
  }

  /** Start again for a new test. */
  clear(): void {
    this.gen++;
    this.drawn.clear();
    this.total = null;
    this.own = true;
    this.keyYours.lastChild!.textContent = "Yours";
    this.say();
    this.paint();
  }

  has(who: Who, start: string): boolean {
    return this.drawn.has(voyageKey(who, start));
  }

  /** How many voyages are on the chart (for tests). */
  get count(): number {
    return this.drawn.size;
  }

  add(who: Who, start: string, outcome: string, track: Track | null | undefined, delayMs = 0): void {
    const k = voyageKey(who, start);
    if (this.drawn.has(k)) return;
    this.size();
    this.drawn.set(k, { who, outcome, pts: trackPoints(track, this.w, this.h), t0: performance.now() + delayMs });
    this.say();
    this.tick();
  }

  private say(): void {
    const done = [...this.drawn.values()];
    this.line.textContent = tally(done, this.total, this.own);
    this.keyPlanned.hidden = !done.some((d) => d.who === "planned");
    const mine = done.filter((d) => d.who === "yours");
    this.canvas.setAttribute(
      "aria-label",
      `Chart of the North Atlantic with the test voyages' tracks. ${mine.length ? `${mine.filter((d) => d.outcome === "arrived").length} of ${mine.length} ${this.own ? "of yours" : "of the closest tested boat's"} reached the finish.` : "None drawn yet."}`,
    );
  }

  private size(): void {
    const cssW = Math.round(this.canvas.clientWidth) || this.w;
    const ratio = (CHART_BOX.latMax - CHART_BOX.latMin) / (CHART_BOX.lonMax - CHART_BOX.lonMin);
    const dpr = Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, 2);
    if (cssW !== this.w || this.canvas.width !== Math.round(cssW * dpr)) {
      // Points already placed were for the old width: move them with it.
      const k = cssW / this.w;
      for (const d of this.drawn.values()) d.pts = d.pts.map(([x, y]) => [x * k, y * k]);
      this.w = cssW;
      this.h = Math.round(cssW * ratio);
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
    }
  }

  private tick(): void {
    if (this.raf) return;
    const step = () => {
      this.raf = 0;
      this.paint();
      const now = performance.now();
      if (!this.still && [...this.drawn.values()].some((d) => now < d.t0 + DRAW_MS)) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private paint(): void {
    this.size();
    const c = this.canvas.getContext("2d");
    if (!c) return;
    const { w, h } = this;
    const dpr = this.canvas.width / w;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalCompositeOperation = "source-over";
    c.fillStyle = SEA;
    c.fillRect(0, 0, w, h);
    if (this.land) {
      // The mask is white land on black sea, 0.1 degree a pixel from 62 N, 82 W: tint it.
      const sx = (CHART_BOX.lonMin + 82) * 10;
      const sy = (62 - CHART_BOX.latMax) * 10;
      c.drawImage(this.land, sx, sy, (CHART_BOX.lonMax - CHART_BOX.lonMin) * 10, (CHART_BOX.latMax - CHART_BOX.latMin) * 10, 0, 0, w, h);
      c.globalCompositeOperation = "multiply";
      c.fillStyle = LAND;
      c.fillRect(0, 0, w, h);
      c.globalCompositeOperation = "lighten";
      c.fillStyle = SEA;
      c.fillRect(0, 0, w, h);
      c.globalCompositeOperation = "source-over";
    }
    // The finish: a ring west of Lisbon.
    const [fx, fy] = project(FINISH.lat, FINISH.lon, w, h);
    c.strokeStyle = "#3ddc97";
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(fx, fy, 4.5, 0, Math.PI * 2);
    c.stroke();
    c.font = "600 9.5px system-ui, sans-serif";
    c.fillStyle = "rgba(233,241,251,.85)";
    c.textAlign = "right";
    c.fillText("Finish", fx - 7, fy + 12);
    const now = performance.now();
    // The boat it's compared with underneath, the player's on top.
    const order = [...this.drawn.values()].sort((a, b) => (a.who === b.who ? 0 : a.who === "planned" ? -1 : 1));
    let startDrawn = false;
    for (const d of order) {
      if (d.pts.length < 1) continue;
      const f = this.still ? 1 : Math.max(0, Math.min(1, (now - d.t0) / DRAW_MS));
      if (f <= 0) continue;
      if (!startDrawn) {
        startDrawn = true;
        const [x0, y0] = d.pts[0];
        c.fillStyle = "#e9f1fb";
        c.beginPath();
        c.arc(x0, y0, 2.5, 0, Math.PI * 2);
        c.fill();
        c.textAlign = "left";
        c.fillStyle = "rgba(233,241,251,.85)";
        c.fillText("Start", x0 + 5, y0 + 12);
      }
      const n = Math.max(1, Math.round(f * (d.pts.length - 1)));
      c.strokeStyle = COLOURS[d.who];
      c.globalAlpha = d.who === "yours" ? 0.95 : 0.6;
      c.lineWidth = d.who === "yours" ? 1.6 : 1.1;
      c.lineJoin = "round";
      c.beginPath();
      c.moveTo(d.pts[0][0], d.pts[0][1]);
      for (let i = 1; i <= n && i < d.pts.length; i++) c.lineTo(d.pts[i][0], d.pts[i][1]);
      c.stroke();
      c.globalAlpha = 1;
      if (f >= 1) {
        const [ex, ey] = d.pts[d.pts.length - 1];
        const s = d.who === "yours" ? 3.5 : 2.6;
        c.lineWidth = d.who === "yours" ? 2 : 1.4;
        c.lineCap = "round";
        c.beginPath();
        if (endMark(d.outcome) === "tick") {
          c.strokeStyle = "#3ddc97";
          c.moveTo(ex - s, ey);
          c.lineTo(ex - s / 3, ey + s * 0.8);
          c.lineTo(ex + s, ey - s);
        } else {
          c.strokeStyle = "#ff5d5d";
          c.moveTo(ex - s, ey - s);
          c.lineTo(ex + s, ey + s);
          c.moveTo(ex + s, ey - s);
          c.lineTo(ex - s, ey + s);
        }
        c.stroke();
        c.lineCap = "butt";
      }
    }
  }
}
