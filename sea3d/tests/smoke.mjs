// Smoke test: serve the built page, load it in a headless browser and check
// that the sea animates at the chosen wave height, that both boats are there
// and ride the waves (sensible, finite motion), that the quality switch
// rebuilds the sea, and that the picture isn't blank. Saves screenshots of
// calm, moderate and gale to test-output/.
//
// Run after `npm run build`. Needs the `playwright` package and Chromium.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFixture, writeRaceFixture } from "./fixture-voyage.mjs";
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
  // Low quality throughout: CI draws with software graphics at about one frame a
  // second, and the frame-count waits below need headroom. High is checked once.
  await page.goto(`${URL}?quality=low`);
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
  const vLow = await page.evaluate(() => window.__sea3d.seaVertices);
  await page.selectOption("#quality", "high");
  await page.waitForTimeout(500);
  const vHigh = await page.evaluate(() => window.__sea3d.seaVertices);
  if (!(vLow > 0 && vLow < vHigh)) fail(`low quality should use fewer sea vertices (high ${vHigh}, low ${vLow})`);
  const pngHigh = await page.screenshot({ path: "test-output/sea-gale-high.png" });
  if (pngHigh.length < 20000) fail(`high-quality screenshot looks blank (${pngHigh.length} bytes)`);
  await page.selectOption("#quality", "low");

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
    await page.goto(`${URL}voyage.html?quality=low&data=./${dataDir}&voyage=${v.file}`);
    await page.waitForFunction(() => window.__replay?.ready || window.__replay?.error, null, { timeout: 30000 });
    const err = await page.evaluate(() => window.__replay.error);
    if (err) fail(`voyage page: ${err}`);
    // The detailed Blender boats are used when the build has them.
    for (const m of ["kayak", "randolph"]) {
      if (!existsSync(`dist/models/${m}.glb`)) continue;
      await page.waitForFunction((name) => window.__replay.models?.includes(name), m, { timeout: 30000 }).catch(() => fail(`models/${m}.glb is in the build but the page didn't load it`));
    }
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
    // Working equipment: each boat's moving parts exist.
    const g0 = (await page.evaluate(() => window.__replay.gear)).parts ?? {};
    const sailboat = /randolph/i.test(rep.boat ?? "");
    const gearOk = sailboat ? g0.props === 0 && g0.wing && g0.vane : g0.props === 2 && !g0.wing;
    const c0 = await page.evaluate(() => window.__replay.contact);
    if (!(c0.collar > 0)) fail(`${v.file}: no foam where the hull meets the water: ${JSON.stringify(c0)}`);
    if (!gearOk || !g0.rudder || !g0.light || !(g0.panels > 0)) fail(`${v.file}: gear missing: ${JSON.stringify(g0)}`);
    await page.evaluate(() => { window.__replay.pause(); window.__replay.setHour(window.__replay.maxHour); });
    await page.waitForSelector("#outcome.show", { timeout: 10000 });
    // Every part the log says broke is shown broken: a warning sign on the boat and a red chip.
    await page.waitForTimeout(400);
    const broke = [...new Set(rep.events.filter((e) => e.kind === "part_failed").map((e) => e.detail.split(" ")[0]))].sort();
    const g1 = await page.evaluate(() => window.__replay.gear);
    if (JSON.stringify([...g1.failed].sort()) !== JSON.stringify(broke)) fail(`${v.file}: gear shows broken ${JSON.stringify(g1.failed)}, log says ${JSON.stringify(broke)}`);
    const unsigned = broke.filter((p) => !g1.now.signs.includes(p));
    if (real && unsigned.length) fail(`${v.file}: no warning sign for ${unsigned.join(", ")}`);
    const pngV = await page.screenshot({ path: `test-output/voyage-${v.file.replace(".json", "")}.png` });
    if (pngV.length < 20000) fail(`voyage screenshot looks blank (${pngV.length} bytes)`);
    log.push(`${real ? "" : "fixture "}${v.file} ${rep.h.length} rows, ${whole.length} whole hours checked`);
  }
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);

  // ---------- race mode: two boats, one clock ----------
  // Real Randolph replays if the build has them, else a made-up race fixture.
  const raceIdx = idx.filter((v) => /randolph/i.test(v.boat ?? ""));
  const raceDate = raceIdx.map((v) => v.start.slice(0, 10)).find((d) => idx.some((v) => !/randolph/i.test(v.boat ?? "") && v.start.startsWith(d)));
  const raceDir = raceDate ? dataDir : "voyages-race-fixture";
  if (!raceDate) writeRaceFixture(`dist/${raceDir}`);
  const date = raceDate ?? "2020-05-01";
  await page.goto(`${URL}voyage.html?quality=low&data=./${raceDir}&race=${date}`);
  await page.waitForFunction(() => window.__replay?.ready || window.__replay?.error, null, { timeout: 30000 });
  const rerr = await page.evaluate(() => window.__replay.error);
  if (rerr) fail(`race page: ${rerr}`);
  const boats = await page.evaluate(() => window.__replay.boats);
  if (boats.length !== 2 || !/randolph/i.test(boats[1])) fail(`race should show our kayak then Randolph, got ${JSON.stringify(boats)}`);
  const rIdx = JSON.parse(readFileSync(`dist/${raceDir}/index.json`, "utf8")).voyages;
  const rFiles = [rIdx.find((v) => !/randolph/i.test(v.boat ?? "") && v.start.startsWith(date)), rIdx.find((v) => /randolph/i.test(v.boat ?? "") && v.start.startsWith(date))];
  let maxEnd = 0;
  for (const [lane, v] of rFiles.entries()) {
    const r = JSON.parse(readFileSync(`dist/${raceDir}/${v.file}`, "utf8"));
    maxEnd = Math.max(maxEnd, r.h.at(-1));
    const off = await page.evaluate(([r, lane]) => {
      let n = 0;
      for (let i = 0; i < r.h.length; i++) {
        if (r.lat[i] == null || r.lon[i] == null) continue;
        const [la, lo] = window.__replay.lanePositionAt(lane, r.h[i]);
        if (la !== r.lat[i] || lo !== r.lon[i]) n++;
      }
      return n;
    }, [r, lane]);
    if (off) fail(`race lane ${lane} (${v.file}): ${off} logged hours drawn off the log`);
  }
  const maxHour = await page.evaluate(() => window.__replay.maxHour);
  if (maxHour !== maxEnd) fail(`race clock should run to the longer voyage (${maxEnd} h), runs to ${maxHour} h`);
  await page.click('#focus button[data-lane="1"]');
  await page.waitForTimeout(800);
  if ((await page.evaluate(() => window.__replay.focus)) !== 1) fail("close-up didn't switch to the Randolph boat");
  // Its moving parts: wing, wind vane, rudder, comms light; no propellers.
  const gR = (await page.evaluate(() => window.__replay.gear)).parts ?? {};
  if (gR.props !== 0 || !gR.wing || !gR.vane || !gR.rudder || !gR.light) fail(`Randolph gear missing: ${JSON.stringify(gR)}`);
  await page.screenshot({ path: "test-output/voyage-race-randolph.png" });
  await page.evaluate(() => { window.__replay.pause(); window.__replay.setHour(window.__replay.maxHour); });
  await page.waitForSelector("#outcome.show", { timeout: 10000 });
  const pngR = await page.screenshot({ path: "test-output/voyage-race-end.png" });
  if (pngR.length < 20000) fail(`race screenshot looks blank (${pngR.length} bytes)`);
  log.push(`${raceDate ? "" : "fixture "}race ${date}`);
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);

  // "Pick your launch day": pick a boat, a day and a guess; the story stops at
  // its beats; the result scores the guess; the postcard draws.
  await page.goto(`${URL}voyage.html?quality=low&data=./${dataDir}&mode=game`);
  await page.waitForFunction(() => window.__replay?.game.picking, null, { timeout: 60000 });
  const picker = await page.locator("#g-dates").innerText();
  if (/lost|finish|days|aground|disq/i.test(picker)) fail(`the date picker gives the ending away: ${picker}`);
  const nDates = await page.locator("#g-dates button").count();
  if (!nDates) fail("no launch days to pick");
  await page.locator("#g-dates button").first().click();
  await page.locator('#g-guess button[data-guess="no"]').click();
  await page.locator("#g-go").click();
  await page.waitForFunction(() => window.__replay.game.beat === "launch", null, { timeout: 60000 });
  await page.locator("#b-next").click();
  await page.locator('#warp button[data-warp="24"]').click(); // it starts in real time
  const g0 = await page.evaluate(() => window.__replay.maxHour);
  await page.evaluate((h) => { window.__replay.setHour(h - 1); window.__replay.play(); }, g0);
  // Any beats near the end show and are dismissed; then the result card.
  for (let i = 0; i < 5; i++) {
    const r = await page.waitForFunction(() => window.__replay.game.result || window.__replay.game.beat, null, { timeout: 60000 }).then((h) => h.jsonValue());
    if (await page.evaluate(() => !!window.__replay.game.result)) break;
    await page.locator("#b-next").click();
  }
  const game = await page.evaluate(() => window.__replay.game);
  if (!game.result || game.guess !== "no") fail(`game never scored the guess: ${JSON.stringify(game)}`);
  const card = await page.evaluate(() => window.__replay.postcard());
  if (!card.startsWith("data:image/png") || card.length < 50000) fail(`postcard looks empty (${card.length} chars)`);
  log.push(`game ${game.beats.join("/")} -> ${game.result}`);
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);

  await browser.close();
  console.log(`OK: ${log.join(", ")}; both boats afloat; sea vertices high ${vHigh}, low ${vLow}`);
} catch (e) {
  fail(String(e));
}
server.kill();
