// Smoke test: serve the built page, load it in a headless browser and check
// that the sea animates at the chosen wave height, that both boats are there
// and ride the waves (sensible, finite motion), that the quality switch
// rebuilds the sea, and that the picture isn't blank. Saves screenshots of
// calm, moderate and gale to test-output/.
//
// Run after `npm run build`. Needs the `playwright` package and Chromium.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFixture } from "./fixture-voyage.mjs";
import { chromium } from "playwright";

const URL = "http://localhost:4173/";
// Run vite directly (not via npx) so server.kill() stops the server itself.
const server = spawn("node_modules/.bin/vite", ["preview", "--port", "4173", "--strictPort"], { stdio: "inherit" });
const fail = (msg) => { console.error("FAIL:", msg); server.kill(); process.exit(1); };
const HS = { calm: 0.5, moderate: 1.5, gale: 5.0 };

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(URL)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => (window.__sea3d?.frames ?? 0) > 10, null, { timeout: 30000 });
  mkdirSync("test-output", { recursive: true });
  const log = [];

  for (const sea of ["calm", "moderate", "gale"]) {
    await page.selectOption("#sea", sea);
    const f0 = await page.evaluate(() => window.__sea3d.frames);
    await page.waitForFunction((n) => window.__sea3d.frames > n + 20, f0, { timeout: 30000 });
    const s = await page.evaluate(() => window.__sea3d);
    if (Math.abs(s.hs - HS[sea]) > 1e-6) fail(`${sea} should have Hs ${HS[sea]} m, got ${s.hs}`);
    const keys = s.boats.map((b) => b.key).sort().join(",");
    if (keys !== "kayak,randolph") fail(`expected both boats, got ${keys}`);
    for (const b of s.boats) {
      for (const k of ["heave", "pitch", "roll", "surface"]) {
        if (!Number.isFinite(b[k])) fail(`${b.key} ${k} is not finite in ${sea}`);
      }
      // A floating boat stays near the water: heave within the local wave height.
      if (Math.abs(b.heave - b.surface) > Math.max(0.5, s.hs)) {
        fail(`${b.key} heave ${b.heave.toFixed(2)} m is far from the surface ${b.surface.toFixed(2)} m in ${sea}`);
      }
      if (Math.abs(b.pitch) > 1.2 || Math.abs(b.roll) > 1.2) fail(`${b.key} capsized-looking pose in ${sea}`);
    }
    const png = await page.screenshot({ path: `test-output/sea-${sea}.png` });
    // A blank canvas compresses to almost nothing; a rendered sea doesn't.
    if (png.length < 20000) fail(`${sea} screenshot looks blank (${png.length} bytes)`);
    log.push(`${sea} Hs ${s.hs} m`);
  }

  // Quality switch rebuilds the sea mesh with a different resolution.
  const vHigh = await page.evaluate(() => window.__sea3d.seaVertices);
  await page.selectOption("#quality", "low");
  await page.waitForTimeout(500);
  const vLow = await page.evaluate(() => window.__sea3d.seaVertices);
  if (!(vLow > 0 && vLow < vHigh)) fail(`low quality should use fewer sea vertices (high ${vHigh}, low ${vLow})`);
  const pngLow = await page.screenshot({ path: "test-output/sea-gale-low.png" });
  if (pngLow.length < 20000) fail(`low-quality screenshot looks blank (${pngLow.length} bytes)`);

  // Every camera button works.
  for (const shot of ["kayak", "randolph", "low", "high", "side"]) await page.click(`#shots button[data-shot="${shot}"]`);
  await page.waitForTimeout(300);
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);

  // ---------- voyage replay page ----------
  // Real replays if the build has them (sea3d/public/voyages), else a made-up fixture.
  const real = existsSync("dist/voyages/index.json");
  const dataDir = real ? "voyages" : "voyages-fixture";
  if (!real) writeFixture("dist/voyages-fixture");
  const idx = JSON.parse(readFileSync(`dist/${dataDir}/index.json`, "utf8")).voyages;
  // Every replay is position-checked; the first three also get playback and a screenshot.
  for (const [n, v] of idx.entries()) {
    const full = n < (real ? 3 : 1);
    const rep = JSON.parse(readFileSync(`dist/${dataDir}/${v.file}`, "utf8"));
    await page.goto(`${URL}voyage.html?data=./${dataDir}&voyage=${v.file}`);
    await page.waitForFunction(() => window.__replay?.ready || window.__replay?.error, null, { timeout: 30000 });
    const err = await page.evaluate(() => window.__replay.error);
    if (err) fail(`voyage page: ${err}`);
    // The page's position at every logged hour is the logged position.
    const bad = await page.evaluate((r) => {
      const out = [];
      for (let i = 0; i < r.h.length; i++) {
        if (r.lat[i] == null || r.lon[i] == null) continue;
        const [la, lo] = window.__replay.positionAt(r.h[i]);
        if (la !== r.lat[i] || lo !== r.lon[i]) out.push([r.h[i], la, lo, r.lat[i], r.lon[i]]);
      }
      return out;
    }, rep);
    if (bad.length) fail(`${v.file}: ${bad.length} logged hours drawn off the log, first ${JSON.stringify(bad[0])}`);
    // Ravi's gate: at every whole hour the boat drawn on the chart (boatPosition after
    // setHour) is the straight-line blend of the two logged rows around it, worked
    // out here independently of the page's code.
    const whole = [];
    for (let k = Math.ceil(rep.h[0]); k <= rep.h[rep.h.length - 1]; k++) {
      let i = 0;
      while (i + 1 < rep.h.length && rep.h[i + 1] <= k) i++;
      const j = Math.min(i + 1, rep.h.length - 1);
      const f = j > i ? (k - rep.h[i]) / (rep.h[j] - rep.h[i]) : 0;
      whole.push([k, rep.lat[i] + (rep.lat[j] - rep.lat[i]) * f, rep.lon[i] + (rep.lon[j] - rep.lon[i]) * f]);
    }
    const off = await page.evaluate((ws) => {
      window.__replay.pause();
      const out = [];
      for (const [k, la, lo] of ws) {
        window.__replay.setHour(k);
        const [a, b] = window.__replay.boatPosition();
        if (!(Math.abs(a - la) < 1e-9 && Math.abs(b - lo) < 1e-9)) out.push([k, a, b, la, lo]);
      }
      window.__replay.setHour(0);
      window.__replay.play();
      return out;
    }, whole);
    if (off.length) fail(`${v.file}: boat drawn off the log at ${off.length} of ${whole.length} whole hours, first ${JSON.stringify(off[0])}`);
    if (!full) {
      log.push(`${v.file} ${rep.h.length} rows, ${whole.length} whole hours checked`);
      continue;
    }
    // Playing moves time forward; the end shows the outcome card.
    const h0 = await page.evaluate(() => window.__replay.hour);
    await page.waitForTimeout(1500);
    const h1 = await page.evaluate(() => window.__replay.hour);
    if (!(h1 > h0)) fail(`${v.file}: playback didn't advance (${h0} -> ${h1})`);
    await page.evaluate(() => { window.__replay.pause(); window.__replay.setHour(window.__replay.maxHour); });
    await page.waitForSelector("#outcome.show", { timeout: 10000 });
    const pngV = await page.screenshot({ path: `test-output/voyage-${v.file.replace(".json", "")}.png` });
    if (pngV.length < 20000) fail(`voyage screenshot looks blank (${pngV.length} bytes)`);
    log.push(`${real ? "" : "fixture "}${v.file} ${rep.h.length} rows, ${whole.length} whole hours checked`);
  }
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);

  await browser.close();
  console.log(`OK: ${log.join(", ")}; both boats afloat; sea vertices high ${vHigh}, low ${vLow}`);
} catch (e) {
  fail(String(e));
}
server.kill();
