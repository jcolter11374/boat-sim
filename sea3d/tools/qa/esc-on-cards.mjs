// Plays the default crossing (23 April 2020, our kayak, "You" steering) in a headless browser and
// presses Esc on every "Your call" card, printing what each card offered, what its foot said Esc
// would do, and the order and power afterwards (#654). Before the fix the boat was left at 10%
// power from the day 4.4 big-waves card on; after it she stays on the autopilot.
//
//   npm run build   (or tools/build_site.sh from the repo root, for the simulator and its weather)
//   [PYODIDE_DIR=...] node tools/qa/esc-on-cards.mjs [days=12] [--slow] [--json out.json]
//
// --slow: on a storm card, press the "Slow down to 10% power and ride it out" key instead of Esc,
// to see the power come back once the blow has passed (Esc on every other card).
//
// Exits 1 if she ends the run at 10% power and off the autopilot.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const days = Number(process.argv[2]) || 12;
const jsonAt = process.argv.indexOf("--json");
const slow = process.argv.includes("--slow");
const PORT = 4179;
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
await page.goto(`${URL}helm.html?quality=low`);
await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 120000 });
await page.click("#go");
await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 300000 });
const err = await page.evaluate(() => window.__helm.error);
if (err) { console.error("the simulator didn't start:", err); done(2); }

const state = () => page.evaluate(() => ({
  day: window.__helm.status?.day ?? 0,
  over: !!window.__helm.status?.over,
  clock: window.__helm.clock,
  // The order cell and the Orders panel's power line: "Autopilot, 25% power", "The route, 10% power".
  order: `${document.getElementById("c-orderv").textContent}, ${document.getElementById("powertext").textContent.split(",")[0]}`,
  note: Array.from(document.querySelectorAll("#notes .note")).map((n) => n.textContent).at(-1) ?? "",
  card: !document.getElementById("decide").hidden,
}));
const run = () => page.click('#timebar .rate[data-rate="24"]').catch(() => {});
const cards = [];
let last = (await state()).order;
let passed = "";
await run();
const t0 = Date.now();
for (;;) {
  const s = await state();
  if (s.over || s.day >= days || Date.now() - t0 > 20 * 60e3) break;
  if (s.card) {
    const card = await page.evaluate(() => ({
      text: document.getElementById("decidetext").textContent,
      options: Array.from(document.querySelectorAll("#decidebtns button")).map((b) => b.childNodes[1]?.textContent ?? b.textContent),
      foot: document.getElementById("decidefoot").textContent.replace(/^.*?(Keys )/, "$1"),
    }));
    const slowKey = slow ? card.options.findIndex((o) => /^Slow down/.test(o)) + 1 : 0;
    await page.keyboard.press(slowKey ? `Digit${slowKey}` : "Escape");
    await page.waitForFunction(() => document.getElementById("decide").hidden, null, { timeout: 10000 });
    await page.waitForTimeout(250);
    const after = await state();
    cards.push({ day: Number(s.day.toFixed(1)), ...card, pressed: slowKey ? String(slowKey) : "Esc", before: s.order, after: after.order });
    console.log(`\nDay ${s.day.toFixed(1)}: ${card.text}\n  ${card.options.map((o, i) => `${i + 1}. ${o}`).join("\n  ")}\n  ${card.foot}\n  before: ${s.order}   after ${slowKey ? `key ${slowKey}` : "Esc"}: ${after.order}`);
    continue;
  }
  if (s.order !== last) console.log(`\nDay ${s.day.toFixed(1)}: the order now reads "${s.order}"`);
  last = s.order;
  if (/passed/.test(s.note) && s.note !== passed) console.log(`\nDay ${s.day.toFixed(1)} note: ${(passed = s.note)}`);
  if (s.clock === 0) await run(); // a stop that isn't a call (a note, a milestone): carry on
  await page.waitForTimeout(500);
}
const end = await state();
console.log(`\nStopped at day ${end.day.toFixed(1)}: ${end.order}. ${cards.length} card(s).`);
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify({ days: end.day, end, cards }, null, 2));
await browser.close();
const stuck = !/Autopilot/.test(end.order) && /\b10% power/.test(end.order);
if (stuck) console.error("FAIL: she is still at 10% power, off the autopilot.");
done(stuck ? 1 : 0);
