// Plays the start of a crossing in a headless browser, steps on board (V), looks around by
// dragging, steers with the arrow keys, and steps off again. Saves pictures and prints where the
// camera is against the boat at each step.
//
//   tools/build_site.sh   (from the repo root)
//   [PYODIDE_DIR=...] node tools/qa/onboard-view.mjs [outdir=test-output/onboard] [boat, e.g. stock_cruiser31]
//
// Exits 1 if the camera isn't on the boat while on board, or doesn't come back where it was.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const out = process.argv[2] || "test-output/onboard";
const boat = process.argv[3] || "";
mkdirSync(out, { recursive: true });
const PORT = 4183;
const server = spawn("node_modules/.bin/vite", ["preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const done = (code) => { server.kill(); process.exit(code); };
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
if (process.env.PYODIDE_DIR) {
  await context.route("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/**", (route) => {
    const name = new globalThis.URL(route.request().url()).pathname.split("/").pop();
    const type = name.endsWith(".mjs") || name.endsWith(".js") ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".json") ? "application/json" : "application/octet-stream";
    route.fulfill({ body: readFileSync(`${process.env.PYODIDE_DIR}/${name}`), contentType: type, headers: { "access-control-allow-origin": "*" } });
  });
}
const page = await context.newPage();
page.on("pageerror", (e) => console.error("page error:", e.message));
const tag = boat || "kayak";
const view = async (label) => {
  const s = await page.evaluate(() => ({ onboard: window.__helm.onboard, ...window.__helm.camView(), order: document.getElementById("c-orderv").textContent }));
  const d = s.boat ? Math.hypot(s.cam[0] - s.boat[0], s.cam[1] - s.boat[1], s.cam[2] - s.boat[2]) : NaN;
  console.log(label, JSON.stringify({ ...s, camToBoatM: Math.round(d * 10) / 10 }));
  await page.screenshot({ path: `${out}/${tag}-${label}.png` });
  return { ...s, d };
};
await page.goto(`http://localhost:${PORT}/helm.html?quality=low&clock=paused${boat ? `&boat=${boat}` : ""}`);
await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 120000 });
if (boat) await page.evaluate((b) => { const r = document.querySelector(`#boats input[value="${b}"]`); if (r) { r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); } }, boat);
await page.click("#go");
await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 300000 });
await page.mouse.click(640, 300); // past the goal card (the clock stays paused: daylight on the pictures)
await page.waitForTimeout(2500);
const before = await view("1-beside");
await page.keyboard.press("KeyV");
await page.waitForTimeout(1500);
const on = await view("2-on-board");
await page.mouse.move(700, 400);
await page.mouse.down();
await page.mouse.move(400, 430, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(800);
await view("3-looking-right");
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(1500);
const steered = await view("4-steered");
await page.keyboard.press("KeyV");
await page.waitForTimeout(1200);
const off = await view("5-stepped-off");
await browser.close();
const ok = !before.onboard && on.onboard && on.d < 12 && !off.onboard && Math.abs(off.d - before.d) < 1.5 && steered.order !== before.order;
console.log(ok ? "OK" : "FAIL");
done(ok ? 0 : 1);
