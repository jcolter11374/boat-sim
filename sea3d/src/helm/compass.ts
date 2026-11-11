// The heading dial: tap or drag to steer. Shows your order (orange), the way
// the boat is really pointing (white), the way to the finish (green) and the
// wind (blue arrow, blowing towards).

export interface DialState {
  order: number | "finish" | "route";
  heading: number; // where the bow points now, degrees true
  finish: number; // bearing to the finish
  windTo: number | null; // where the wind blows towards
  windKn: number;
}

export class Compass {
  private g: CanvasRenderingContext2D;
  private s: DialState = { order: "finish", heading: 90, finish: 80, windTo: null, windKn: 0 };
  private dragging = false;
  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly onPick: (deg: number) => void,
  ) {
    this.g = canvas.getContext("2d")!;
    const pick = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left - r.width / 2;
      const y = e.clientY - r.top - r.height / 2;
      if (Math.hypot(x, y) < 8) return;
      let deg = (Math.atan2(x, -y) * 180) / Math.PI;
      deg = (Math.round(deg / 5) * 5 + 360) % 360; // 5 degree steps
      this.onPick(deg);
    };
    canvas.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      pick(e);
    });
    canvas.addEventListener("pointermove", (e) => this.dragging && pick(e));
    canvas.addEventListener("pointerup", () => (this.dragging = false));
  }

  set(s: Partial<DialState>): void {
    Object.assign(this.s, s);
    this.draw();
  }

  /** The heading the order means now (a number for "finish" and "route" too, for drawing). */
  private orderDeg(): number {
    const o = this.s.order;
    return typeof o === "number" ? o : o === "finish" ? this.s.finish : this.s.heading;
  }

  draw(): void {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    if (c.width !== w * dpr) {
      c.width = w * dpr;
      c.height = w * dpr;
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, w);
    const cx = w / 2;
    const R = w / 2 - 4;
    const at = (deg: number, r: number): [number, number] => {
      const a = (deg * Math.PI) / 180;
      return [cx + Math.sin(a) * r, cx - Math.cos(a) * r];
    };
    g.fillStyle = "rgba(10,22,38,.6)";
    g.beginPath();
    g.arc(cx, cx, R, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "rgba(160,200,255,.35)";
    g.lineWidth = 1;
    g.stroke();
    for (let d = 0; d < 360; d += 10) {
      const [x1, y1] = at(d, R - (d % 90 === 0 ? 10 : d % 30 === 0 ? 7 : 4));
      const [x2, y2] = at(d, R - 1);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }
    g.fillStyle = "#e9f1fb";
    g.font = "600 12px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const [d, t] of [[0, "N"], [90, "E"], [180, "S"], [270, "W"]] as [number, string][]) {
      const [x, y] = at(d, R - 20);
      g.fillText(t, x, y);
    }
    const ray = (deg: number, r0: number, r1: number, colour: string, width: number) => {
      const [x0, y0] = at(deg, r0);
      const [x1, y1] = at(deg, r1);
      g.strokeStyle = colour;
      g.lineWidth = width;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    };
    // The finish, as a green notch on the rim.
    ray(this.s.finish, R - 14, R + 1, "#3ddc97", 4);
    // The wind: a blue arrow across the middle, blowing towards windTo.
    if (this.s.windTo !== null && this.s.windKn > 0.5) {
      const d = this.s.windTo;
      ray(d + 180, R * 0.55, R * 0.2, "rgba(138,180,255,.9)", 2);
      const [tx, ty] = at(d + 180, R * 0.2);
      const a = (d * Math.PI) / 180;
      g.fillStyle = "rgba(138,180,255,.9)";
      g.beginPath();
      g.moveTo(tx + Math.sin(a) * 7, ty - Math.cos(a) * 7);
      g.lineTo(tx + Math.cos(a) * 4, ty + Math.sin(a) * 4);
      g.lineTo(tx - Math.cos(a) * 4, ty - Math.sin(a) * 4);
      g.fill();
    }
    // Where the bow points now, and the order.
    ray(this.s.heading, 0, R - 26, "rgba(255,255,255,.75)", 2);
    ray(this.orderDeg(), 0, R - 8, "#ff8a2a", 4);
    g.fillStyle = "#ff8a2a";
    g.beginPath();
    g.arc(cx, cx, 4, 0, Math.PI * 2);
    g.fill();
  }
}
