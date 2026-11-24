// Plays the arrival at the dock in Cascais (John, 24 Nov 2026: "Azores and a dock in Portugal") in a
// headless browser, without sailing a crossing first: the finish scene off Cabo da Roca (cut short),
// then the cut to Cascais and her coming alongside the marina's pontoon. Prints where she is, how far
// she is from the pontoon and what land is loaded, and takes pictures.
//
//   npm run build   (with Cascais's town in public/land: cascais.json and cascais_height.bin)
//   node tools/qa/portugal-dock.mjs [picture folder] [--full]
//
// --full: full-quality graphics (?gl=full&quality=high), slow on a machine without a graphics card.
// Exits 1 if the town didn't load, she didn't reach her berth, or she isn't 1.5 to 5 m off the pontoon's edge.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const full = process.argv.includes("--full");
if (out) mkdirSync(out, { recursive: true });
const PORT = 4184;
const URL = `http://localhost:${PORT}/`;
const server = spawn("node_modules/.bin/vite", ["preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const done = (code) => { server.kill(); process.exit(code); };
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.goto(`${URL}helm.html?${full ? "gl=full&quality=high" : "quality=low"}`);
await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 180000 });
await page.evaluate(() => { document.getElementById("start").hidden = true; });
let bad = 0;
const check = (ok, words) => { console.log(`${ok ? "ok  " : "FAIL"} ${words}`); if (!ok) bad++; };
const t0 = Date.now();
await page.evaluate(() => { void window.__helm.arrive(59.3, 1).then(() => window.__helm.comeAlongside()); });
await page.waitForFunction(() => window.__helm.scene === "landing", null, { timeout: 120000 }).catch(() => {});
const state = () => page.evaluate(() => ({ scene: window.__helm.scene, landing: window.__helm.landing, land: window.__helm.land, at: window.__helm.landingAt }));
let s = await state();
check(s.scene === "landing", `the cut to Cascais, then the scene (${((Date.now() - t0) / 1000).toFixed(1)} s after the finish scene began)`);
console.log(JSON.stringify(s));
if (out) await page.screenshot({ path: `${out}/coming-in.png` });
// The town file's piers[9], whose bay side she lies along (town frame, metres; origin 38.6915N 9.4150W).
const town = JSON.parse(readFileSync("public/land/cascais.json", "utf8"));
const pier = town.piers[9];
const mx = 111320 * Math.cos((town.origin[0] * Math.PI) / 180), my = 110950;
const off = (lat, lon) => {
  const x = (lon - town.origin[1]) * mx, z = -(lat - town.origin[0]) * my;
  let best = Infinity;
  for (let i = 0; i < pier.length; i++) {
    const [ax, az] = pier[i], [bx, bz] = pier[(i + 1) % pier.length];
    const k = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2)));
    best = Math.min(best, Math.hypot(x - ax - k * (bx - ax), z - az - k * (bz - az)));
  }
  return best;
};
await page.waitForFunction(() => window.__helm.scene === "", null, { timeout: 180000 });
// Software graphics draw few frames a second, and her clock is the frames': wait for her to stop, however long.
let last = "";
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(4000);
  const now = JSON.stringify(await page.evaluate(() => window.__helm.landingAt));
  if (now === last) break;
  last = now;
}
s = await state();
console.log(JSON.stringify(s));
if (s.at) {
  const m = off(s.at[0], s.at[1]);
  check(m > 1.5 && m < 5, `she lies ${m.toFixed(1)} m off the pontoon's edge`);
}
if (out) await page.screenshot({ path: `${out}/alongside.png` });
await browser.close();
done(bad ? 1 : 0);
