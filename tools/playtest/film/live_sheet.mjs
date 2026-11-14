// Deterministic film frames: the page's clock steps 1/FPS a frame, so pacing is true to life.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
// One film sequence at a real moment of a voyage, nothing forced (John's C4), for the M5 contact sheet.
// usage: BASE=https://.../boat-sim/ node live_sheet.mjs <boat> <sequence> <when> <outdir> [secs=60] [fps=8]
//   when: "day" (some hours out, by day), "golden" (sun 1-6 deg up), "night" (sun under -12 deg),
//         "hour:<h>" (that voyage hour), "after-knockdown" (just after the first knockdown the voyage records)
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
// Sail on (6 h a second, then 1 h a second near the moment) until the voyage itself reaches the moment wanted.
const want = when.startsWith("hour:") ? Number(when.slice(5)) : null;
await p.click(`button.rate[data-rate="${when === "day" ? 1 : 6}"]`);
const t0 = Date.now();
let slow = when === "day";
for (;;) {
  const st = await p.evaluate(() => { const h = window.__helm; const d = document.getElementById("decide"); if (d && !d.hidden) d.querySelector("#decidebtns button")?.click(); if (h.clock === 0 && !h.busy && !h.card) document.getElementById("t-pause")?.click(); return { hour: h.hour, over: !!h.status?.over, el: h.cine.host.sunEl(), kn: h.cine.host.speed(), k: h.knockdown()?.start ?? null, wind: document.getElementById("c-windv")?.textContent }; });
  if (st.over || Date.now() - t0 > 25 * 60e3) { console.log("NEVER REACHED THE MOMENT:", JSON.stringify(st)); process.exit(3); }
  if (want != null && !slow && st.hour >= want - 9) { slow = true; await p.click('button.rate[data-rate="1"]'); }
  const there = when === "day" ? st.hour >= 7 && st.el > 15 : when === "golden" ? st.hour > 6 && st.el > 1 && st.el < 6 : when === "night" ? st.hour > 6 && st.el < -12 : when === "after-knockdown" ? st.k != null : st.hour >= want;
  if (there && st.kn > 0.3) { console.log("moment:", JSON.stringify(st)); break; }
  await p.waitForTimeout(slow ? 60 : 150);
}
await p.evaluate(() => window.__helm.clock !== 0 && document.getElementById("t-pause")?.click());
// The clock is stopped first, so the voyage stays at the knockdown's hour; then let the knockdown's own camera move finish before the film starts.
if (when === "after-knockdown") await p.waitForFunction(() => !window.__helm.knockCut(), null, { timeout: 120000 });
await p.waitForTimeout(3000);
await p.evaluate(() => window.__virtual());
await p.evaluate(() => { for (let k = 0; k < 40; k++) window.__tick(0.05); });
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
