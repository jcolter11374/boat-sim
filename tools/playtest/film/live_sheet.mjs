// Deterministic film frames: the page's clock steps 1/FPS a frame, so pacing is true to life.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
// One film sequence at a real moment of a voyage, nothing forced (John's C4), for the M5 contact sheet.
// usage: BASE=https://.../boat-sim/ node live_sheet.mjs <boat> <sequence> <when> <outdir> [secs=60] [fps=8]
//   when: "day" (some hours out, by day), "golden" (sun 1-6 deg up), "night" (sun under -12 deg),
//         "gale" (the first daylight hour with 27 knots of wind or more), "hour:<h>" (that voyage hour), "after-knockdown" (just after the first knockdown the voyage records)
const [boat, seq, when, dir, secs = "60", fps = "8"] = process.argv.slice(2);
const BASE = process.env.BASE ?? "http://localhost:4182/";
const FPS = Number(fps);
mkdirSync(dir, { recursive: true });
const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await b.newContext({ viewport: { width: Number(process.env.VW ?? 960), height: Number(process.env.VH ?? 540) } });
await ctx.addInitScript(() => {
  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  let virt = null;
  let queue = [];
  performance.now = () => (virt === null ? realNow() : virt);
  window.requestAnimationFrame = (cb) => {
    if (virt === null) return realRaf(cb);
    queue.push(cb);
    return queue.length;
  };
  window.__virtual = () => { virt = realNow(); };
  window.__tick = (dt) => {
    virt += dt * 1000;
    const q = queue;
    queue = [];
    for (const cb of q) cb(virt);
  };
});
// Offline sandboxes only: serve the Python runtime from a local copy when one is there. A runner with internet skips this.
if ((await import("node:fs")).existsSync("/tmp/claude-0/pyocdn")) await ctx.route("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/**", (route) => {
  const name = new globalThis.URL(route.request().url()).pathname.split("/").pop();
  const type = name.endsWith(".mjs") || name.endsWith(".js") ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".json") ? "application/json" : "application/octet-stream";
  route.fulfill({ body: readFileSync(`/tmp/claude-0/pyocdn/${name}`), contentType: type, headers: { "access-control-allow-origin": "*" } });
});
const p = await ctx.newPage();
p.setDefaultTimeout(180000);
p.on("pageerror", (e) => console.log("pageerror:", e.message));
await p.goto(`${BASE}helm.html?quality=high`);
if (boat !== "kayak") {
  await p.waitForFunction((b) => !!document.querySelector(`input[name="boat"][value="${b}"]`), boat, { timeout: 120000 });
  await p.locator(`input[name="boat"][value="${boat}"]`).evaluate((el) => { el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); });
}
if (process.env.LAUNCH) await p.evaluate((v) => { const s = document.getElementById("launch"); s.value = v; s.dispatchEvent(new Event("change", { bubbles: true })); }, process.env.LAUNCH);
await p.click("#go");
await p.waitForFunction(() => window.__helm?.ready, null, { timeout: 300000 });
// Sail on until the voyage itself reaches the moment wanted: a day a second while it is far off (hour targets only),
// 6 h a second, then 1 h a second near it. The page checks the moment and stops its own clock in the same step,
// so a slow machine cannot sail past it (Nina's live run, 14 Nov: golden hour overshot by 0.6 h at 6 h a second).
const want = when.startsWith("hour:") ? Number(when.slice(5)) : null;
const MAX_MIN = Number(process.env.MAX_MIN ?? 25);
let rate = when === "day" ? "1" : want != null && want > 40 ? "24" : "6";
await p.click(`button.rate[data-rate="${rate}"]`);
const t0 = Date.now();
for (;;) {
  const st = await p.evaluate(([when, want]) => {
    const h = window.__helm;
    const d = document.getElementById("decide");
    if (d && !d.hidden) d.querySelector("#decidebtns button")?.click();
    const el = h.cine.host.sunEl();
    const kn = h.cine.host.speed();
    const k = h.knockdown()?.start ?? null;
    const windKn = Number(/([\d.]+) kn/.exec(document.getElementById("c-windv")?.textContent ?? "")?.[1] ?? 0);
    const there = (when === "gale" ? h.hour > 6 && windKn >= 27 && el > 10 : when === "day" ? h.hour >= 7 && el > 15 : when === "golden" ? h.hour > 6 && el > 1 && el < 6 : when === "night" ? h.hour > 6 && el < -12 : when === "after-knockdown" ? k != null : h.hour >= want) && kn > 0.3;
    if (there) { if (h.clock !== 0) document.getElementById("t-pause")?.click(); }
    else if (h.clock === 0 && !h.busy && !h.card) document.getElementById("t-pause")?.click();
    return { there, windKn, hour: h.hour, over: !!h.status?.over, el, kn, k, wind: document.getElementById("c-windv")?.textContent };
  }, [when, want]);
  if (st.there) { console.log("moment:", JSON.stringify(st)); break; }
  if (st.over || Date.now() - t0 > MAX_MIN * 60e3) { console.log("NEVER REACHED THE MOMENT:", JSON.stringify(st)); process.exit(3); }
  // Slow down near the moment: an hour target by the hours left; golden hour and night by the sun getting low.
  const near = want != null ? (st.hour >= want - 9 ? "1" : st.hour >= want - 40 ? "6" : rate) : (when === "golden" || when === "night") && st.hour > 6 && st.el < 14 ? "1" : when === "gale" ? (st.windKn >= 22 && st.el > 0 ? "1" : "6") : rate;
  if (near !== rate) { rate = near; await p.click(`button.rate[data-rate="${rate}"]`); }
  await p.waitForTimeout(rate === "1" ? 40 : 120);
}
await p.evaluate(() => window.__helm.clock !== 0 && document.getElementById("t-pause")?.click());
await p.waitForTimeout(3000);
await p.evaluate(() => window.__virtual());
await p.evaluate(() => { for (let k = 0; k < 40; k++) window.__tick(0.05); });
// The clock is stopped at the knockdown's hour; step the page's own time until the knockdown's camera move has finished
// (on a slow machine waiting in real time took over two minutes), then the film starts.
if (when === "after-knockdown") for (let k = 0; k < 600 && (await p.evaluate(() => { window.__tick(0.1); return window.__helm.knockCut(); })); k++);
const info = await p.evaluate(() => ({ hour: window.__helm.hour, kn: window.__helm.cine.host.speed(), el: window.__helm.cine.host.sunEl(), wind: document.getElementById("c-windv")?.textContent, day: document.getElementById("clock")?.textContent }));
console.log("filming at", JSON.stringify(info));
await p.evaluate((s) => { window.__helm.cine.start(s); }, seq);
const n = Math.round(Number(secs) * FPS);
const boxes = [];
for (let i = 0; i < n; i++) {
  await p.evaluate((dt) => window.__tick(dt), 1 / FPS);
  // SHEET_ONLY=1 keeps just the twelve stills the contact sheet uses (one every 5 s of film), for a job log that can't hold more.
  if (!process.env.SHEET_ONLY || i % 40 === 4) await p.screenshot({ path: `${dir}/f${String(i).padStart(5, "0")}.jpg`, type: "jpeg", quality: 85 });
  boxes.push(await p.evaluate(() => ({ box: window.__helm.boatBox(), shot: window.__helm.cine.current })));
}
(await import("node:fs")).writeFileSync(`${dir}.boxes.json`, JSON.stringify(boxes));
(await import("node:fs")).writeFileSync(`${dir}.info.json`, JSON.stringify({ boat, seq, when, base: BASE, ...info, ...(await p.evaluate(() => ({ seqs: window.__helm.cine.sequences, log: window.__helm.cine.log }))) }));
console.log(boat, seq, when, JSON.stringify(await p.evaluate(() => ({ seqs: window.__helm.cine.sequences, log: window.__helm.cine.log }))));
await b.close();
