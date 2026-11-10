// The Atlantic chart: coastline, the race's start and finish lines, our 25 km
// target circle, the track sailed so far, and markers for what happened.
// A 2D canvas: crisp at any size and cheap to redraw every frame.

import { isNotable, locate, positionAt, toneOf, type Replay, type Tone } from "./data";

export interface LandBounds {
  lat_min: number;
  lat_max: number;
  lon_min: number;
  lon_max: number;
}

const VIEW = { lonMin: -80, lonMax: -4, latMin: 27, latMax: 53 };
const COS = Math.cos((40 * Math.PI) / 180); // squash longitudes for a mid-Atlantic latitude

export const TONE_COLOUR: Record<Tone, string> = {
  good: "#3ddc97",
  bad: "#ff5d5d",
  warn: "#ffc247",
  info: "#8ab4ff",
};

/** Track colours per boat: reporting home, backup beacon only, glow. Silent is grey for both. */
export interface TrackColours {
  main: string;
  beacon: string;
  glow: string;
}
export const TRACK: Record<"kayak" | "randolph", TrackColours> = {
  kayak: { main: "#ff8a2a", beacon: "#9cc8ff", glow: "rgba(255,140,40,0.9)" },
  randolph: { main: "#2ec4b6", beacon: "#b4f0ea", glow: "rgba(46,196,182,0.9)" },
};
const SILENT = "#8a94a3";

interface ChartLane {
  rep: Replay;
  colours: TrackColours;
}

