// The map on a "Your call" card (Rosa; decisions plan, approved by Elena 12 Nov): the card is
// a map first, words second. Each option's line over the next two days, in its own colour,
// from the forecast as issued (Sam's Game.outlook), and the ghost's line, faint and dashed
// (it always takes the autopilot's option). Hovering or focusing an option lights its line.
// Display only.

/** One line on the map: [lat, lon] points. */
export type Line = [number, number][];

/** Option colours, in the card's order (Ines checks these against the sea and the land). */
export const OPTION_COLOURS = ["#ff9a3c", "#4fd8c8", "#c9a2ff", "#ffd75e"];
const GHOST = "rgba(196,206,218,0.9)"; // neutral grey: the ghost is not an option

export interface MapView {
  /** Lat/lon of the map's centre, and degrees of latitude from top to bottom. */
  lat: number;
  lon: number;
  spanLat: number;
  /** px per degree of latitude, and of longitude (narrower by cos(lat)). */
  ky: number;
  kx: number;
  w: number;
  h: number;
}

/** Fit every point (and the boat) into a w x h map: the two-day box round the choices, so the lines fan apart (Ines), at least 0.6 degrees tall. */
export function fitView(lines: Line[], boat: [number, number], w: number, h: number): MapView {
  const pts = [boat, ...lines.flat()];
  let [la0, la1, lo0, lo1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [la, lo] of pts) {
    la0 = Math.min(la0, la);
    la1 = Math.max(la1, la);
    lo0 = Math.min(lo0, lo);
    lo1 = Math.max(lo1, lo);
  }
  const lat = (la0 + la1) / 2;
  const lon = (lo0 + lo1) / 2;
  const cos = Math.cos((lat * Math.PI) / 180);
  // Degrees of latitude the map needs to show both ways, with 30% to spare.
  const needLat = Math.max(0.6, (la1 - la0) * 1.18, ((lo1 - lo0) * 1.18 * cos * h) / w);
  const ky = h / needLat;
  return { lat, lon, spanLat: needLat, ky, kx: ky * cos, w, h };
}

/** Map px of a point. */
export function toPx(v: MapView, la: number, lo: number): [number, number] {
  return [v.w / 2 + (lo - v.lon) * v.kx, v.h / 2 - (la - v.lat) * v.ky];
}

/** Two lines within 3 px of each other all along (compared at their shared points). */
export function sameLine(v: MapView, a: Line, b: Line): boolean {
  const n = Math.min(a.length, b.length);
  if (!n || Math.abs(a.length - b.length) > 1) return false;
  for (let k = 0; k < n; k++) {
    const [ax, ay] = toPx(v, a[k][0], a[k][1]);
    const [bx, by] = toPx(v, b[k][0], b[k][1]);
    if (Math.hypot(ax - bx, ay - by) > 3) return false;
  }
  return true;
}

/** The forecast's surface current on a grid (Sam's outlook().current): rows south to north, m/s. */
export interface CurrentGrid {
  lat0: number;
  lon0: number;
  step: number;
  nlat: number;
  nlon: number;
  u: number[];
  v: number[];
}
/** Current slower than this isn't drawn (m/s); the Stream's core runs at 1.5-2.5. */
const CURRENT_MIN = 0.5;

