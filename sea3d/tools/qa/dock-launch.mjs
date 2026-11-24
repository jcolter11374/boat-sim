// Plays the start of a crossing in a headless browser and saves pictures of the dock launch:
// alongside the pier behind the Set sail card, on her way out of the harbour, the cut's words,
// and the open sea after it. Prints what the page says at each step (window.__helm.dock, the
// land in the scene, the boat's place) and how long Set sail took to reach the sea.
//
//   tools/build_site.sh   (from the repo root: the page, the simulator and the land files)
//   [PYODIDE_DIR=...] node tools/qa/dock-launch.mjs [outdir=test-output/dock] [query, e.g. quality=low]
//
// Exits 1 if she isn't at the dock before the start, or isn't at the drop point after the cut.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const out = process.argv[2] || "test-output/dock";
const query = process.argv[3] || "quality=low&clock=paused";
mkdirSync(out, { recursive: true });
const PORT = 4181;
const URL = `http://localhost:${PORT}/`;
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
const say = async (label) => {
  const s = await page.evaluate(() => ({ dock: window.__helm.dock, land: window.__helm.land?.place, km: Math.round((window.__helm.land?.km ?? 0) * 10) / 10, buildings: window.__helm.land?.buildings, scene: window.__helm.scene, ready: window.__helm.ready, cam: window.__helm.camView().cam, at: window.__helm.status?.boat ? [window.__helm.status.boat.lat, window.__helm.status.boat.lon] : null }));
  console.log(label, JSON.stringify(s));
  await page.screenshot({ path: `${out}/${label}.png` });
  return s;
};
await page.goto(`${URL}helm.html?${query}`);
await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 120000 });
// The town takes a moment to load and build.
await page.waitForFunction(() => window.__helm.land?.buildings > 0, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(3000);
const tied = await say("1-tied-up");
const t0 = Date.now();
await page.click("#go");
await page.waitForTimeout(3000);
const leaving = await say("2-leaving");
await page.waitForFunction(() => !document.getElementById("dockcut").hidden, null, { timeout: 300000 });
await page.waitForTimeout(1200);
await say("3-cut");
await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 300000 });
const secs = (Date.now() - t0) / 1000;
await page.waitForTimeout(1500);
const sea = await say("4-open-sea");
console.log(`Set sail to the open sea: ${secs.toFixed(1)} s`);
const err = await page.evaluate(() => window.__helm.error);
if (err) { console.error("the simulator didn't start:", err); done(2); }
const ok = tied.dock === "tied" && leaving.dock === "leaving" && sea.dock === "" && sea.at && Math.abs(sea.at[1] + 74.94) < 0.5;
await browser.close();
done(ok ? 0 : 1);