export class Chart {
  private readonly g: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private rep: Replay | null = null; // the first lane's: course marks come from it
  private lanes: ChartLane[] = [];
  private focus = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly land: HTMLImageElement,
    private readonly bounds: LandBounds,
  ) {
    this.g = canvas.getContext("2d")!;
  }

  setReplay(rep: Replay): void {
    this.setLanes([{ rep, colours: TRACK.kayak }], 0);
  }

  /** One or more boats' voyages; `focus` is drawn on top with the bigger marker. */
  setLanes(lanes: ChartLane[], focus = 0): void {
    this.lanes = lanes;
    this.focus = focus;
    this.rep = lanes[0]?.rep ?? null;
    this.base = null;
  }

  /** Canvas pixels for a lat, lon. */
  xy(lat: number, lon: number): [number, number] {
    const sx = this.w / ((VIEW.lonMax - VIEW.lonMin) * COS);
    const sy = this.h / (VIEW.latMax - VIEW.latMin);
    const s = Math.min(sx, sy);
    const ox = (this.w - (VIEW.lonMax - VIEW.lonMin) * COS * s) / 2;
    const oy = (this.h - (VIEW.latMax - VIEW.latMin) * s) / 2;
    return [ox + (lon - VIEW.lonMin) * COS * s, oy + (VIEW.latMax - lat) * s];
  }

  private kmToPx(km: number): number {
    const [, y0] = this.xy(40, -30);
    const [, y1] = this.xy(40 + km / 111.2, -30);
    return Math.abs(y1 - y0);
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    if (w !== this.w || h !== this.h || this.canvas.width !== Math.round(w * this.dpr)) {
      this.w = w;
      this.h = h;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.base = null;
    }
  }

  /** Static layer: sea, land, grid, course marks. */
  private drawBase(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext("2d")!;
    g.scale(this.dpr, this.dpr);
    const sea = g.createLinearGradient(0, 0, this.w, this.h);
    sea.addColorStop(0, "#0b2440");
    sea.addColorStop(1, "#071a30");
    g.fillStyle = sea;
    g.fillRect(0, 0, this.w, this.h);

    // Grid every 10 degrees.
    g.strokeStyle = "rgba(140,180,230,0.12)";
    g.lineWidth = 1;
    g.font = "10px system-ui, sans-serif";
    g.fillStyle = "rgba(160,190,230,0.45)";
    for (let lon = -80; lon <= 0; lon += 10) {
      const [x0, y0] = this.xy(VIEW.latMin, lon);
      const [x1, y1] = this.xy(VIEW.latMax, lon);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      if (lon > -80) g.fillText(`${-lon}°W`, x1 + 3, y1 + 11);
    }
    for (let lat = 30; lat <= 50; lat += 10) {
      const [x0, y0] = this.xy(lat, VIEW.lonMin);
      const [x1, y1] = this.xy(lat, VIEW.lonMax);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      g.fillText(`${lat}°N`, x0 + 3, y0 - 3);
    }

    // Land, tinted.
    const b = this.bounds;
    const [lx0, ly0] = this.xy(b.lat_max, b.lon_min);
    const [lx1, ly1] = this.xy(b.lat_min, b.lon_max);
    const tint = document.createElement("canvas");
    tint.width = this.land.naturalWidth;
    tint.height = this.land.naturalHeight;
    const tg = tint.getContext("2d")!;
    tg.drawImage(this.land, 0, 0);
    const px = tg.getImageData(0, 0, tint.width, tint.height);
    for (let i = 0; i < px.data.length; i += 4) {
      const on = px.data[i] > 127;
      px.data[i] = 64;
      px.data[i + 1] = 92;
      px.data[i + 2] = 86;
      px.data[i + 3] = on ? 255 : 0;
    }
    tg.putImageData(px, 0, 0);
    g.imageSmoothingEnabled = true;
    g.shadowColor = "rgba(120,200,255,0.35)";
    g.shadowBlur = 6;
    g.drawImage(tint, lx0, ly0, lx1 - lx0, ly1 - ly0);
    g.shadowBlur = 0;

    const rep = this.rep;
    if (rep) {
      const line = (pts: [number, number][], colour: string, label: string, at: number) => {
        g.save();
        g.strokeStyle = colour;
        g.lineWidth = 1.5;
        g.setLineDash([5, 4]);
        g.beginPath();
        pts.forEach(([la, lo], i) => {
          const [x, y] = this.xy(la, lo);
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        });
        g.stroke();
        g.restore();
        const [la, lo] = pts[Math.min(at, pts.length - 1)];
        const [x, y] = this.xy(la, lo);
        g.fillStyle = colour;
        g.font = "600 10px system-ui, sans-serif";
        g.fillText(label, x + 5, y - 5);
      };
      line(rep.course.west_line, "rgba(255,255,255,0.7)", "RACE START LINE", 1);
      line(rep.course.east_line, "rgba(255,255,255,0.7)", "FINISH LINE", 5);
      if (rep.course.drop) {
        const [x, y] = this.xy(rep.course.drop[0], rep.course.drop[1]);
        g.fillStyle = "#fff";
        g.beginPath();
        g.arc(x, y, 2.5, 0, Math.PI * 2);
        g.fill();
        g.font = "10px system-ui, sans-serif";
        g.fillText("drop", x - 26, y + 3);
      }
    }
    return c;
  }

  draw(hour: number, now: number): void {
    this.resize();
    if (!this.base) this.base = this.drawBase();
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.base, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const rep = this.rep;
    if (!rep) return;

    // Target circle: 25 km radius, drawn to scale with a pulse so it can be found.
    const [tx, ty] = this.xy(rep.course.target[0], rep.course.target[1]);
    const rr = Math.max(this.kmToPx(rep.course.target_radius_m / 1000), 2);
    const pulse = (now / 1600) % 1;
    g.strokeStyle = `rgba(61,220,151,${0.6 * (1 - pulse)})`;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(tx, ty, rr + 4 + pulse * 12, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = "rgba(61,220,151,0.35)";
    g.strokeStyle = "#3ddc97";
    g.beginPath();
    g.arc(tx, ty, rr, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = "#3ddc97";
    g.font = "600 10px system-ui, sans-serif";
    g.fillText("TARGET", tx + rr + 5, ty + 3);

    // Other boats first, the one the close-up follows on top.
    const order = this.lanes.map((_, k) => k).filter((k) => k !== this.focus);
    if (this.lanes[this.focus]) order.push(this.focus);
    for (const k of order) this.drawLane(this.lanes[k], hour, now, k === this.focus);
  }

  private drawLane({ rep, colours }: ChartLane, hour: number, now: number, focused: boolean): void {
    const g = this.g;
    // Track so far, with a glow.
    const [i] = locate(rep.h, hour);
    const here = positionAt(rep, hour);
    g.save();
    g.lineJoin = "round";
    g.lineCap = "round";
    g.shadowColor = colours.glow;
    g.shadowBlur = focused ? 8 : 4;
    g.lineWidth = focused ? 2 : 1.6;
    // Segments coloured by comms when the file has it: orange = reporting home,
    // pale blue = only the backup beacon, grey = silent.
    const colourOf = (k: number) => {
      const ir = rep.iridium_ok?.[k];
      if (ir == null || ir) return colours.main;
      return rep.beacon_ok?.[k] ? colours.beacon : SILENT;
    };
    let prev: [number, number] | null = null;
    let colour = "";
    for (let k = 0; k <= i + 1; k++) {
      const atEnd = k === i + 1;
      if (atEnd && !Number.isFinite(here[0])) break;
      const la = atEnd ? here[0] : rep.lat[k];
      const lo = atEnd ? here[1] : rep.lon[k];
      if (la == null || lo == null) continue;
      const p = this.xy(la, lo);
      const c = colourOf(Math.min(k, i));
      if (prev) {
        if (c !== colour) {
          if (colour) g.stroke();
          colour = c;
          g.strokeStyle = c;
          g.shadowColor = c === colours.main ? colours.glow : "rgba(150,180,220,0.5)";
          g.setLineDash(c === SILENT ? [3, 3] : []);
          g.beginPath();
          g.moveTo(prev[0], prev[1]);
        }
        g.lineTo(p[0], p[1]);
      }
      prev = p;
    }
    if (colour) g.stroke();
    g.restore();

    // Event markers up to now.
    for (const e of rep.events) {
      if (e.h > hour || !isNotable(e)) continue;
      const [la, lo] = positionAt(rep, e.h);
      if (!Number.isFinite(la)) continue;
      const [x, y] = this.xy(la, lo);
      g.fillStyle = TONE_COLOUR[toneOf(e)];
      g.strokeStyle = "#0b2440";
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    // The boat.
    if (Number.isFinite(here[0])) {
      const [bx, by] = this.xy(here[0], here[1]);
      const p = (now / 1100) % 1;
      g.strokeStyle = colours.main;
      g.globalAlpha = focused ? 1 - p : 0;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(bx, by, 4 + p * 10, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = "#fff";
      g.strokeStyle = colours.main;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(bx, by, focused ? 4 : 3, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }
}