/** The Gulf Stream (or any strong current): a warm, lighter ribbon with faint arrows the way it runs. */
function drawCurrent(g: CanvasRenderingContext2D, v: MapView, c: CurrentGrid): void {
  const cell = document.createElement("canvas");
  cell.width = c.nlon;
  cell.height = c.nlat;
  const cg = cell.getContext("2d")!;
  const img = cg.createImageData(c.nlon, c.nlat);
  for (let i = 0; i < c.nlat; i++)
    for (let j = 0; j < c.nlon; j++) {
      const k = i * c.nlon + j;
      const sp = Math.hypot(c.u[k], c.v[k]);
      const a = Math.min(1, Math.max(0, (sp - CURRENT_MIN) / 1.2));
      const o = ((c.nlat - 1 - i) * c.nlon + j) * 4; // image rows run north to south
      // A neutral sand-grey (Ines): warm enough to read as the Stream, but no option's colour.
      img.data[o] = 196;
      img.data[o + 1] = 184;
      img.data[o + 2] = 160;
      img.data[o + 3] = Math.round(a * 95);
    }
  cg.putImageData(img, 0, 0);
  // Cell centres sit on the grid points: the image spans half a step beyond them each way.
  const [x0, y0] = toPx(v, c.lat0 + (c.nlat - 0.5) * c.step, c.lon0 - c.step / 2);
  const [x1, y1] = toPx(v, c.lat0 - c.step / 2, c.lon0 + (c.nlon - 0.5) * c.step);
  g.save();
  g.imageSmoothingEnabled = true;
  g.filter = `blur(${Math.max(2, 0.35 * c.step * v.ky).toFixed(1)}px)`;
  g.drawImage(cell, x0, y0, x1 - x0, y1 - y0);
  g.filter = "none";
  // Faint chevrons on the fast water, about one every 40 px, pointing the way it runs.
  const every = Math.max(1, Math.round(40 / (c.step * v.ky)));
  g.strokeStyle = "rgba(226,218,200,0.5)";
  g.lineWidth = 1.2;
  g.lineCap = g.lineJoin = "round";
  for (let i = 0; i < c.nlat; i += every)
    for (let j = (i / every) % 2 ? Math.floor(every / 2) : 0; j < c.nlon; j += every) {
      const k = i * c.nlon + j;
      const sp = Math.hypot(c.u[k], c.v[k]);
      if (sp < 1.2) continue;
      const [x, y] = toPx(v, c.lat0 + i * c.step, c.lon0 + j * c.step);
      const ang = Math.atan2(-c.v[k], c.u[k]); // screen: y down
      const L = 5;
      const tx = Math.cos(ang);
      const ty = Math.sin(ang);
      g.beginPath();
      // A narrow ">" so it reads as an arrowhead at any angle, not a hook.
      g.moveTo(x - tx * L - ty * L * 0.5, y - ty * L + tx * L * 0.5);
      g.lineTo(x, y);
      g.lineTo(x - tx * L + ty * L * 0.5, y - ty * L - tx * L * 0.5);
      g.stroke();
    }
  g.restore();
}

export interface LandMask {
  img: CanvasImageSource & { width: number; height: number };
  bounds: { lat_min: number; lat_max: number; lon_min: number; lon_max: number };
}

let tinted: HTMLCanvasElement | null = null;
function tint(land: LandMask): HTMLCanvasElement {
  if (tinted) return tinted;
  const c = document.createElement("canvas");
  c.width = land.img.width;
  c.height = land.img.height;
  const g = c.getContext("2d")!;
  g.drawImage(land.img, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < px.data.length; i += 4) {
    const on = px.data[i] > 127;
    px.data[i] = 64;
    px.data[i + 1] = 92;
    px.data[i + 2] = 86;
    px.data[i + 3] = on ? 255 : 0;
  }
  g.putImageData(px, 0, 0);
  tinted = c;
  return c;
}

/**
 * Draw the call's map. lines: each option's line (null for an option with none); lit: the
 * option being hovered or focused, or -1. The canvas is drawn at its CSS size times dpr.
 */
