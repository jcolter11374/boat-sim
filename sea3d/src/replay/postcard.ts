// The postcard at the end of "Pick your launch day": the 3D view as the photo,
// the voyage map in a corner, and a few lines about the voyage and the guess.
// Drawn on a 2D canvas and saved as a PNG; nothing leaves the page.

export interface PostcardText {
  boat: string; // "Our kayak" / "Our model of the Randolph boat"
  launched: string; // "15 Apr 2020"
  outcome: string; // outcomeLine()
  guess: string; // "You called it!" + the sentence
  finished: boolean;
}

const W = 1500;
const H = 1000;

/** Cover-crop src into the rectangle (x, y, w, h). */
function cover(g: CanvasRenderingContext2D, src: CanvasImageSource & { width: number; height: number }, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / src.width, h / src.height);
  const sw = w / s;
  const sh = h / s;
  g.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, x, y, w, h);
}

/** Draw the postcard. view: the 3D canvas; map: the chart canvas (either may be blank). */
export function drawPostcard(view: HTMLCanvasElement, map: HTMLCanvasElement | null, t: PostcardText): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  // Card and white border, like a printed photo postcard.
  g.fillStyle = "#f6f1e7";
  g.fillRect(0, 0, W, H);
  const px = 36;
  const ph = 700;
  g.fillStyle = "#0b1726";
  g.fillRect(px, px, W - 2 * px, ph);
  if (view.width && view.height) {
    // A touch brighter than the screen: prints and thumbnails look darker.
    g.filter = "brightness(1.18) saturate(1.08)";
    cover(g, view, px, px, W - 2 * px, ph);
    g.filter = "none";
  }

  // Big greeting across the photo.
  g.save();
  g.shadowColor = "rgba(0,0,0,.55)";
  g.shadowBlur = 18;
  g.fillStyle = "#fff";
  g.font = "italic 700 64px Georgia, 'Times New Roman', serif";
  g.fillText("Greetings from the", px + 40, px + 96);
  g.font = "italic 800 92px Georgia, 'Times New Roman', serif";
  g.fillText("North Atlantic!", px + 40, px + 190);
  g.restore();

  // The voyage map, top right of the photo.
  if (map && map.width && map.height) {
    const mw = 430;
    const mh = Math.round((mw * map.height) / map.width);
    const mx = W - px - mw - 24;
    const my = px + 24;
    g.save();
    g.shadowColor = "rgba(0,0,0,.5)";
    g.shadowBlur = 16;
    g.fillStyle = "#f6f1e7";
    g.fillRect(mx - 8, my - 8, mw + 16, mh + 16);
    g.restore();
    g.drawImage(map, mx, my, mw, mh);
  }

  // Stamp: what happened.
  const sx = W - px - 120;
  const sy = px + ph + 140;
  g.save();
  g.translate(sx, sy);
  g.rotate(-0.18);
  g.strokeStyle = t.finished ? "#1f8a5b" : "#b8432f";
  g.fillStyle = g.strokeStyle;
  g.lineWidth = 6;
  g.beginPath();
  g.arc(0, 0, 92, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 2;
  g.beginPath();
  g.arc(0, 0, 80, 0, Math.PI * 2);
  g.stroke();
  g.textAlign = "center";
  g.font = "800 30px system-ui, 'Segoe UI', sans-serif";
  g.fillText(t.finished ? "FINISHED" : "AT SEA", 0, 4);
  g.font = "600 15px system-ui, 'Segoe UI', sans-serif";
  g.fillText(t.finished ? "PORTUGAL" : "NORTH ATLANTIC", 0, 32);
  g.fillText(t.launched.toUpperCase(), 0, -26);
  g.restore();

  // Text on the white strip.
  g.fillStyle = "#1d2a38";
  g.font = "700 40px system-ui, 'Segoe UI', sans-serif";
  g.fillText(`${t.boat}, launched ${t.launched}`, px + 8, px + ph + 70);
  g.font = "500 30px system-ui, 'Segoe UI', sans-serif";
  g.fillStyle = "#33465b";
  g.fillText(t.outcome, px + 8, px + ph + 122);
  g.fillText(t.guess, px + 8, px + ph + 170);
  g.font = "400 20px system-ui, 'Segoe UI', sans-serif";
  g.fillStyle = "#7a8794";
  g.fillText("A simulated voyage in the real weather of 2020 · boat-sim", px + 8, H - px - 6);
  return c;
}

/** Save a canvas as a PNG download. */
export function savePng(c: HTMLCanvasElement, name: string): void {
  const a = document.createElement("a");
  a.download = name;
  a.href = c.toDataURL("image/png");
  document.body.appendChild(a);
  a.click();
  a.remove();
}
