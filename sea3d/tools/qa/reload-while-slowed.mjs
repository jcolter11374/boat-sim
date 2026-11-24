// Plays the default crossing (23 April 2020, our kayak, "You" steering) to the first storm card,
// picks "Slow down to 10% power and ride it out", reloads the page while she is still slowed, and
// continues the voyage (#657). Before the fix she stayed at 10% power for good after the reload;
// after it the power comes back once the blow has passed, as it does without a reload.
//
//   tools/build_site.sh   (from the repo root, for the simulator and its weather)
//   [PYODIDE_DIR=...] node tools/qa/reload-while-slowed.mjs [--own]
//
// --own: after the reload, the player sets the power slider to 30% themselves. That order is
// theirs and must stand: no hand-back to the autopilot when the blow has passed.
//
// Exits 1 if she is still at 10% power and off the autopilot 6 voyage days after the reload
// (or, with --own, if she is not still at the player's 30%).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const own = process.argv.includes("--own");
const PORT = 4178;
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

const ready = () => page.waitForFunction(() => (window.__helm?.ready && !window.__helm.busy) || window.__helm?.error, null, { timeout: 300000 });
const state = () => page.evaluate(() => ({
  day: window.__helm.status?.day ?? 0,
  over: !!window.__helm.status?.over,
  clock: window.__helm.clock,
  order: `${document.getElementById("c-orderv").textContent}, ${document.getElementById("powertext").textContent.split(",")[0]}`,
  card: !document.getElementById("decide").hidden,
  options: Array.from(document.querySelectorAll("#decidebtns button")).map((b) => b.childNodes[1]?.textContent ?? b.textContent),
  text: document.getElementById("decidetext").textContent,
  note: Array.from(document.querySelectorAll("#notes .note")).map((n) => n.textContent).at(-1) ?? "",
}));
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("boatsim.voyage.v1") ?? "null"));
const run = (rate) => page.click(`#timebar .rate[data-rate="${rate}"]`).catch(() => {});

await page.goto(`${URL}helm.html?quality=low`);
await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 120000 });
await page.click("#go");
await ready();
if (await page.evaluate(() => window.__helm.error)) { console.error("the simulator didn't start"); done(2); }

// To the first storm card with a "slow down" option, Esc on any other card. An hour a second from
// day 4, so the simulator isn't days ahead of the picture when the slow order goes.
await run(24);
const t0 = Date.now();
let slowed = null;
while (!slowed) {
  const s = await state();
  if (s.over || s.day > 20 || Date.now() - t0 > 15 * 60e3) { console.error(`no storm card with "slow down" by day ${s.day.toFixed(1)}`); done(2); }
  if (s.card) {
    const key = s.options.findIndex((o) => /^Slow down/.test(o)) + 1;
    console.log(`Day ${s.day.toFixed(1)}: ${s.text}\n  pressed ${key ? `${key} (${s.options[key - 1]})` : "Esc"}`);
    if (key) await run(1); // the speed the clock will carry on at
    await page.keyboard.press(key ? `Digit${key}` : "Escape");
    await page.waitForFunction(() => document.getElementById("decide").hidden, null, { timeout: 10000 });
    if (key) slowed = s;
    continue;
  }
  if (s.clock === 0) await run(24);
  await page.waitForTimeout(300);
}
// Wait for the save that carries the slow order, then leave.
await page.waitForFunction(() => JSON.parse(localStorage.getItem("boatsim.voyage.v1") ?? "null")?.order?.power === 0.1, null, { timeout: 30000 })
  .catch(() => { console.error("the slow order never reached the save (the blow passed first?)"); });
const before = await state();
const was = await saved();
console.log(`Before the reload, day ${before.day.toFixed(1)}: ${before.order}\n  saved order: ${JSON.stringify(was?.order)}\n  saved "go back to": ${JSON.stringify(was?.back ?? null)}`);
if (was?.order?.power !== 0.1) done(2);

// Leave the page (it writes its last save as it goes), then open what "Continue your voyage"
// opens: the save as it stands now.
await page.goto(`${URL}version.json`);
const left = await saved();
await page.goto(`${URL}helm.html?g=${left.code}&continue=1&quality=low`);
await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 120000 });
await ready();
const back = await state();
console.log(`After the reload, day ${back.day.toFixed(1)}: ${back.order}`);
if (own) {
  // As a drag of the slider does: the panel's value first, then the order.
  await page.evaluate(() => {
    const p = document.getElementById("power");
    p.value = "30";
    p.dispatchEvent(new Event("input", { bubbles: true }));
    p.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(1000);
  console.log(`The player sets 30% power: ${(await state()).order}`);
}
await run(24);
let last = back.order;
let passed = "";
const until = back.day + 6;
for (;;) {
  const s = await state();
  if (s.over || s.day >= until || Date.now() - t0 > 25 * 60e3) break;
  if (s.order !== last) console.log(`Day ${s.day.toFixed(1)}: the order now reads "${(last = s.order)}"`);
  if (/passed/.test(s.note) && s.note !== passed) console.log(`Note: ${(passed = s.note)}`);
  if (s.card) {
    console.log(`Day ${s.day.toFixed(1)} card: ${s.text} (Esc)`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("decide").hidden, null, { timeout: 10000 });
    continue;
  }
  if (s.clock === 0) await run(24);
  await page.waitForTimeout(400);
}
const end = await state();
console.log(`Day ${end.day.toFixed(1)}: ${end.order}`);
await browser.close();
const stuck = !/Autopilot/.test(end.order) && /\b10% power/.test(end.order);
if (stuck) console.error("FAIL: she is still at 10% power, off the autopilot, after the reload.");
const overruled = own && !/\b30% power/.test(end.order);
if (overruled) console.error("FAIL: the player's own 30% did not stand.");
done(stuck || overruled ? 1 : 0);