export function drawCallMap(cv: HTMLCanvasElement, land: LandMask | null, boat: [number, number], lines: (Line | null)[], ghost: Line | null, lit = -1, current: CurrentGrid | null = null): void {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const w = cv.clientWidth || 420;
  const h = cv.clientHeight || 150;
  if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
  if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
  const g = cv.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const all = [...lines.filter((l): l is Line => !!l && l.length > 0), ...(ghost?.length ? [ghost] : [])];
  // Frame the fast water near the boat too, so the band shows round the lines, not cut off.
  const near: Line = [];
  if (current)
    for (let i = 0; i < current.nlat; i++)
      for (let j = 0; j < current.nlon; j++) {
        const k = i * current.nlon + j;
        const la = current.lat0 + i * current.step;
        const lo = current.lon0 + j * current.step;
        if (Math.hypot(current.u[k], current.v[k]) >= 1 && Math.abs(la - boat[0]) <= 0.35 && Math.abs(lo - boat[1]) <= 0.35) near.push([la, lo]);
      }
  const v = fitView(near.length ? [...all, near] : all, boat, w, h);
  // The sea, then the land at its true place.
  g.fillStyle = "#0e2a40";
  g.fillRect(0, 0, w, h);
  if (land) {
    const b = land.bounds;
    const [x0, y0] = toPx(v, b.lat_max, b.lon_min);
    const [x1, y1] = toPx(v, b.lat_min, b.lon_max);
    g.imageSmoothingEnabled = true;
    g.filter = `blur(${Math.max(1, 0.06 * v.ky).toFixed(1)}px)`; // the mask is 0.1 degree squares: soften its steps at any zoom
    g.drawImage(tint(land), x0, y0, x1 - x0, y1 - y0);
    g.filter = "none";
  }
  if (current && current.nlat > 1 && current.nlon > 1) drawCurrent(g, v, current);
  // A faint degree grid, so distances read.
  g.strokeStyle = "rgba(255,255,255,0.06)";
  g.lineWidth = 1;
  g.beginPath();
  for (let la = Math.ceil(v.lat - v.spanLat / 2); la <= v.lat + v.spanLat / 2; la++) {
    const y = toPx(v, la, v.lon)[1];
    g.moveTo(0, y);
    g.lineTo(w, y);
  }
  const spanLon = w / v.kx;
  for (let lo = Math.ceil(v.lon - spanLon / 2); lo <= v.lon + spanLon / 2; lo++) {
    const x = toPx(v, v.lat, lo)[0];
    g.moveTo(x, 0);
    g.lineTo(x, h);
  }
  g.stroke();
  // Lines that run together (riding the Stream is the autopilot's route, and the ghost always
  // sails the autopilot's) are drawn side by side, a few px apart, so every option shows in
  // full in its button's colour (Elena), with the ghost neutral and dashed beside them.
  const items: { l: Line; i: number }[] = lines.flatMap((l, i) => (l?.length ? [{ l, i }] : []));
  if (ghost?.length) items.push({ l: ghost, i: -1 });
  const shift = new Map<number, number>();
  const groups: { l: Line; i: number }[][] = [];
  for (const it of items) {
    const grp = groups.find((gr) => sameLine(v, gr[0].l, it.l));
    if (grp) grp.push(it);
    else groups.push([it]);
  }
  const GAP = 3.5;
  for (const gr of groups) gr.forEach((it, k) => shift.set(it.i, (k - (gr.length - 1) / 2) * GAP));
  const pxLine = (l: Line, off: number): [number, number][] => {
    const p = [toPx(v, boat[0], boat[1]), ...l.map(([la, lo]) => toPx(v, la, lo))];
    if (!off) return p;
    return p.map(([x, y], k) => {
      const [ax, ay] = p[Math.max(0, k - 1)];
      const [bx, by] = p[Math.min(p.length - 1, k + 1)];
      const n = Math.hypot(bx - ax, by - ay) || 1;
      // Off to the right of the way it goes, fading in from the boat so all lines leave from her.
      const f = Math.min(1, k / 2);
      return [x - ((by - ay) / n) * off * f, y + ((bx - ax) / n) * off * f];
    });
  };
  const path = (p: [number, number][]) => {
    g.beginPath();
    g.moveTo(p[0][0], p[0][1]);
    for (const [x, y] of p.slice(1)) g.lineTo(x, y);
  };
  g.lineCap = g.lineJoin = "round";
  // The ghost's line: neutral, thin and dashed, under the options.
  if (ghost?.length) {
    path(pxLine(ghost, shift.get(-1) ?? 0));
    g.setLineDash([3, 4]);
    g.strokeStyle = GHOST;
    g.lineWidth = 1.5;
    g.globalAlpha = lit >= 0 ? 0.45 : 0.8;
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
  }
  // The options: the lit one on top, brighter and thicker; the others dimmed while one is lit.
  const order = lines.map((_, i) => i).sort((a, b) => (a === lit ? 1 : b === lit ? -1 : 0));
  for (const i of order) {
    const l = lines[i];
    if (!l?.length) continue;
    const on = lit < 0 || lit === i;
    g.globalAlpha = on ? 1 : 0.35;
    g.strokeStyle = OPTION_COLOURS[i % OPTION_COLOURS.length];
    g.lineWidth = lit === i ? 3.5 : 2.5;
    const p = pxLine(l, shift.get(i) ?? 0);
    path(p);
    g.stroke();
    // Where it gets to: a dot.
    const [ex, ey] = p[p.length - 1];
    g.fillStyle = g.strokeStyle;
    g.beginPath();
    g.arc(ex, ey, lit === i ? 4 : 3, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  // The boat: a white dot with a dark ring, on top.
  const [bx, by] = toPx(v, boat[0], boat[1]);
  g.fillStyle = "#fff";
  g.strokeStyle = "#0b1622";
  g.lineWidth = 2;
  g.beginPath();
  g.arc(bx, by, 4, 0, Math.PI * 2);
  g.fill();
  g.stroke();
}
