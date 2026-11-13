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

/** Set one of the Set sail card's hidden source selects (#launch, #challenge), as its pills do. */
async function pickSource(page, id, value) {
  await page.evaluate(([i, v]) => {
    const s = document.getElementById(i);
    s.value = v;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  }, [id, value]);
}

const URL = "http://localhost:4173/";
// Run vite directly (not via npx) so server.kill() stops the server itself.
const server = spawn("node_modules/.bin/vite", ["preview", "--port", "4173", "--strictPort"], { stdio: "inherit" });
const fail = (msg) => { console.error("FAIL:", msg); server.kill(); process.exit(1); };
/** The helm's orders drawer (Leo's layout plan): open it before using what's inside. Builds without one: nothing to do. */
async function openOrders(page) {
  if (!(await page.locator("#orders-tab").count())) return;
  // At the start the drawer opens by itself for 10 s with a tip, then slides shut unless it's
  // in use; on slow software graphics the slide takes seconds. So: open it if it's shut, wait
  // until it has fully slid in, then point at it, which keeps it open (the player is using it).
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator("#orders.open").count())) await page.click("#orders-tab", { timeout: 15_000 }).catch(() => {});
    const there = await page
      .waitForFunction(() => { const o = document.getElementById("orders"); return o.classList.contains("open") && o.getBoundingClientRect().x >= 0; }, null, { timeout: 20_000 })
      .then(() => true, () => false);
    if (!there) continue;
    await page.hover("#orders h2", { timeout: 10_000 }).catch(() => {});
    if (await page.locator("#orders.open").count()) return;
  }
}
/** Watch a voyage's replay drawer (it slides shut after 10 s of play): open it and wait until it's in place. Old builds: nothing. */
async function openReplay(page) {
  if (!(await page.locator("#replay-tab").count())) return;
  // Pin first, then open, in one go in the page (replay/hud.ts): the after-play timer can fire
  // between a check that the drawer is open and a later pin, which shut it under the next click on
  // slow runners (#419's log: drawer at x -340, no "open", straight after this returned). A
  // pointerenter pins it and clears the timer; the tab's own click pins and opens it.
  await page.evaluate(() => {
    document.getElementById("top")?.dispatchEvent(new PointerEvent("pointerenter"));
    if (!document.getElementById("top")?.classList.contains("open")) document.getElementById("replay-tab")?.click();
  });
  await page.waitForFunction(() => { const o = document.getElementById("top"); return o.classList.contains("open") && o.getBoundingClientRect().x >= 0; }, null, { timeout: 20000 });
}
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
  // A screenshot that times out says which one it was (a bare "page.screenshot: Timeout" left
  // #426's smoke (2) unplaceable).
  const snap = (opts) => page.screenshot(opts).catch((e) => fail(`screenshot ${opts.path}: ${e.message.split("\n")[0]}`));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // SMOKE_PART=1 or 2 runs one half on its own runner (the pre-release gate runs
  // both halves side by side; Kai, 11 Nov: 18 min in one job was the gate's
  // critical path). Unset runs everything, as before. Part 1: the sea, voyage
  // replays, race replay, launch-day game, points of interest, weather looks, the
  // live tracker, cinematic mode, land, the stock cruiser, helm near land, ships
  // and storm looks. Part 2: the Boatyard, the helm start panel and games,
  // challenges, the leaderboard and the race page (the Pyodide simulator runs).
  const PART = process.env.SMOKE_PART ?? "all";
  if (!["all", "1", "2"].includes(PART)) fail(`SMOKE_PART must be 1 or 2, got ${PART}`);
  const runA = PART !== "2";
  const runB = PART !== "1";
  const t0 = Date.now();
  const log = [];
  let vLow;
  let vHigh;
  mkdirSync("test-output", { recursive: true });
  if (runA) {
    // Low quality throughout: CI draws with software graphics at about one frame a
    // second, and the frame-count waits below need headroom. High is checked once.
    await page.goto(`${URL}?quality=low`);
    await page.waitForFunction(() => (window.__sea3d?.frames ?? 0) > 10, null, { timeout: 30000 });

    // Title screen and shared top bar (one-game plan, step 2): the menu shows over the
    // sea, every menu link is a page, and "Just watch the sea" brings the sea panel back.
    const ts = await page.evaluate(() => ({
      title: !document.getElementById("title").hidden,
      panel: getComputedStyle(document.getElementById("panel")).display,
      bar: [...document.querySelectorAll("#topbar a.nav")].map((a) => a.getAttribute("href")),
      barH: document.getElementById("topbar")?.getBoundingClientRect().height,
      barShown: [...document.querySelectorAll("#topbar a.nav, #topbar .more")].filter((a) => a.offsetParent).length,
      more: [...document.querySelectorAll("#topbar .more .menu a")].map((a) => a.textContent),
      setsail: document.getElementById("t-setsail").classList.contains("main"),
      chip: document.getElementById("topbar-boat")?.textContent,
    }));
    // One-game step 1: Set sail, Boatyard, Practice in the bar, the rest under More; on the title the bar is bare (Elena).
    if (!ts.title || ts.panel !== "none" || ts.bar.join() !== "./helm.html,./boatyard.html,./helm.html?practice" || ts.barShown !== 0 || ts.more.join() !== "Watch a voyage,Race it,Leaderboard,Credits" || ts.barH !== 40 || !ts.setsail)
      fail(`title screen: ${JSON.stringify(ts)}`);
    // The chip opens the boat picker; picking the Pearson makes it my boat, and Our kayak puts it back.
    await page.click("#topbar-boat");
    await page.waitForFunction(() => window.__boatpick?.open, null, { timeout: 15000 });
    await page.check('#boatpick input[value="stock_pearson31_2"]');
    await page.click("#boatpick .go");
    const picked = await page.evaluate(() => ({ chip: document.getElementById("topbar-boat").textContent, title: document.getElementById("t-boatname").textContent, open: window.__boatpick.open }));
    if (picked.open || picked.chip !== "My boat: Pearson 31-2 (our model)" || picked.title !== "Pearson 31-2 (our model)") fail(`boat picker: ${JSON.stringify(picked)}`);
    await page.click("#t-change");
    await page.check('#boatpick input[value="kayak"]');
    await page.click("#boatpick .go");
    // No boat saved yet: you sail Our kayak, so the chip says so, the Boatyard included (audit A3).
    if (ts.chip !== "My boat: Our kayak") fail(`top bar boat chip with no boat saved: "${ts.chip}"`);
    await page.click("#t-more summary"); // "Just watch the sea" lives under More (Elena)
    await page.click("#t-sea");
    const tsea = await page.evaluate(() => ({ title: !document.getElementById("title").hidden, panelTop: document.getElementById("panel").getBoundingClientRect().top }));
    if (tsea.title || tsea.panelTop < 40) fail(`"Just watch the sea" should swap the menu for the sea panel, below the bar: ${JSON.stringify(tsea)}`);

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
      const png = await snap({ path: `test-output/sea-${sea}.png` });
      // A blank canvas compresses to almost nothing; a rendered sea doesn't.
      if (png.length < 20000) fail(`${sea} screenshot looks blank (${png.length} bytes)`);
      log.push(`${sea} Hs ${s.hs} m`);
    }

    // Quality switch rebuilds the sea mesh with a different resolution.
    vLow = await page.evaluate(() => window.__sea3d.seaVertices);
    await page.selectOption("#quality", "high");
    await page.waitForTimeout(500);
    vHigh = await page.evaluate(() => window.__sea3d.seaVertices);
    if (!(vLow > 0 && vLow < vHigh)) fail(`low quality should use fewer sea vertices (high ${vHigh}, low ${vLow})`);
    const pngHigh = await snap({ path: "test-output/sea-gale-high.png" });
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
      const pngV = await snap({ path: `test-output/voyage-${v.file.replace(".json", "")}.png` });
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
    // Hold the race near its start first: on a slow runner the real Randolph race (PR builds carry it;
    // local runs use the short fixture) can reach its end card during the checks above, and the
    // end card shuts the replay drawer whatever the pin (showOutcome, #422), so the close-up click
    // missed with "outside of the viewport" (Maya, Lena).
    await page.evaluate(() => { window.__replay.pause(); window.__replay.setHour(1); });
    await page.waitForFunction(() => !document.querySelector("#outcome.show"), null, { timeout: 10000 });
    await openReplay(page); // the close-up buttons live in the replay drawer
    await page.click('#focus button[data-lane="1"]');
    await page.waitForTimeout(800);
    if ((await page.evaluate(() => window.__replay.focus)) !== 1) fail("close-up didn't switch to the Randolph boat");
    // Its moving parts: wing, wind vane, rudder, comms light; no propellers.
    const gR = (await page.evaluate(() => window.__replay.gear)).parts ?? {};
    if (gR.props !== 0 || !gR.wing || !gR.vane || !gR.rudder || !gR.light) fail(`Randolph gear missing: ${JSON.stringify(gR)}`);
    await snap({ path: "test-output/voyage-race-randolph.png" });
    await page.evaluate(() => { window.__replay.pause(); window.__replay.setHour(window.__replay.maxHour); });
    await page.waitForSelector("#outcome.show", { timeout: 10000 });
    const pngR = await snap({ path: "test-output/voyage-race-end.png" });
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
    // no "simulated" label even on the demo feed (John's call S2), "now" at the latest report,
    // and the forecast look past it.
    await page.goto(`${URL}voyage.html?live&feed=feed-sample/&quality=low`);
    await page.waitForFunction(() => window.__replay?.ready && window.__replay.frames > 2, null, { timeout: 60000 })
      .catch(async () => fail(`live tracker didn't load: ${await page.evaluate(() => window.__replay?.error)}`));
    const lv = await page.evaluate(() => ({ ...window.__replay.live, hour: window.__replay.hour, label: /simulated voyage/.test(document.getElementById("h1").textContent), local: document.getElementById("w-local").textContent }));
    if (!lv.simulated || lv.label || lv.banner) fail(`live tracker: demo feed must load with no "simulated" label (S2): ${JSON.stringify(lv)}`);
    if (!/^\d+:\d\d(:\d\d)? [AP]M local \(UTC/.test(lv.local)) fail(`no local time under the clock: ${JSON.stringify(lv)}`);
    if (Math.abs(lv.hour - lv.now) > 0.01 || lv.now < lv.lastFix || lv.fixes < 50) fail(`live tracker not at now: ${JSON.stringify(lv)}`);
    await page.evaluate((h) => window.__replay.setHour(h), lv.now + 24 * 5);
    await page.waitForFunction(() => window.__replay.live.forecast === true, null, { timeout: 30000 }).catch(() => fail("no forecast look past now"));
    await page.evaluate(() => window.__replay.goNow());
    await page.waitForFunction(() => window.__replay.live.forecast === false, null, { timeout: 30000 }).catch(() => fail("Now didn't come back from the forecast"));
    if (errors.length) fail(`page errors in the live tracker: ${errors.join("; ")}`);
    log.push(`live tracker: ${lv.fixes} fixes, now day ${(lv.now / 24).toFixed(1)}, labelled, ${lv.local}`);
  }

  if (runB) {
    // Boatyard: the catalog loads, a swap changes the totals, the model and the share link.
    await page.goto(`${URL}boatyard.html?quality=low`);
    await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 2, null, { timeout: 60000 });
    const y0 = await page.evaluate(() => window.__yard.summary);
    // Slots are one line each until opened (M5): open, then pick.
    await page.locator('.sl-head[data-slot="thr"]').click();
    await page.locator('.opt[data-slot="thr"][data-opt="one-t200"]').click();
    await page.locator('.slot[data-group="Power"] h3').click(); // sections fold too; Driving starts open
    await page.locator('.sl-head[data-slot="bat"]').click();
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
    // My boat: save this design under a name, and the Boatyard remembers it and links back to it.
    await page.fill("#mb-name", "Test <b>boat</b>");
    await page.click("#mb-save");
    const mb = await page.evaluate(() => ({ stored: JSON.parse(localStorage.getItem("boatsim.myboat.v1") || "null"), btn: document.getElementById("mb-save").textContent }));
    if (mb.stored?.hash !== y1.share || mb.stored?.name !== "Test <b>boat</b>" || mb.stored?.choices?.thr !== "one-t200" || mb.btn !== "Saved")
      fail(`boatyard: saving my boat: ${JSON.stringify(mb)}`);
    await page.goto(`${URL}boatyard.html?quality=low&mine=1`);
    // Ready, and the Blender boats in: their rebuild and first draw is one long frame on the
    // runner's software graphics, and the hash step below waited behind it (deploy 43174294873).
    await page.waitForFunction(() => window.__yard?.ready && window.__yard.models !== "loading" && window.__yard.frames > 2, null, { timeout: 60000 });
    const mb2 = await page.evaluate(() => ({ line: document.getElementById("mb-line").textContent, href: document.querySelector("#mb-line a")?.getAttribute("href"), tags: document.querySelectorAll("#mb-line b").length }));
    if (!mb2.line.includes("Test <b>boat</b>") || mb2.href !== `boatyard.html${y1.share}` || mb2.tags) fail(`boatyard: my boat line: ${JSON.stringify(mb2)}`);
    // On the live site the link only changes the hash (no query), and the page opens the design in place.
    const tHash = Date.now();
    await page.evaluate((h) => (location.hash = h), y1.share);
    await page.waitForFunction(() => window.__yard.design.picks.thr === "one-t200" && document.getElementById("mb-save").textContent === "Saved", null, { timeout: 30000 }).catch(async () =>
      fail(`boatyard: the my-boat link didn't reopen it: ${JSON.stringify(await page.evaluate(() => ({ thr: window.__yard.design.picks.thr, btn: document.getElementById("mb-save").textContent, models: window.__yard.models, frames: window.__yard.frames })))}`),
    );
    log.push(`boatyard my-boat link reopened in ${Date.now() - tHash} ms (${await page.evaluate(() => window.__yard.models)} models)`);
    await page.evaluate(() => localStorage.removeItem("boatsim.myboat.v1"));
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
    // No money in the game (John, 12 Nov): no price, cost or $ anywhere on the page, and
    // the choices that only ever changed the price are gone.
    const greyed = await page.evaluate(() => ({
      noeff: document.querySelectorAll(".opt.noeff").length,
      shape: !!document.querySelector('.opt[data-slot="shape"]'),
      money: (document.getElementById("parts").innerText + " " + document.getElementById("sum").innerText).match(/\$\d|\bprices?\b|\bcosts?\b|\bcheaper\b|price TBD|PRICE ONLY|\bROUGH\b/i)?.[0] ?? "",
      dead: document.querySelectorAll('.opt[data-slot="spares"], .opt[data-opt="lead-50-scrap"], .opt[data-slot="radar"]').length,
    }));
    if (!greyed.shape || greyed.noeff || greyed.money || greyed.dead) fail(`boatyard: money on screen, or price-only choices still shown: ${JSON.stringify(greyed)}`);
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
    log.push(`boatyard ${y1.share}, no money on screen, launch via ${how.backend}`);
    // Start from the Randolph boat: its own slots and totals, the model dressing to the picks, a share link with the base.
    await page.goto(`${URL}boatyard.html?quality=low&base-test=1#base=revc&rudder=single`); // a new query: a hash-only change would not reload
    await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 2, null, { timeout: 60000 });
    const rc = await page.evaluate(() => ({ base: window.__yard.base, s: window.__yard.summary, d: window.__yard.dressed, share: window.__yard.share }));
    if (rc.base !== "revc" || rc.s.solarW !== 40 || rc.s.batteryWh !== 192 || rc.s.thrusters !== 0 || Math.abs(rc.s.massKg - 26.55) > 0.01) // Rev C3 26.9 kg, less 0.35 for one rudder
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
  }

  if (runA) {
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
    await page.waitForFunction(() => !window.__replay.cine.on && getComputedStyle(document.getElementById("strip") ?? document.getElementById("top")).opacity === "1", null, { timeout: 30000 })
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

    // Annapolis: the town stands on the land, and its waterfront lights reach the water.
    await page.goto(`${URL}voyage.html?voyage=2020-04-15&place=annapolis&quality=low`);
    await page.waitForFunction(() => window.__replay?.ready && window.__replay.frames > 2 && window.__replay.land !== undefined, null, { timeout: 120000 })
      .catch(async () => fail(`Annapolis didn't load: ${await page.evaluate(() => window.__replay?.error)}`));
    const ann = await page.evaluate(() => ({ land: window.__replay.land, town: window.__replay.town, trees: window.__replay.trees, mirror: window.__replay.mirror, credit: /ODbL/.test(document.getElementById("credits").textContent) }));
    // The page reports how strongly the sea mirrors the town and the boat (mirror.ts).
    if (!(ann.mirror >= 0 && ann.mirror <= 1)) fail(`Annapolis: no mirror strength (${ann.mirror})`);
    if (!ann.credit) fail("Annapolis: no ODbL credit on the page");
    if (ann.town && !(ann.town.buildings > 1000 && ann.town.lights > 100 && ann.town.moorings > 10)) fail(`Annapolis: a thin town ${JSON.stringify(ann.town)}`);
    if (errors.length) fail(`page errors off Annapolis: ${errors.join("; ")}`);
    log.push(
      ann.town ? `Annapolis: ${ann.town.buildings} buildings, ${ann.town.lights} lights on the water, ${ann.town.moorings} moorings, ${ann.trees} trees, mirror ${ann.mirror.toFixed(2)}, land ${ann.land}` : "Annapolis: no town files",
    );

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

    // Take the helm near land: off Cascais, the Lisbon coast loads and the view reaches out to it.
    await page.goto(`${URL}helm.html?quality=low&spot=38.668,-9.42`);
    await page.waitForFunction(() => window.__helm && window.__helm.frames > 2 && window.__helm.landKnown >= 0, null, { timeout: 60000 });
    // Lisbon's own files, not "any land": a local copy can have other places (or the Bay's squares) without Lisbon's.
    const lisbonFiles = await page.evaluate(async () => {
      const r = await fetch("land/lisbon_meta.json").catch(() => null);
      return !!r && r.ok && !(r.headers.get("content-type") ?? "").includes("text/html");
    });
    if (lisbonFiles) {
      await page.waitForFunction(() => window.__helm.land.place === "lisbon" && window.__helm.reach > 50000, null, { timeout: 120000 })
        .catch(async () => fail(`helm: no Lisbon land off Cascais (${await page.evaluate(() => JSON.stringify({ land: window.__helm.land, reach: window.__helm.reach }))})`));
      if (!(await page.evaluate(() => /Sentinel/.test(document.getElementById("landcredit").textContent)))) fail("helm: no land credit off Cascais");
      if (errors.length) fail(`page errors at the helm off Cascais: ${errors.join("; ")}`);
      log.push(`helm near land: ${await page.evaluate(() => JSON.stringify(window.__helm.land))}`);
    } else log.push("helm near land: no land files");
    // Other ships, from the traffic map: plenty in the English Channel, and no page errors.
    await page.goto(`${URL}helm.html?quality=low&spot=50.0,-2.0`);
    await page.waitForFunction(() => window.__helm && window.__helm.frames > 2 && window.__helm.ships.ships > 0, null, { timeout: 60000 })
      .catch(async () => fail(`helm: no ships in the English Channel (${await page.evaluate(() => JSON.stringify(window.__helm?.ships))})`));
    if (errors.length) fail(`page errors among the Channel traffic: ${errors.join("; ")}`);
    log.push(`ships in the Channel: ${await page.evaluate(() => JSON.stringify(window.__helm.ships.kinds))}`);
    // Off Annapolis: Thomas Point Light stands on its shoal (the model, or its drawn stand-in), no page errors.
    await page.goto(`${URL}helm.html?quality=low&spot=38.91,-76.45`);
    await page.waitForFunction(() => window.__helm && window.__helm.frames > 2 && window.__helm.land.landmarks > 0, null, { timeout: 60000 })
      .catch(async () => fail(`helm: no Thomas Point Light off Annapolis (${await page.evaluate(() => JSON.stringify(window.__helm?.land))})`));
    if (errors.length) fail(`page errors by Thomas Point Light: ${errors.join("; ")}`);
    // A storm force wind (forced for the looks): spindrift flies, the view closes in, nothing breaks.
    await page.goto(`${URL}voyage.html?voyage=2020-04-15&quality=low`);
    await page.waitForFunction(() => window.__replay?.ready && window.__replay.frames > 2, null, { timeout: 120000 });
    await page.evaluate(() => (window.__replay.force.wind = 30)); // force 11
    await page.waitForTimeout(3000);
    const gale = await page.evaluate(() => ({ spray: window.__replay.spindrift, bands: window.__replay.bands, frames: window.__replay.frames }));
    const stars = await page.evaluate(() => window.__replay.stars);
    if (!(stars > 9000)) fail(`night sky: ${stars} catalogue stars (stars.bin not loaded?)`);
    if (!(gale.spray > 0.9)) fail(`storm: no spindrift in force 11 (${JSON.stringify(gale)})`);
    if (!Number.isFinite(gale.bands)) fail(`storm: no rain-band count (${JSON.stringify(gale)})`);
    if (errors.length) fail(`page errors in a storm: ${errors.join("; ")}`);
    log.push(`storm: spindrift ${gale.spray.toFixed(2)}, ${gale.bands} rain bands in view`);
  }

  if (runB) {
    // The start panel fits every window: on a short laptop screen and on a phone either
    // way up, "Take the helm" can be scrolled to and clicked (a trial click: Playwright's
    // own checks that the button is visible, in the window and not covered).
    for (const [w, h] of [[960, 540], [390, 844], [844, 390]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${URL}helm.html?quality=low`);
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 0, null, { timeout: 60000 });
      await page.click("#go", { trial: true, timeout: 15000 }).catch(() => fail(`helm at ${w}x${h}: "Take the helm" can't be clicked`));
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    log.push("helm start panel reachable at 960x540, 390x844, 844x390");

    // Take the helm: the page draws; with the simulator files it sails 6 hours, without them it says so.
    // clock=paused: time waits for the skip buttons, so the hops below are exact.
    await page.goto(`${URL}helm.html?quality=low&clock=paused`);
    await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 60000 });
    // Before Set sail only the start card shows (Nina's review): the game's panels wait.
    const pre = await page.evaluate(() => ["status", "orders", "mapbox", "fcbox"].map((id) => getComputedStyle(document.getElementById(id)).visibility));
    if (pre.some((v) => v !== "hidden") || (await page.isVisible("#timebar"))) fail(`helm: game controls show before Set sail: ${pre}`);
    if ((await page.textContent("#go")).trim() !== "Set sail") fail(`helm: the start button says "${await page.textContent("#go")}"`);
    // The boat picker: our kayak and the stock boats cleared for play (the game below sails the kayak).
    const picks = await page.evaluate(() => Array.from(document.querySelectorAll('input[name="boat"]')).map((r) => r.value));
    if (picks.join() !== ",stock_cruiser31,stock_pearson31_2") fail(`helm: boat picker offers ${JSON.stringify(picks)}`);
    // Ports to start from (public/ports.json): the picker lists the ports west of the start line (24 in Nov 2026).
    await page.waitForFunction(() => window.__helm.ports >= 20 && !document.querySelector("#portpick").hidden, null, { timeout: 30000 })
      .catch(async () => fail(`no port picker: ${await page.evaluate(() => window.__helm.ports)} ports`));
    if (!(await page.locator('#port option[value="baltimore"]').count())) fail("port picker has no Baltimore");
    log.push(`helm ports: ${await page.evaluate(() => window.__helm.ports)}`);
    // 1 May 2020: in the planning runs both boats lose the same part on day 3.9 (#196),
    // so a whole game fits in the smoke test.
    await pickSource(page, "launch", "2"); // the card's own select (its pills write it; M1 piece 5)
    await page.click("#go");
    await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 240000 });
    const hm = await page.evaluate(() => ({ ready: window.__helm.ready, err: window.__helm.error, msg: document.querySelector("#startmsg").textContent }));
    if (hm.ready) {
      await openOrders(page);
      await page.click("#s6");
      await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 240000 });
      // "Sail 6 hours" sails 6 hours unless something stops the clock first (a player
      // hits the same stops): then it must be a known reason, before hour 6.
      const six = await page.evaluate(() => ({ day: window.__helm.status?.day, stop: window.__helm.lastStop, err: window.__helm.error }));
      const sixOk = six.stop === "time" ? Math.abs(six.day - 0.25) < 0.01 : ["battery", "wind", "land", "silence", "ghost_passed", "passed_ghost", "over", "order_arrived"].includes(six.stop) && six.day < 0.25;
      if (!sixOk || six.err) fail(`helm: "sail 6 hours" stopped at day ${six.day} (${six.stop}${six.err ? `, ${six.err}` : ""})`);
      if (await page.evaluate(() => !document.getElementById("sailrow").hidden)) fail("helm: sail and engine buttons show for the kayak");
      // The clock (John, 11 Nov): a speed button sets time running, the simulator keeps
      // ahead of the picture, and pause holds it. A skip button pauses it again.
      if (!(await page.isVisible("#timebar")) || (await page.evaluate(() => window.__helm.clock)) !== 0) fail("helm: no time bar, or the clock isn't paused after a skip");
      await page.click('#timebar .rate[data-rate="24"]');
      const run0 = six.day;
      await page.waitForFunction((d) => window.__helm.status.day > d + 0.4 || window.__helm.clock === 0 || window.__helm.error, run0, { timeout: 240000 })
        .catch(() => fail(`helm: at 1 day a second the clock didn't move from day ${run0}`));
      // A "Your call" card (#391) is a reason to pause after a "time" run too; a bare pause isn't.
      // The card shows once the picture reaches the call's moment, a second or two after the pause.
      if (await page.evaluate(() => window.__helm.clock === 0 && window.__helm.lastStop === "time"))
        await page.waitForFunction(() => !document.getElementById("decide").hidden, null, { timeout: 15000 }).catch(() => {});
      const ran = await page.evaluate(() => ({ day: window.__helm.status.day, clock: window.__helm.clock, stop: window.__helm.lastStop, err: window.__helm.error, state: document.getElementById("timestate").textContent, card: !document.getElementById("decide").hidden }));
      if (ran.err || (ran.clock === 0 ? ran.stop === "time" && !ran.card : !/day a second/.test(ran.state))) fail(`helm clock: ${JSON.stringify(ran)}`);
      await page.evaluate(() => window.__helm.clock && document.getElementById("t-pause").click()); // pause, unless it paused itself
      await page.waitForFunction(() => window.__helm.clock === 0, null, { timeout: 10000 });
      await page.waitForTimeout(4000); // a run already under way lands
      const held = await page.evaluate(() => window.__helm.status.day);
      await page.waitForTimeout(4000);
      if ((await page.evaluate(() => window.__helm.status.day)) !== held) fail("helm: the clock kept running after pause");
      log.push(`helm clock: 1 day a second ran day ${run0.toFixed(2)} to ${ran.day.toFixed(2)}${ran.clock ? "" : ` (paused itself: ${ran.stop})`}, pause held`);
      // Paused, the panel's day and the 3D day label both show the hour the picture is at (audit A2, #372).
      const labels = await page.evaluate(() => [document.getElementById("day").textContent, document.getElementById("clock").textContent]);
      if (labels[0] !== labels[1]) fail(`helm paused: the panel says ${labels[0]} but the picture's label says ${labels[1]}`);
      const local = await page.evaluate(() => document.getElementById("local").textContent);
      if (!/ local \(UTC/.test(local)) fail(`helm: no local time (${local})`);
      // Ravi's gates in the page: the ghost never ahead of the player's clock, every
      // stop a known reason, and the game ends in a results card that follows the draw rule.
      const STOPS = ["time", "battery", "wind", "land", "breakdown", "silence", "ghost_passed", "passed_ghost", "over", "order_arrived"];
      const ahead = (s) => s && s.ghost.t > s.boat.t; // ISO minutes, same zone: string order is time order
      let st = await page.evaluate(() => ({ s: window.__helm.status, stop: window.__helm.lastStop }));
      if (ahead(st.s) || !Number.isFinite(st.s.lead_km)) fail(`helm after 6 h: ${JSON.stringify(st)}`);
      let hops = 0;
      for (; hops < 40 && !(await page.evaluate(() => window.__helm.card)); hops++) {
        await openOrders(page);
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
      // Results, "where this leaves you" (one-game step 3): a standing line and the three ways on.
      await page.waitForFunction(() => window.__helm.standing, null, { timeout: 30000 }).catch(() => fail("helm: the results card never said where the build stands"));
      // The story-first card: a headline, the standing in one line, then the ways on every ending has, in their one
      // order (M3, helm/ending.ts): Play again bright, Change the boat, Race it, Leaderboard; quiet links under them.
      const next = await page.evaluate(() => {
        const seen = (sel) => [...document.querySelectorAll(sel)].filter((e) => !e.hidden && e.offsetParent).map((e) => ({ text: e.textContent, href: e.getAttribute("href") ?? "" }));
        return { title: document.querySelector("#r-head")?.textContent ?? "", nums: document.querySelectorAll("#r-nums .n").length, head: document.querySelector("#r-next .standing")?.textContent ?? "", ways: seen("#r-btns > *"), quiet: seen("#r-links > *") };
      });
      const ways = next.ways.map((w) => w.text).join(" | ");
      if (!next.title || next.nums < 2 || next.nums > 3 || !next.head) fail(`helm results: ${JSON.stringify(next)}`);
      if (ways !== "Play again | Change the boat | Race it | Leaderboard") fail(`helm results: the ways on are "${ways}"`);
      if (!next.ways[3].href.startsWith("./leaderboard.html#") || !/who=autopilot&against=/.test(next.ways[2].href)) fail(`helm results: where the ways on lead: ${JSON.stringify(next.ways)}`);
      if ([...next.ways, ...next.quiet].some((w) => /race\.html|voyage\.html/.test(w.href))) fail(`helm results: a way on leads to an old page: ${JSON.stringify([...next.ways, ...next.quiet])}`);
      await snap({ path: "test-output/helm-result.png" });
      log.push(`helm sailed to day ${six.day.toFixed(2)} (${six.stop}), ${local}, then ${hops} hops to the card (${card.verdict}: ${card.boat.outcome} day ${card.boat.days.toFixed(1)}, ghost ${card.ghost.outcome} day ${card.ghost.days.toFixed(1)}); ${next.head}`);
      // Start from a port (John hit "can't start from a port yet" when the page
      // got ahead of its simulator): the packed simulator must take the port.
      await page.goto(`${URL}helm.html?quality=low`);
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2 && window.__helm.ports >= 20, null, { timeout: 60000 });
      await page.evaluate(() => (document.getElementById("more").open = true)); // the port is under More options on the Set sail card
      await page.selectOption("#port", "baltimore");
      await page.click("#go");
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 240000 });
      const fromPort = await page.evaluate(() => ({ ready: window.__helm.ready, err: window.__helm.error, msg: document.querySelector("#startmsg").textContent }));
      if (!fromPort.ready || fromPort.err) fail(`helm: can't start from Baltimore: ${JSON.stringify(fromPort)}`);
      log.push("helm started from Baltimore");
      // My boat: a Boatyard design saved in this browser is ticked on the start card (its name as text), and the game sails it.
      await page.evaluate(() => localStorage.setItem("boatsim.myboat.v1", JSON.stringify({ v: 1, kind: "yard", base: "revc", hash: "#base=revc&rudder=single", name: "Test <i>Rev C</i>", choices: { base: "revc", rudder: "single", cruise_w: 25 }, saved: "2026-11-11T00:00:00.000Z" })));
      await page.goto(`${URL}helm.html?quality=low`);
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 60000 });
      const mineRow = await page.evaluate(() => {
        const r = document.querySelector('input[name="boat"]:checked');
        return { v: r?.value, text: r?.parentElement.textContent, tags: r?.parentElement.querySelectorAll("i").length };
      });
      if (mineRow.v !== "mine" || !mineRow.text.includes("Test <i>Rev C</i>") || mineRow.tags) fail(`helm: my boat isn't offered first: ${JSON.stringify(mineRow)}`);
      await page.click("#go");
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 240000 });
      const mg = await page.evaluate(() => ({ ready: window.__helm.ready, err: window.__helm.error, sailing: window.__helm.sailing, clock: window.__helm.clock, lastStop: window.__helm.lastStop, msg: document.querySelector("#startmsg").textContent }));
      if (!mg.ready || mg.err || mg.sailing.base !== "revc" || mg.sailing.spec !== "randolph") fail(`helm: didn't sail my boat: ${JSON.stringify(mg)}`);
      // Without clock=paused, time runs from Set sail: the first hours at 1 hour a second, then 6
      // (unless something already paused it).
      if (mg.clock !== 1 && mg.clock !== 6 && !(mg.clock === 0 && mg.lastStop && mg.lastStop !== "time")) fail(`helm: the clock didn't start by itself: ${JSON.stringify(mg)}`);
      // Picking another boat on the start card makes it my boat, for the other pages.
      await page.goto(`${URL}helm.html?quality=low`);
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 60000 });
      // The Set sail card keeps the boat radios hidden and picks through the top bar's My boat picker,
      // which ticks the row and fires change: do the same.
      await page.locator('input[name="boat"][value="stock_cruiser31"]').evaluate((el) => {
        el.checked = true;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.click("#go");
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 240000 });
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("boatsim.myboat.v1") || "null"));
      if (saved?.kind !== "stock" || saved.base !== "stock_cruiser31" || saved.choices.base !== "stock_cruiser31") fail(`helm: the boat sailed didn't become my boat: ${JSON.stringify(saved)}`);
      await page.evaluate(() => localStorage.removeItem("boatsim.myboat.v1"));
      log.push("helm sailed my boat (Rev C design), and the cruiser became my boat");
    } else {
      if (!["no simulator files", "no helm in the simulator"].includes(hm.err) || !/published/.test(hm.msg)) fail(`helm start: ${JSON.stringify(hm)}`);
      log.push("helm: no simulator files, says so");
    }
    // Weather challenges start live: with the challenge files
    // published, pick the first one with its own weather bundle from the picker and
    // sail 6 hours on it. Without the files the picker stays hidden, and that's fine.
    await page.goto(`${URL}helm.html?quality=low&clock=paused`);
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
      await pickSource(page, "challenge", chFile.id);
      await page.click("#go");
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 240000 });
      let ch = await page.evaluate(() => ({ ready: window.__helm.ready, err: window.__helm.error, id: window.__helm.challenge, msg: document.querySelector("#startmsg").textContent }));
      // Published challenge files with a simulator that can't sail them is a live bug: the picker offers a game that won't start.
      if (!ch.ready || ch.err || ch.id !== chFile.id) fail(`helm challenge ${chFile.id} didn't start: ${JSON.stringify(ch)}`);
      else {
        await openOrders(page);
        await page.click("#s6");
        await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 240000 });
        const s = await page.evaluate(() => ({ st: window.__helm.status, stop: window.__helm.lastStop, err: window.__helm.error }));
        const known = ["time", "battery", "wind", "land", "breakdown", "silence", "ghost_passed", "passed_ghost", "over", "order_arrived"];
        if (s.err || !known.includes(s.stop) || !(s.st.day > 0 && s.st.day <= 0.25 + 1e-6)) fail(`helm challenge ${chFile.id}: 6 hours went wrong: ${JSON.stringify({ day: s.st?.day, stop: s.stop, err: s.err })}`);
        // Its own weather, not 2020's: the boat's clock is on the challenge's start day.
        if (s.st.boat.t.slice(0, 10) !== chFile.start.slice(0, 10)) fail(`helm challenge ${chFile.id}: boat clock ${s.st.boat.t}, challenge starts ${chFile.start}`);
        log.push(`helm challenge ${chFile.id}: started ${s.st.boat.t}, sailed to day ${s.st.day.toFixed(2)} (${s.stop})`);
      }
    }
    // The Sea page leads into the game (src/sailLink.ts): "Sail this sea" opens the helm in
    // weather like the sea on screen (Calm -> Gentle June, Gale -> Spring gale, Moderate ->
    // the usual launch), and "Build a boat" opens the Boatyard. ?title=0 skips #309's menu.
    await page.goto(`${URL}?quality=low&title=0`);
    await page.waitForFunction(() => (window.__sea3d?.frames ?? 0) > 2, null, { timeout: 30000 });
    // The page is on Low (?quality=low), so the link carries it: the helm opens on Low in one step.
    const WANT = { calm: "helm.html?challenge=gentle-june&quality=low", moderate: "helm.html?quality=low", gale: "helm.html?challenge=spring-gale&quality=low" };
    for (const [sea, want] of Object.entries(WANT)) {
      await page.selectOption("#sea", sea);
      const w = await page.evaluate(() => ({ sail: document.getElementById("sail").href, build: document.getElementById("build").href, shown: !!document.getElementById("sail").offsetParent && !!document.getElementById("build").offsetParent }));
      if (w.sail !== URL + want) fail(`Sea page, ${sea}: "Sail this sea" goes to ${w.sail}, want ${URL + want}`);
      if (w.build !== `${URL}boatyard.html` || !w.shown) fail(`Sea page: "Build a boat" should show and open the Boatyard: ${JSON.stringify(w)}`);
    }
    // One click, one navigation, as a player does (a second load would abort the helm's first downloads).
    await Promise.all([page.waitForURL(/helm\.html\?challenge=spring-gale&quality=low$/, { timeout: 30000 }), page.click("#sail")]);
    await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 60000 });
    const chJson = await page.evaluate(async () => {
      try {
        const r = await fetch("./challenges/challenges.json");
        return r.ok && !(r.headers.get("content-type") ?? "").includes("text/html");
      } catch {
        return false;
      }
    });
    if (!chJson) {
      // No challenge files: the link quietly falls back to the usual launch.
      const fb = await page.evaluate(() => ({ asked: window.__helm.asked, picker: !document.getElementById("chpick").hidden, launch: document.getElementById("launch").disabled }));
      if (fb.asked || fb.picker || fb.launch) fail(`helm from the Sea page without challenge files: ${JSON.stringify(fb)}`);
      log.push("Sea page -> helm: no challenge files, so the usual launch");
    } else {
      await page.waitForFunction(() => !document.getElementById("chpick").hidden, null, { timeout: 30000 });
      const pre = await page.evaluate(() => ({ asked: window.__helm.asked, value: document.getElementById("challenge").value, story: document.getElementById("chstory").textContent, launchOff: document.getElementById("launch").disabled }));
      if (pre.asked !== "spring-gale" || pre.value !== "spring-gale" || !pre.launchOff || !/gale/i.test(pre.story)) fail(`helm from the Sea page should arrive with Spring gale picked: ${JSON.stringify(pre)}`);
      if (!hm.ready) {
        log.push(`Sea page -> helm: Spring gale preselected; no simulator to sail it (${hm.err})`);
      } else {
        await page.click("#go");
        await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 240000 });
        const g = await page.evaluate(() => ({ ready: window.__helm.ready, err: window.__helm.error, id: window.__helm.challenge, t: window.__helm.status?.boat?.t }));
        if (!g.ready || g.err || g.id !== "spring-gale" || !g.t?.startsWith("2020-04-01")) fail(`helm from the Sea page didn't start Spring gale: ${JSON.stringify(g)}`);
        log.push(`Sea page -> helm: Spring gale preselected and started (${g.t})`);
      }
    }
    // Moderate opens the usual launch, with nothing preselected.
    await page.goto(`${URL}helm.html?quality=low`);
    await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 60000 });
    await page.waitForTimeout(500);
    const mod = await page.evaluate(() => ({ asked: window.__helm.asked, value: document.getElementById("challenge").value }));
    if (mod.asked || mod.value) fail(`a plain helm link preselected a challenge: ${JSON.stringify(mod)}`);
    // The one Set sail card's choices ride in the URL (the one-game plan, step 1): a rough start
    // fills in the 1 April launch, and an Annapolis link with go=1 is at the wheel at once.
    await page.goto(`${URL}helm.html?quality=low&when=rough`);
    await page.waitForFunction(() => window.__setsail, null, { timeout: 60000 });
    const rough = await page.evaluate(() => ({ launch: document.getElementById("launch").value, ss: window.__setsail.current() }));
    if (rough.launch !== "0" || rough.ss.when !== "rough") fail(`?when=rough didn't fill in the rough start: ${JSON.stringify(rough)}`);
    await page.goto(`${URL}helm.html?quality=low&where=annapolis&course=triangle&go=1`);
    await page.waitForFunction(() => window.__wheel?.on, null, { timeout: 90000 }).catch(() => fail("an Annapolis Set sail link didn't put you at the wheel"));
    if (new globalThis.URL(page.url()).searchParams.has("go")) fail("go=1 stayed in the URL, so a reload would set sail again");
    // Practice's front door is the Set sail card too (M1 piece 3): ?practice opens it with Annapolis picked.
    await page.goto(`${URL}helm.html?quality=low&practice`);
    await page.waitForFunction(() => window.__setsail && document.querySelector("#ss-where-opts .ss-pill"), null, { timeout: 60000 });
    const pc = await page.evaluate(() => ({ start: !document.getElementById("start").hidden, course: !document.getElementById("ss-course").hidden, old: !document.getElementById("result").hidden, where: document.querySelector("#ss-where-opts .ss-pill[aria-pressed=true]")?.firstChild?.textContent }));
    if (!pc.start || !pc.course || pc.old || !/Annapolis/.test(pc.where ?? "")) fail(`?practice didn't open the Set sail card on Annapolis: ${JSON.stringify(pc)}`);
    log.push("Set sail links: a rough start filled in; Annapolis practice at the wheel at once; ?practice opens the card on Annapolis");
    // Watch a voyage on the helm's own sailing screen (M2, R1): a recorded voyage plays with no simulator,
    // opens in real time (John, T2) with Real time first on the bar (T1), and there is nothing to steer.
    await page.goto(`${URL}helm.html?quality=low&watch=2020-06-01`);
    await page.waitForFunction(() => window.__helm?.ready || window.__helm?.error, null, { timeout: 60000 });
    const wv = await page.evaluate(() => ({
      err: window.__helm.error,
      view: window.__helm.view,
      clock: window.__helm.clock,
      name: window.__helm.watch?.name,
      first: document.querySelector("#timebar .rate")?.textContent,
      pressed: document.querySelector("#timebar .rate[aria-pressed=true]")?.textContent,
      orders: getComputedStyle(document.getElementById("orders-tab")).display,
      start: !document.getElementById("start").hidden,
    }));
    if (wv.err || wv.view !== "watch" || wv.start || wv.name !== "Our kayak") fail(`helm?watch didn't open the recorded voyage: ${JSON.stringify(wv)}`);
    if (Math.abs(wv.clock - 1 / 3600) > 1e-9 || wv.first !== "Real time" || wv.pressed !== "Real time") fail(`a watched voyage must open in real time, Real time first on the bar: ${JSON.stringify(wv)}`);
    if (wv.orders !== "none") fail("a watched voyage showed the orders drawer");
    await page.keyboard.press("Digit4");
    await page.waitForFunction(() => window.__helm.hour > 12, null, { timeout: 60000 }).catch(() => fail("a watched voyage didn't sail on at a day a second"));
    log.push("helm?watch: a recorded voyage on the sailing screen, in real time, nothing to steer");
    // The Set sail card's "Who steers" row (M2, R2): with the autopilot picked, the card lists the days she
    // has sailed as plain dates, never says "recorded" or "replay", and Set sail opens that voyage here.
    // On for everyone since 13 Nov (John): the plain card shows the row with "You" picked and Set sail unchanged.
    await page.goto(`${URL}helm.html?quality=low`);
    await page.waitForFunction(() => document.querySelector("#ss-when-opts .ss-pill"), null, { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector("#ss-who-opts .ss-pill"), null, { timeout: 60000 }).catch(() => fail("the plain Set sail card has no Who steers row"));
    const plain = await page.evaluate(() => ({ who: document.querySelector('#ss-who-opts .ss-pill[aria-pressed="true"]')?.textContent, go: document.getElementById("go").textContent }));
    if (plain.who !== "You" || plain.go !== "Set sail") fail(`the plain Set sail card must open on You with Set sail: ${JSON.stringify(plain)}`);
    await page.goto(`${URL}helm.html?quality=low&who=autopilot`);
    await page.waitForFunction(() => document.querySelector("#ss-who-opts .ss-pill"), null, { timeout: 60000 }).catch(() => fail("the Set sail card has no Who steers row"));
    const ws = await page.evaluate(() => ({
      who: document.querySelector('#ss-who-opts .ss-pill[aria-pressed="true"]')?.textContent,
      day: document.querySelector('#ss-when-opts .ss-pill[aria-pressed="true"]')?.textContent,
      days: document.querySelectorAll("#ss-when-opts .ss-pill").length,
      go: document.getElementById("go").textContent,
      label: document.querySelector("#ss-when .ss-l").textContent,
      bad: /record|replay/i.test(document.getElementById("ss-card").innerText),
    }));
    if (ws.who !== "The autopilot" || ws.day !== "1 Jun" || ws.label !== "Launch day, 2020" || ws.days < 2 || ws.go !== "Watch her go" || ws.bad) fail(`Who steers: the autopilot's card is wrong: ${JSON.stringify(ws)}`);
    await page.click("#go");
    await page.waitForFunction(() => window.__helm?.view === "watch" && (window.__helm.ready || window.__helm.error), null, { timeout: 60000 }).catch(() => fail("Set sail with the autopilot didn't open her voyage"));
    if (!/watch=voyage_2020-06-01\.json/.test(page.url())) fail(`Set sail with the autopilot opened ${page.url()}`);
    log.push("Who steers: the autopilot's Set sail opens her voyage on the sailing screen");
    // "Race against" (M2, R4): with Another boat picked the card names the rival, "(our model)" on a Randolph
    // boat (B2), and Set sail opens the race on this screen with both boats and the launch day in the link.
    await page.goto(`${URL}helm.html?quality=low&who=autopilot&against=revc`);
    await page.waitForFunction(() => document.querySelector("#ss-rival-opts .ss-pill"), null, { timeout: 60000 }).catch(() => fail("the Set sail card has no Race against row"));
    const rr = await page.evaluate(() => ({
      rival: document.querySelector('#ss-rival-opts .ss-pill[aria-pressed="true"]')?.textContent,
      against: document.getElementById("ss-against-name").textContent,
      after: document.getElementById("ss-after").textContent,
      go: document.getElementById("go").textContent,
    }));
    if (rr.go !== "Start the race" || rr.rival !== "Another boat" || rr.against !== "Randolph Rev C5 (our model)" || !/both boats steer themselves/.test(rr.after)) fail(`Race against: the card is wrong: ${JSON.stringify(rr)}`);
    await page.click("#go");
    await page.waitForURL(/race=kayak,revc&launch=4/, { timeout: 15000 }).catch(() => fail(`Set sail with another boat opened ${page.url()}`));
    log.push("Race against: Set sail with another boat opens the race on the sailing screen");
    // "Race it" on the same screen (M2, R3): two boats from the race's own simulator, boat B where the ghost
    // goes. It opens paused, as the race page does, with Real time first on the bar (T1).
    await page.goto(`${URL}helm.html?quality=low&race=kayak,revc`);
    await page.waitForFunction(() => window.__helm?.ready || window.__helm?.error, null, { timeout: 240000 });
    const rv = await page.evaluate(() => ({
      err: window.__helm.error,
      view: window.__helm.view,
      clock: window.__helm.clock,
      names: window.__helm.race?.names,
      first: document.querySelector("#timebar .rate")?.textContent,
      orders: getComputedStyle(document.getElementById("orders-tab")).display,
      lead: getComputedStyle(document.getElementById("c-lead")).display,
    }));
    // Only "this copy has no simulator (or no race in it)" may pass quietly: any other error is a failure (Lena).
    if (/^no (simulator files|race in the simulator)$/.test(rv.err ?? "")) log.push(`helm?race: no simulator to race on here (${rv.err})`);
    else if (rv.err) fail(`helm?race failed to open: ${rv.err}`);
    else {
      // The second boat is on the water beside yours at the start, with her name above her (Elena).
      await page.waitForFunction(() => window.__helm.rival?.shown, null, { timeout: 30000 }).catch(() => fail("the other boat in a race isn't on the water at the start"));
      if (rv.view !== "race" || rv.clock !== 0 || rv.first !== "Real time" || rv.orders !== "none" || rv.lead === "none") fail(`helm?race didn't open the race on the sailing screen: ${JSON.stringify(rv)}`);
      if (!/\(our model\)$/.test(rv.names?.[1] ?? "")) fail(`the Randolph boat in a race must be named as our model (B2): ${JSON.stringify(rv.names)}`);
      await page.keyboard.press("Digit4");
      await page.waitForFunction(() => window.__helm.hour > 12 && window.__helm.status?.ghost, null, { timeout: 120000 }).catch(() => fail("a race on the helm screen didn't sail on at a day a second"));
      log.push(`helm?race: ${rv.names.join(" against ")} on the sailing screen`);
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
      // Randolph's boats: a quiet "our model" tag beside the name, the "i" with the detail (Maya); never "(our model)" in the name.
      model: [...document.querySelectorAll("#rows .name .info")].map((c) => c.getAttribute("title") ?? ""),
      names: [...document.querySelectorAll("#rows .name")].map((c) => c.firstChild?.textContent ?? ""),
      tags: document.querySelectorAll("#rows .name .modeltag").length,
      // A folded group row that names a Randolph boat carries the tag too.
      untagged: [...document.querySelectorAll("#rows tr.group")].filter((r) => /Randolph/.test(r.textContent) && !r.querySelector(".modeltag")).length,
    }));
    const leaked = lb.names.filter((n) => /Drive:|: [a-z0-9]+-|W cruise|\(our model\)|GUESS/.test(n));
    if (leaked.length) fail(`leaderboard shows internal build names: ${JSON.stringify(leaked)}`);
    const sorted = lb.tiers.every((t, i) => i === 0 || t >= lb.tiers[i - 1]);
    if (lb.error || lb.rows < 2 || !lb.sample || !/not results/.test(lb.banner) || !sorted || lb.ref !== 1 || !lb.model.some((t) => /^Our model of the Randolph team/.test(t)) || lb.tags < 1 || lb.untagged)
      fail(`leaderboard sample: ${JSON.stringify(lb)}`);
    // Two tabs (M3, W5): the designs board opens first; Weather challenges is its own tab, lists the
    // challenges from this site with "Not sailed yet" in a fresh browser, and a link can open it.
    await page.waitForFunction(() => window.__leaderboard.challenges !== undefined, null, { timeout: 30000 }).catch(() => fail("leaderboard: the Weather challenges tab never drew"));
    const tabs0 = await page.evaluate(() => ({ tab: window.__leaderboard.tab, designs: !document.getElementById("p-designs").hidden, ch: !document.getElementById("p-challenges").hidden }));
    if (tabs0.tab !== "designs" || !tabs0.designs || tabs0.ch) fail(`leaderboard: it should open on Boats: ${JSON.stringify(tabs0)}`);
    await page.click("#tab-challenges");
    const tabs1 = await page.evaluate(() => ({
      tab: window.__leaderboard.tab,
      designs: !document.getElementById("p-designs").hidden,
      hash: location.hash,
      n: window.__leaderboard.challenges,
      rows: document.querySelectorAll("#crows tr").length,
      unsailed: [...document.querySelectorAll("#crows td.yours")].filter((t) => t.textContent === "Not sailed yet").length,
      none: document.getElementById("cnone").textContent,
      money: /[$£€]|price|cost/i.test(document.getElementById("p-challenges").innerText),
    }));
    if (tabs1.tab !== "challenges" || tabs1.designs || tabs1.hash !== "#challenges" || tabs1.rows !== tabs1.n || tabs1.unsailed !== tabs1.rows || tabs1.money || (tabs1.n === 0 && !/aren't available right now/.test(tabs1.none)))
      fail(`leaderboard: Weather challenges tab: ${JSON.stringify(tabs1)}`);
    await page.click("#tab-designs");
    log.push(`leaderboard tabs: Boats, and Weather challenges with ${tabs1.n} challenges`);
    // The game's look (M3): the real sea and sky come up behind the board, after its words.
    await page.waitForFunction(() => window.__leaderboard.sea?.frames > 0 && document.body.classList.contains("sea"), null, { timeout: 60000 }).catch(() => fail("leaderboard: no sea and sky behind the page"));
    await snap({ path: "test-output/leaderboard.png", fullPage: true });
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
        || names[0] !== "Our kayak" || !/Rev C5 \(our model\)/.test(names[1]) || r.tracks.some((n) => n < 1))
        fail(`race after a day: ${JSON.stringify({ ...r, s: { day: r.s?.day, lead: r.s?.lead_km, names } })}`);
      // The 3D views: each boat on its own sea, drawing, and the right boat in each.
      await page.locator("#views").scrollIntoViewIfNeeded();
      await page.waitForFunction(() => window.__race.views.length === 2 && window.__race.views.every((v) => v.frames > 3), null, { timeout: 60000 })
        .catch(async () => fail(`race 3D views: ${JSON.stringify(await page.evaluate(() => window.__race.views))}`));
      const vb = await page.evaluate(() => window.__race.views.map((v) => v.boat));
      if (vb.join() !== "kayak,randolph") fail(`race 3D views show ${vb.join()}`);
      await snap({ path: "test-output/race.png", fullPage: true });
      log.push(`race: ${names.join(" vs ")} sailed a day in step, lead ${r.s.lead_km.toFixed(0)} km`);
      // My boat is boat A to start with, and the race sails its own parts.
      await page.evaluate(() => localStorage.setItem("boatsim.myboat.v1", JSON.stringify({ v: 1, kind: "yard", base: "kayak", hash: "#thr=one-t200", name: "One motor", choices: { thr: "one-t200", cruise_w: 25 }, saved: "2026-11-11T00:00:00.000Z" })));
      await page.goto(`${URL}race.html`);
      const selA = await page.evaluate(() => ({ v: document.getElementById("baseA").value, text: document.getElementById("baseA").selectedOptions[0]?.textContent }));
      if (selA.v !== "mine" || selA.text !== "My boat: One motor") fail(`race: my boat isn't boat A: ${JSON.stringify(selA)}`);
      await page.selectOption("#launch", "4");
      await page.click("#go");
      await page.waitForFunction(() => window.__race && (window.__race.ready || window.__race.error), null, { timeout: 240000 });
      const rm = await page.evaluate(() => ({ ready: window.__race.ready, err: window.__race.error, names: window.__race.status?.boats.map((b) => b.name) }));
      if (!rm.ready || rm.err || rm.names?.[0] !== "One motor") fail(`race with my boat: ${JSON.stringify(rm)}`);
      if ((await page.locator("#boatA h3").textContent()) !== "One motor") fail("race: boat A's panel doesn't show my boat's name");
      await page.evaluate(() => localStorage.removeItem("boatsim.myboat.v1"));
      log.push(`race with my boat: ${rm.names.join(" vs ")}`);
    } else {
      // No files: the page checks before loading Python (a preview server answers the
      // missing zip with HTML, which Pyodide would choke on). An old simulator: NO_RACE.
      if (!(rc0.err === "no simulator files" && /aren't published/.test(rc0.msg)) && !/older than the race view/.test(rc0.msg)) fail(`race start: ${JSON.stringify(rc0)}`);
      log.push("race: no simulator files, says so");
    }
    if (errors.length) fail(`page errors: ${errors.join("; ")}`);
  }

  await browser.close();
  console.log(`OK (part ${PART}, ${Math.round((Date.now() - t0) / 1000)} s): ${log.join(", ")}${runA ? `; both boats afloat; sea vertices high ${vHigh}, low ${vLow}` : ""}`);
} catch (e) {
  fail(String(e));
}
server.kill();
