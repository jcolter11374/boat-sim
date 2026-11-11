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
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  // Thread sandboxes can't reach the Pyodide CDN: PYODIDE_DIR=<unpacked pyodide release>
  // serves it from disk (CI reaches the CDN and leaves this unset).
  if (process.env.PYODIDE_DIR) {
    await context.route("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/**", (route) => {
      const name = new globalThis.URL(route.request().url()).pathname.split("/").pop();
      const type = name.endsWith(".mjs") || name.endsWith(".js") ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".json") ? "application/json" : "application/octet-stream";
      route.fulfill({ body: readFileSync(`${process.env.PYODIDE_DIR}/${name}`), contentType: type, headers: { "access-control-allow-origin": "*" } });
    });
  }
  const page = await context.newPage();
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
    // Sky guide: the North Star stands due north at the boat's latitude; the sun and moon are where the almanac puts them.
    const sky = await page.evaluate(() => ({ ...window.__replay.sky, here: window.__replay.boatPosition() }));
    if (!(Math.abs(sky.polarisEl - sky.here[0]) < 1.2 && Math.min(sky.polarisAz, 360 - sky.polarisAz) < 1.5))
      fail(`${v.file}: North Star not due north at the boat's latitude: ${JSON.stringify(sky)}`);
    if (![sky.sunEl, sky.sunAz, sky.moonEl, sky.moonAz, sky.view].every(Number.isFinite)) fail(`${v.file}: sky guide numbers missing: ${JSON.stringify(sky)}`);
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

  // Weather: rain and a wet hull in the wettest hour of the log (found from the file, since the
  // track and so the weather it meets change whenever the autopilot does; about 7 mm/h of ERA5
  // rain), dry and clear on day 2. Rain follows the logged rain column since #172/#175.
  await page.goto(`${URL}voyage.html?voyage=voyage_2020-04-01.json&quality=low`);
  await page.waitForFunction(() => window.__replay?.ready, null, { timeout: 60000 });
  // Points of interest: the card for the Bay mouth is up at the drop, with an https source link.
  await page.waitForFunction(() => window.__replay.pois.shown.includes("cape-henry") && document.querySelector(".poi-card a"), null, { timeout: 30000 })
    .catch(async () => fail(`no point-of-interest card at the drop: ${JSON.stringify(await page.evaluate(() => window.__replay.pois))}`));
  const poiLink = await page.evaluate(() => document.querySelector(".poi-card a").href);
  if (!poiLink.startsWith("https://")) fail(`point-of-interest link isn't https: ${poiLink}`);
  log.push(`points of interest: ${await page.evaluate(() => window.__replay.pois.shown.join("/"))}`);
  const wettest = await page.evaluate(async () => {
    const r = await (await fetch("voyages/voyage_2020-04-01.json")).json();
    let i = 0;
    r.rain.forEach((v, k) => { if ((v ?? 0) > (r.rain[i] ?? 0)) i = k; });
    return Math.floor(r.h[i]);
  });
  await page.evaluate((h) => { window.__replay.pause(); window.__replay.setHour(h); }, wettest);
  await page.waitForFunction(() => window.__replay.rain > 0.5 && window.__replay.wet > 0.5, null, { timeout: 30000 })
    .catch(async () => fail(`no rain in the blow (hour ${wettest}): ${JSON.stringify(await page.evaluate(() => [window.__replay.rain, window.__replay.wet]))}`));
  await page.evaluate(() => window.__replay.setHour(30));
  await page.waitForFunction(() => window.__replay.rain < 0.05, null, { timeout: 30000 }).catch(() => fail("rain on a calm day"));
  log.push("rain in the blow, dry on a calm day");
  // Water pours off the deck after a knockdown, and the boat stays soaked for a while.
  await page.evaluate(() => window.__replay.pour());
  await page.waitForFunction(() => window.__replay.drains >= 1 && window.__replay.wet > 0.9, null, { timeout: 30000 })
    .catch(async () => fail(`no water off the deck: ${JSON.stringify(await page.evaluate(() => [window.__replay.drains, window.__replay.wet]))}`));
  // Fog banks and low cloud draw without errors when they're in.
  await page.evaluate(() => { window.__replay.force.fog = 1; window.__replay.force.cloud = 0.8; window.__replay.setHour(31); });
  await page.waitForFunction(() => window.__replay.fog > 0.9 && window.__replay.cloud > 0.7, null, { timeout: 30000 })
    .catch(async () => fail(`no fog or cloud: ${JSON.stringify(await page.evaluate(() => [window.__replay.fog, window.__replay.cloud]))}`));
  await page.evaluate(() => { window.__replay.force.fog = -1; window.__replay.force.cloud = -1; });
  if (errors.length) fail(`page errors with fog and cloud: ${errors.join("; ")}`);
  log.push("water off the deck, fog and cloud");

  // Live tracker on the sample feed (Sam's replay mode, day 30: main box down, beacon only):
  // the "simulated voyage" label, "now" at the latest report, and the forecast look past it.
  await page.goto(`${URL}voyage.html?live&feed=feed-sample/&quality=low`);
  await page.waitForFunction(() => window.__replay?.ready && window.__replay.frames > 2, null, { timeout: 60000 })
    .catch(async () => fail(`live tracker didn't load: ${await page.evaluate(() => window.__replay?.error)}`));
  const lv = await page.evaluate(() => ({ ...window.__replay.live, hour: window.__replay.hour, label: /simulated voyage/.test(document.getElementById("h1").textContent), local: document.getElementById("w-local").textContent }));
  if (!lv.simulated || !lv.label) fail(`simulated feed without its label: ${JSON.stringify(lv)}`);
  if (!/^\d+:\d\d(:\d\d)? [AP]M local \(UTC/.test(lv.local)) fail(`no local time under the clock: ${JSON.stringify(lv)}`);
  if (Math.abs(lv.hour - lv.now) > 0.01 || lv.now < lv.lastFix || lv.fixes < 50) fail(`live tracker not at now: ${JSON.stringify(lv)}`);
  await page.evaluate((h) => window.__replay.setHour(h), lv.now + 24 * 5);
  await page.waitForFunction(() => window.__replay.live.forecast === true, null, { timeout: 30000 }).catch(() => fail("no forecast look past now"));
  await page.evaluate(() => window.__replay.goNow());
  await page.waitForFunction(() => window.__replay.live.forecast === false, null, { timeout: 30000 }).catch(() => fail("Now didn't come back from the forecast"));
  if (errors.length) fail(`page errors in the live tracker: ${errors.join("; ")}`);
  log.push(`live tracker: ${lv.fixes} fixes, now day ${(lv.now / 24).toFixed(1)}, labelled, ${lv.local}`);

  // Boatyard: the catalog loads, a swap changes the totals, the model and the share link.
  await page.goto(`${URL}boatyard.html?quality=low`);
  await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 2, null, { timeout: 60000 });
  const y0 = await page.evaluate(() => window.__yard.summary);
  await page.locator('.opt[data-slot="thr"][data-opt="one-t200"]').click();
  await page.locator('.opt[data-slot="bat"][data-opt="two-100ah"]').click();
  const y1 = await page.evaluate(() => ({ s: window.__yard.summary, d: window.__yard.dressed, share: window.__yard.share }));
  if (!(y1.s.batteryWh === 2560 && y1.s.thrusters === 1 && y1.s.massKg > y0.massKg && y1.d.thrusters === 1))
    fail(`boatyard swap didn't take: ${JSON.stringify(y1)}`);
  if (y1.share !== "#thr=one-t200&bat=two-100ah") fail(`boatyard share link: ${y1.share}`);
  if ((await page.evaluate(() => window.__yard.view)) !== "inside") fail("boatyard: a battery swap should open the see-inside view");
  await page.goto(`${URL}boatyard.html?quality=low${y1.share}`);
  await page.waitForFunction(() => window.__yard?.ready, null, { timeout: 60000 });
  const y2 = await page.evaluate(() => window.__yard.design.picks);
  if (y2.thr !== "one-t200" || y2.bat !== "two-100ah") fail(`boatyard link didn't reopen the design: ${JSON.stringify(y2)}`);
  // Every choice looks different on the boat (spares stay ashore; one-option slots have nothing to swap).
  const looks = await page.evaluate(() => {
    const y = window.__yard;
    const same = [];
    for (const b of document.querySelectorAll(".opt")) {
      const slot = b.dataset.slot;
      if (slot === "spares") continue;
      const opts = [...document.querySelectorAll(`.opt[data-slot="${slot}"]`)].map((o) => o.dataset.opt);
      if (opts[0] !== b.dataset.opt) continue;
      const seen = new Map();
      for (const o of opts) {
        y.pick(slot, o);
        const k = JSON.stringify(y.dressed);
        if (seen.has(k)) same.push(`${slot}: ${seen.get(k)} = ${o}`);
        seen.set(k, o);
      }
      y.pick(slot, opts[0]);
    }
    return same;
  });
  if (looks.length) fail(`boatyard: choices that look the same on the boat: ${looks.join("; ")}`);
  const greyed = await page.evaluate(() => ({
    noeff: document.querySelectorAll(".opt.noeff").length,
    shape: !!document.querySelector('.opt[data-slot="shape"]'),
  }));
  if (!greyed.shape || greyed.noeff < 3) fail(`boatyard: the simulator's new slots or "no effect yet" options are missing: ${JSON.stringify(greyed)}`);
  // The other hull shapes show their own models (when the build has them), in place of the kayak.
  const shapes = await page.evaluate(async () => {
    const out = {};
    for (const id of ["cat", "semisub", "board"]) {
      const built = await fetch(`./models/shape_${id}.glb`, { method: "HEAD" }).then((r) => r.ok && !/text\/html/.test(r.headers.get("content-type") ?? ""), () => false);
      window.__yard.pick("shape", id);
      const t0 = performance.now();
      while (built && !window.__yard.dressed.shapeModel && performance.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 200));
      out[id] = { built, shown: !!window.__yard.dressed.shapeModel };
    }
    window.__yard.pick("shape", "kayak");
    return out;
  });
  for (const [id, s] of Object.entries(shapes)) if (s.built && !s.shown) fail(`boatyard: the ${id} model was built but the kayak still shows`);
  log.push(`shapes ${Object.entries(shapes).map(([id, s]) => `${id} ${s.shown ? "shown" : s.built ? "MISSING" : "not built"}`).join(" / ")}`);
  // No grid or sandbox files in a test build: the launch says so instead of hanging.
  await page.click("#launch");
  await page.waitForFunction(() => window.__yard.backend && !document.querySelector("#launch").disabled, null, { timeout: 30000 });
  const how = await page.evaluate(() => ({ backend: window.__yard.backend, text: document.querySelector("#result").textContent }));
  if (!how.text || /failed/.test(how.text)) fail(`boatyard launch: ${JSON.stringify(how)}`);
  log.push(`boatyard ${y1.share}, ${greyed.noeff} greyed options, launch via ${how.backend}`);
  // Start from the Randolph boat: its own slots and totals, the model dressing to the picks, a share link with the base.
  await page.goto(`${URL}boatyard.html?quality=low&base-test=1#base=revc&rudder=single`); // a new query: a hash-only change would not reload
  await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 2, null, { timeout: 60000 });
  const rc = await page.evaluate(() => ({ base: window.__yard.base, s: window.__yard.summary, d: window.__yard.dressed, share: window.__yard.share }));
  if (rc.base !== "revc" || rc.s.solarW !== 40 || rc.s.batteryWh !== 192 || rc.s.thrusters !== 0 || Math.abs(rc.s.massKg - 24.85) > 0.01)
    fail(`boatyard Rev C totals: ${JSON.stringify(rc)}`);
  if (rc.d.rudders !== 1 || !rc.d.tracker) fail(`boatyard Rev C model didn't dress to the picks: ${JSON.stringify(rc.d)}`);
  if (rc.share !== "#base=revc&rudder=single") fail(`boatyard Rev C share link: ${rc.share}`);
  await page.evaluate(() => window.__yard.pick("rudder", "twin"));
  if ((await page.evaluate(() => window.__yard.dressed.rudders)) !== 2) fail("boatyard Rev C: twin rudders don't show");
  await page.click("#launch");
  await page.waitForFunction(() => window.__yard.launch || window.__yard.launchError, null, { timeout: 30000 });
  const rl = await page.evaluate(() => ({ backend: window.__yard.backend, n: window.__yard.launch?.replays.length ?? 0, err: window.__yard.launchError }));
  // Any backend may answer: the browser simulator once sandbox-data carries Rev C (#187),
  // else the grid, else the as-built replays (#190). It must answer with voyages, not an error.
  if (rl.err || !rl.backend || rl.n < 1) fail(`boatyard Rev C launch: ${JSON.stringify(rl)}`);
  await page.evaluate(() => window.__yard.setBase("kayak"));
  if ((await page.evaluate(() => window.__yard.share)) !== "") fail("boatyard: switching back to the kayak should give the planned build");
  log.push(`boatyard Rev C base, ${rl.n} as-built voyages`);
  // Cinematic mode: the panels fade, the camera cuts between shots of what is
  // happening now (it never moves the voyage clock), and any key ends it.
  await page.goto(`${URL}voyage.html?voyage=2020-04-15&quality=low`);
  await page.waitForFunction(() => window.__replay?.ready && window.__replay.frames > 2, null, { timeout: 60000 });
  await page.evaluate(() => { window.__replay.pause(); window.__replay.setHour(150); });
  await page.click("#cinebtn");
  await page.waitForFunction(() => window.__replay.cine.on && getComputedStyle(document.getElementById("credits")).opacity === "0", null, { timeout: 30000 })
    .catch(() => fail("cinematic: the panels and credits didn't fade"));
  const shots = [];
  for (const k of ["skim", "sunset", "drone"]) {
    await page.evaluate((k) => window.__replay.cine.cut(k), k);
    const f = await page.evaluate(() => window.__replay.frames);
    await page.waitForFunction((n) => window.__replay.frames > n + 3, f, { timeout: 30000 });
    shots.push(await page.evaluate(() => `${window.__replay.cine.current}@${window.__replay.hour.toFixed(1)}`));
  }
  if (shots.some((s) => Math.abs(Number(s.split("@")[1]) - 150) > 0.5)) fail(`cinematic: the voyage clock jumped (${shots})`);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !window.__replay.cine.on && getComputedStyle(document.getElementById("top")).opacity === "1", null, { timeout: 30000 })
    .catch(() => fail("cinematic: a key didn't bring the panels back"));
  const back = await page.evaluate(() => ({ hour: window.__replay.hour, sound: document.getElementById("soundbtn").textContent }));
  if (Math.abs(back.hour - 150) > 0.5) fail(`cinematic: the replay hour moved (${back.hour})`);
  if (errors.length) fail(`page errors in cinematic mode: ${errors.join("; ")}`);
  log.push(`cinematic: ${shots.join(", ")}, ${back.sound}`);

  // Off Pico: real land when the land files are there (the Pages build fetches them), sea only otherwise.
  await page.goto(`${URL}voyage.html?voyage=2020-04-15&place=pico&quality=low`);
  await page.waitForFunction(() => window.__replay?.ready && window.__replay.frames > 2 && window.__replay.land !== undefined, null, { timeout: 120000 })
    .catch(async () => fail(`Pico didn't load: ${await page.evaluate(() => window.__replay?.error)}`));
  const pico = await page.evaluate(() => ({ land: window.__replay.land, surf: window.__replay.surf, credit: /Sentinel/.test(document.getElementById("credits").textContent) }));
  if (!pico.credit) fail("Pico: no Sentinel credit on the page");
  if (pico.land && !(pico.surf > 1000)) fail(`Pico: land but no surf (${pico.surf})`);
  if (errors.length) fail(`page errors off Pico: ${errors.join("; ")}`);
  log.push(pico.land ? `Pico: land, ${pico.surf} surf triangles` : "Pico: no land files, sea only");

  // A stock boat: the cruiser's voyage, when the replays have one. It leans by the
  // replay's heel, and its sails follow the logged sail plan and the wind.
  const cruiser = await page.evaluate(async () => {
    const idx = await (await fetch("./voyages/index.json")).json();
    return idx.voyages.find((v) => /cruiser/i.test(v.boat))?.file ?? null;
  });
  if (cruiser) {
    await page.goto(`${URL}voyage.html?voyage=${cruiser}&quality=low`);
    await page.waitForFunction(() => window.__replay?.ready && window.__replay.frames > 2 && window.__replay.rig, null, { timeout: 120000 })
      .catch(async () => fail(`stock cruiser didn't load: ${await page.evaluate(() => window.__replay?.error)}`));
    await page.evaluate(() => window.__replay.setHour(30));
    await page.waitForTimeout(3000);
    const st = await page.evaluate(() => ({ boats: window.__replay.boats, rig: window.__replay.rig, menu: [...document.getElementById("boat").options].map((o) => o.value) }));
    if (!/cruiser/i.test(st.boats.join())) fail(`stock cruiser: the page shows ${st.boats}`);
    if (!st.menu.includes("stock_cruiser31")) fail("stock cruiser: not in the boat menu");
    if (typeof st.rig.plan !== "string" || !Number.isFinite(st.rig.heel)) fail(`stock cruiser: no rig (${JSON.stringify(st.rig)})`);
    if (st.rig.plan === "down" ? st.rig.main !== 0 : !(st.rig.main > 0)) fail(`stock cruiser: sails don't match the plan (${JSON.stringify(st.rig)})`);
    if (errors.length) fail(`page errors with the stock cruiser: ${errors.join("; ")}`);
    log.push(`stock cruiser: ${st.rig.plan}, heel ${st.rig.heel.toFixed(1)}`);
  } else log.push("stock cruiser: no replay yet");

  // Take the helm: the page draws; with the simulator files it sails 6 hours, without them it says so.
  await page.goto(`${URL}helm.html?quality=low`);
  await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 60000 });
  // Ports to start from (public/ports.json): the picker lists the ports west of the start line (24 in Nov 2026).
  await page.waitForFunction(() => window.__helm.ports >= 20 && !document.querySelector("#portpick").hidden, null, { timeout: 30000 })
    .catch(async () => fail(`no port picker: ${await page.evaluate(() => window.__helm.ports)} ports`));
  if (!(await page.locator('#port option[value="baltimore"]').count())) fail("port picker has no Baltimore");
  log.push(`helm ports: ${await page.evaluate(() => window.__helm.ports)}`);
  // 1 May 2020: in the planning runs both boats lose the same part on day 3.9 (#196),
  // so a whole game fits in the smoke test.
  await page.selectOption("#launch", "2");
  await page.click("#go");
  await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 240000 });
  const hm = await page.evaluate(() => ({ ready: window.__helm.ready, err: window.__helm.error, msg: document.querySelector("#startmsg").textContent }));
  if (hm.ready) {
    await page.click("#s6");
    await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 240000 });
    // "Sail 6 hours" sails 6 hours unless something stops the clock first (a player
    // hits the same stops): then it must be a known reason, before hour 6.
    const six = await page.evaluate(() => ({ day: window.__helm.status?.day, stop: window.__helm.lastStop, err: window.__helm.error }));
    const sixOk = six.stop === "time" ? Math.abs(six.day - 0.25) < 0.01 : ["battery", "wind", "land", "ghost_passed", "passed_ghost", "over", "order_arrived"].includes(six.stop) && six.day < 0.25;
    if (!sixOk || six.err) fail(`helm: "sail 6 hours" stopped at day ${six.day} (${six.stop}${six.err ? `, ${six.err}` : ""})`);
    const local = await page.evaluate(() => document.getElementById("local").textContent);
    if (!/ local \(UTC/.test(local)) fail(`helm: no local time (${local})`);
    // Ravi's gates in the page: the ghost never ahead of the player's clock, every
    // stop a known reason, and the game ends in a results card that follows the draw rule.
    const STOPS = ["time", "battery", "wind", "land", "breakdown", "ghost_passed", "passed_ghost", "over", "order_arrived"];
    const ahead = (s) => s && s.ghost.t > s.boat.t; // ISO minutes, same zone: string order is time order
    let st = await page.evaluate(() => ({ s: window.__helm.status, stop: window.__helm.lastStop }));
    if (ahead(st.s) || !Number.isFinite(st.s.lead_km)) fail(`helm after 6 h: ${JSON.stringify(st)}`);
    let hops = 0;
    for (; hops < 40 && !(await page.evaluate(() => window.__helm.card)); hops++) {
      await page.click("#sevent");
      await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 240000 });
      st = await page.evaluate(() => ({ s: window.__helm.status, stop: window.__helm.lastStop, err: window.__helm.error }));
      if (st.err) fail(`helm hop ${hops}: ${st.err}`);
      if (!STOPS.includes(st.stop)) fail(`helm hop ${hops}: unknown stop ${JSON.stringify(st.stop)}`);
      if (ahead(st.s)) fail(`helm hop ${hops}: the ghost is ahead of the player's clock (${st.s.ghost.t} > ${st.s.boat.t})`);
      if (st.stop === "over") await page.waitForFunction(() => window.__helm.card || window.__helm.error, null, { timeout: 240000 });
    }
    const card = await page.evaluate(() => window.__helm.card);
    if (!card) fail(`helm: no results card after ${hops} hops of "until something happens"`);
    if (!["won", "lost", "draw", "neither_finished"].includes(card.verdict)) fail(`helm card verdict ${card.verdict}`);
    const both = card.boat.outcome === "arrived" && card.ghost.outcome === "arrived";
    if (both !== (card.margin_days !== null)) fail(`helm card: margin ${card.margin_days} with outcomes ${card.boat.outcome}/${card.ghost.outcome}`);
    if (both && (Math.abs(card.margin_days) < 1) !== (card.verdict === "draw")) fail(`helm card: draw rule broken (${card.margin_days} d, ${card.verdict})`);
    if (await page.locator("#result").isHidden()) fail("helm: the results card isn't shown");
    await page.screenshot({ path: "test-output/helm-result.png" });
    log.push(`helm sailed to day ${six.day.toFixed(2)} (${six.stop}), ${local}, then ${hops} hops to the card (${card.verdict}: ${card.boat.outcome} day ${card.boat.days.toFixed(1)}, ghost ${card.ghost.outcome} day ${card.ghost.days.toFixed(1)})`);
  } else {
    if (!["no simulator files", "no helm in the simulator"].includes(hm.err) || !/published/.test(hm.msg)) fail(`helm start: ${JSON.stringify(hm)}`);
    log.push("helm: no simulator files, says so");
  }
  // Weather challenges start live: with the challenge files
  // published, pick the first one with its own weather bundle from the picker and
  // sail 6 hours on it. Without the files the picker stays hidden, and that's fine.
  await page.goto(`${URL}helm.html?quality=low`);
  await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 60000 });
  const chFile = await page.evaluate(async () => {
    try {
      const r = await fetch("./challenges/challenges.json");
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return null;
      return (await r.json()).challenges.find((c) => !c.season) ?? null;
    } catch {
      return null;
    }
  });
  const chPicker = await page.evaluate(() => !document.getElementById("chpick").hidden);
  if (!chFile) {
    if (chPicker) fail("helm: a challenge picker without challenges.json");
    log.push("helm challenges: no challenge files, picker hidden");
  } else if (!hm.ready) {
    log.push(`helm challenges: files there but no simulator (${hm.err})`);
  } else {
    if (!chPicker) fail("helm: challenges.json is published but the picker is hidden");
    await page.selectOption("#challenge", chFile.id);
    await page.click("#go");
    await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 240000 });
    let ch = await page.evaluate(() => ({ ready: window.__helm.ready, err: window.__helm.error, id: window.__helm.challenge, msg: document.querySelector("#startmsg").textContent }));
    // Published challenge files with a simulator that can't sail them is a live bug: the picker offers a game that won't start.
    if (!ch.ready || ch.err || ch.id !== chFile.id) fail(`helm challenge ${chFile.id} didn't start: ${JSON.stringify(ch)}`);
    else {
      await page.click("#s6");
      await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 240000 });
      const s = await page.evaluate(() => ({ st: window.__helm.status, stop: window.__helm.lastStop, err: window.__helm.error }));
      const known = ["time", "battery", "wind", "land", "breakdown", "ghost_passed", "passed_ghost", "over", "order_arrived"];
      if (s.err || !known.includes(s.stop) || !(s.st.day > 0 && s.st.day <= 0.25 + 1e-6)) fail(`helm challenge ${chFile.id}: 6 hours went wrong: ${JSON.stringify({ day: s.st?.day, stop: s.stop, err: s.err })}`);
      // Its own weather, not 2020's: the boat's clock is on the challenge's start day.
      if (s.st.boat.t.slice(0, 10) !== chFile.start.slice(0, 10)) fail(`helm challenge ${chFile.id}: boat clock ${s.st.boat.t}, challenge starts ${chFile.start}`);
      log.push(`helm challenge ${chFile.id}: started ${s.st.boat.t}, sailed to day ${s.st.day.toFixed(2)} (${s.stop})`);
    }
  }
  // Design leaderboard: the published board if there is one, else it says so; the
  // sample board (public/leaderboard-sample, labelled as such) draws tiers and verdicts.
  await page.goto(`${URL}leaderboard.html`);
  await page.waitForFunction(() => window.__leaderboard?.ready, null, { timeout: 30000 });
  const lb0 = await page.evaluate(() => ({ ...window.__leaderboard, banner: document.querySelector("#banner").textContent }));
  if (lb0.error ? lb0.error !== "NO_BOARD" || !/No board published yet/.test(lb0.banner) : lb0.rows < 2 || lb0.sample) fail(`leaderboard: ${JSON.stringify(lb0)}`);
  await page.goto(`${URL}leaderboard.html?board=leaderboard-sample/board.json`);
  await page.waitForFunction(() => window.__leaderboard?.ready, null, { timeout: 30000 });
  const lb = await page.evaluate(() => ({
    ...window.__leaderboard,
    banner: document.querySelector("#banner").textContent,
    tiers: [...document.querySelectorAll("#rows tr")].map((r) => Number(r.dataset.tier)),
    ref: document.querySelectorAll("#rows tr.ref").length,
    model: [...document.querySelectorAll(".chip.model")].map((c) => c.textContent),
  }));
  const sorted = lb.tiers.every((t, i) => i === 0 || t >= lb.tiers[i - 1]);
  if (lb.error || lb.rows < 2 || !lb.sample || !/not results/.test(lb.banner) || !sorted || lb.ref !== 1 || !lb.model.some((t) => /^our model of Randolph/.test(t)))
    fail(`leaderboard sample: ${JSON.stringify(lb)}`);
  await page.screenshot({ path: "test-output/leaderboard.png", fullPage: true });
  log.push(`leaderboard ${lb0.error ? "not published yet" : `${lb0.rows} designs`}, sample ${lb.rows} rows in ${Math.max(...lb.tiers)} tiers`);
  // Race view: with the simulator files it races our kayak against Rev C for a
  // day from the same launch; without them (or with an older simulator) it says so.
  await page.goto(`${URL}race.html`);
  await page.selectOption("#launch", "4");
  await page.click("#go");
  await page.waitForFunction(() => window.__race && (window.__race.ready || window.__race.error), null, { timeout: 240000 });
  const rc0 = await page.evaluate(() => ({ ready: window.__race.ready, err: window.__race.error, msg: document.querySelector("#msg").textContent }));
  if (rc0.ready) {
    await page.click("#day");
    await page.waitForFunction(() => !window.__race.busy, null, { timeout: 240000 });
    const r = await page.evaluate(() => ({ s: window.__race.status, stops: window.__race.stops, err: window.__race.error, tracks: window.__race.tracks.map((t) => t.length) }));
    const names = r.s?.boats.map((b) => b.name) ?? [];
    if (r.err || Math.abs(r.s.day - 1) > 0.01 || r.stops.join() !== "time" || !Number.isFinite(r.s.lead_km) || r.s.boats[0].t !== r.s.boats[1].t
      || names[0] !== "Our kayak" || !/Rev C \(our model\)/.test(names[1]) || r.tracks.some((n) => n < 1))
      fail(`race after a day: ${JSON.stringify({ ...r, s: { day: r.s?.day, lead: r.s?.lead_km, names } })}`);
    await page.screenshot({ path: "test-output/race.png", fullPage: true });
    log.push(`race: ${names.join(" vs ")} sailed a day in step, lead ${r.s.lead_km.toFixed(0)} km`);
  } else {
    // No files: the page checks before loading Python (a preview server answers the
    // missing zip with HTML, which Pyodide would choke on). An old simulator: NO_RACE.
    if (!(rc0.err === "no simulator files" && /aren't published/.test(rc0.msg)) && !/older than the race view/.test(rc0.msg)) fail(`race start: ${JSON.stringify(rc0)}`);
    log.push("race: no simulator files, says so");
  }
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);

  await browser.close();
  console.log(`OK: ${log.join(", ")}; both boats afloat; sea vertices high ${vHigh}, low ${vLow}`);
} catch (e) {
  fail(String(e));
}
server.kill();
