// Plays the default crossing (23 April 2020, our kayak) in a headless browser to the "go by the Azores"
// call (John, 24 Nov 2026: "Azores and a dock in Portugal"), says yes, and sails on past Pico to the
// finish. Prints the card as the player sees it, where she is every five days, when Pico's land comes
// into the picture and how near she passes. Esc on every other card. Takes pictures of the card and of Pico.
//
//   tools/build_site.sh   (from the repo root: the simulator, its weather and the land files)
//   [PYODIDE_DIR=...] node tools/qa/azores-call.mjs [picture folder] [--no]
//
// --no: turn the call down, and check she never goes near the islands.
// Exits 1 if the call never came, or (on yes) she didn't pass Pico at 15 to 35 km from its land's edge and finish.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const no = process.argv.includes("--no");
if (out) mkdirSync(out, { recursive: true });
const PORT = 4186;
const URL = `http://localhost:${PORT}/`;
const server = spawn("node_modules/.bin/vite", ["preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const done = (code) => { server.kill(); process.exit(code); };
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
// Thread sandboxes can't reach the Pyodide CDN: PYODIDE_DIR=<unpacked pyodide release> serves it
// from disk, as tests/smoke.mjs does.
if (process.env.PYODIDE_DIR) {
  await context.route("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/**", (route) => {
    const name = new globalThis.URL(route.request().url()).pathname.split("/").pop();
    const type = name.endsWith(".mjs") || name.endsWith(".js") ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".json") ? "application/json" : "application/octet-stream";
    route.fulfill({ body: readFileSync(`${process.env.PYODIDE_DIR}/${name}`), contentType: type, headers: { "access-control-allow-origin": "*" } });
  });
}
const page = await context.newPage();
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.goto(`${URL}helm.html?quality=low&dock=0`);
await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 120000 });
await page.click("#go");
await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 300000 });
const err = await page.evaluate(() => window.__helm.error);
if (err) { console.error("the simulator didn't start:", err); done(2); }

const state = () => page.evaluate(() => ({
  day: window.__helm.status?.day ?? 0,
  over: !!window.__helm.status?.over,
  outcome: window.__helm.status?.boat?.outcome,
  at: [window.__helm.status?.boat?.lat, window.__helm.status?.boat?.lon],
  via: !!window.__helm.status?.via_azores,
  clock: window.__helm.clock,
  order: document.getElementById("c-orderv").textContent,
  land: window.__helm.land,
  card: !document.getElementById("decide").hidden,
}));
const run = () => page.click('#timebar .rate[data-rate="24"]').catch(() => {});
let bad = 0;
const check = (ok, words) => { console.log(`${ok ? "ok  " : "FAIL"} ${words}`); if (!ok) bad++; };
let asked = null, seen = null, nearest = Infinity, lastDay = -5;
await run();
const t0 = Date.now();
for (;;) {
  const s = await state();
  if (s.over || s.day >= 90 || Date.now() - t0 > 40 * 60e3) break;
  if (s.day - lastDay >= 5) { lastDay = s.day; console.log(`day ${s.day.toFixed(1)}: ${s.at[0].toFixed(2)}N ${(-s.at[1]).toFixed(2)}W, ${s.order}${s.via ? ", by the Azores" : ""}`); }
  if (s.land?.place === "pico") {
    nearest = Math.min(nearest, s.land.km);
    if (!seen) { seen = s; console.log(`day ${s.day.toFixed(1)}: Pico's land is loaded, ${s.land.km.toFixed(0)} km from its edge`); }
    if (out && s.land.km < 31 && !seen.shot) {
      seen.shot = true;
      await page.evaluate(() => window.__helm.aim(0)); // look north, past her at the mountain
      await page.waitForTimeout(4000);
      await page.screenshot({ path: `${out}/pico.png` });
    }
  }
  if (s.card) {
    const card = await page.evaluate(() => ({
      text: document.getElementById("decidetext").textContent,
      options: Array.from(document.querySelectorAll("#decidebtns button")).map((b) => ({ label: b.childNodes[1]?.textContent ?? b.textContent, title: b.title })),
    }));
    const azores = /^The Azores/.test(card.text);
    if (azores) {
      asked = { day: s.day, at: s.at };
      console.log(`\nDay ${s.day.toFixed(1)} at ${s.at[0].toFixed(2)}N ${(-s.at[1]).toFixed(2)}W: ${card.text}\n  ${card.options.map((o, i) => `${i + 1}. ${o.label}  [${o.title}]`).join("\n  ")}`);
      if (out) await page.screenshot({ path: `${out}/card.png` });
    }
    await page.keyboard.press(azores && !no ? "Digit1" : "Escape");
    await page.waitForFunction(() => document.getElementById("decide").hidden, null, { timeout: 10000 });
    await page.waitForTimeout(400);
    if (azores) console.log(`  pressed ${no ? "Esc" : "1"}: the order reads "${(await state()).order}", by the Azores: ${(await state()).via}\n`);
    continue;
  }
  if (s.clock === 0) await run();
  await page.waitForTimeout(500);
}
const end = await state();
console.log(`\nEnded day ${end.day.toFixed(1)}: ${end.outcome}.`);
check(!!asked, "the Azores call was asked in mid-ocean");
if (no) check(!end.via && !seen, "said no: she never went near the islands");
else {
  check(end.via, "said yes: the simulator has her going by the Azores");
  check(!!seen, "Pico's land came into the picture");
  check(nearest > 15 && nearest < 35, `nearest to the edge of Pico's land: ${nearest.toFixed(0)} km`);
  check(end.outcome === "arrived", `she finished (${end.outcome})`);
}
await browser.close();
done(bad ? 1 : 0);
