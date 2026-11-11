// The forecast strip: the next five days at the boat, every 6 hours, from the
// same forecast the base station gets (with a forecast's errors, not the truth).
// Wind (arrow blowing towards, knots), waves (m) and sunshine.

import type { ForecastRow } from "./game";

const KN = 1.94384;

export function drawForecast(c: HTMLCanvasElement, rows: ForecastRow[], start: number): void {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  c.width = w * dpr;
  c.height = h * dpr;
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!rows.length) return;
  const n = rows.length;
  const col = w / n;
  g.textAlign = "center";
  g.textBaseline = "middle";
  let lastDay = "";
  rows.forEach((r, i) => {
    const x = col * (i + 0.5);
    const t = Date.parse(r.t + "Z");
    const day = `Day ${Math.floor((t - start) / 86400e3)}`;
    // Day labels and separators at midnight UTC.
    if (day !== lastDay) {
      lastDay = day;
      g.fillStyle = "rgba(160,200,255,.18)";
      g.fillRect(col * i, 0, 1, h);
      g.fillStyle = "#9fb3c8";
      g.font = "600 10px system-ui, sans-serif";
      g.textAlign = "left";
      g.fillText(day, col * i + 3, 8);
      g.textAlign = "center";
    }
    const kn = Math.hypot(r.wind_u, r.wind_v) * KN;
    // Wind arrow, pointing where the wind blows, coloured by strength.
    const a = Math.atan2(r.wind_u, r.wind_v); // radians from north, towards
    const L = Math.min(col * 0.42, 11);
    const cy = 26;
    g.save();
    g.translate(x, cy);
    g.rotate(a);
    g.strokeStyle = g.fillStyle = kn > 30 ? "#ff5d5d" : kn > 20 ? "#ffc247" : "#8ab4ff";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, L);
    g.lineTo(0, -L + 4);
    g.stroke();
    g.beginPath();
    g.moveTo(0, -L);
    g.lineTo(4, -L + 6);
    g.lineTo(-4, -L + 6);
    g.fill();
    g.restore();
    g.fillStyle = "#e9f1fb";
    g.font = "600 11px system-ui, sans-serif";
    if (i % 2 === 0 || col > 26) g.fillText(kn.toFixed(0), x, 46);
    g.fillStyle = "#9fb3c8";
    g.font = "10px system-ui, sans-serif";
    if (i % 2 === 0 || col > 26) g.fillText(`${r.hs.toFixed(1)}m`, x, 60);
    // Sunshine bar along the bottom.
    const sun = Math.min(r.ghi / 900, 1);
    g.fillStyle = `rgba(255,194,71,${0.15 + 0.75 * sun})`;
    g.fillRect(col * i + 1, h - 6, col - 2, 5 * Math.max(sun, 0.1));
  });
}
