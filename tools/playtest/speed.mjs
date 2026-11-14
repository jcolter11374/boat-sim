// The speed baseline (Omar, 14 Nov): what a fresh visitor downloads and waits for on each
// page of the DEPLOYED site, and what the sailing screen costs per frame. Run as the manual
// playtest check "speed" (playtest.yml, checks="speed"); the numbers print to the job log as
// JSON between SPEED-BEGIN and SPEED-END (one block per browser).
//
// A runner draws in software (SwiftShader, Mesa): frame times here compare one commit with
// another on the same runner kind, and say nothing about a real graphics card. Sizes, request
// counts, draw calls and triangles are exact anywhere.
//
// Read-only: it only visits the public site.

import { T } from "./pace.mjs";

const MIN = 60_000;

/** Runs before any page script: counts frames, long tasks and WebGL draws. */
function probe() {
  const s = (window.__spd = { dts: [], long: [], draws: [], tris: [], d: 0, t: 0, marks: {}, msgs: [] });
  s.reset = () => { s.dts.length = 0; s.long.length = 0; s.draws.length = 0; s.tris.length = 0; };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) s.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true });
  } catch { /* Firefox has no longtask: its stutters show in the frame gaps */ }
  let last = 0;
  const tick = (now) => {
    if (last) { if (s.dts.length < 20000) s.dts.push(now - last); if (s.draws.length < 20000) { s.draws.push(s.d); s.tris.push(s.t); } }
    last = now; s.d = 0; s.t = 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const tri = (mode, n) => (mode === 4 ? n / 3 : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0);
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    const p = C?.prototype;
    if (!p) continue;
    const wrap = (name, count, inst) => {
      const f = p[name];
      if (!f) return;
      p[name] = function (...a) { s.d++; s.t += tri(a[0], a[count]) * (inst === undefined ? 1 : a[inst]); return f.apply(this, a); };
    };
    wrap("drawArrays", 2); wrap("drawElements", 1); wrap("drawArraysInstanced", 2, 3); wrap("drawElementsInstanced", 1, 4);
  }
  // What the start box says while the simulator loads, with when it said it.
  addEventListener("DOMContentLoaded", () => {
    const m = document.getElementById("startmsg");
    if (m) new MutationObserver(() => { if (s.msgs.length < 200) s.msgs.push([Math.round(performance.now()), m.textContent.slice(0, 80)]); }).observe(m, { childList: true, characterData: true, subtree: true });
  });
}

const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

/** A fresh browser profile on `path`, with every download counted. */
async function fresh(browser, site, path, more = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block", ...more });
  const page = await ctx.newPage();
  await page.addInitScript(probe);
  const net = { files: [], inflight: 0, last: Date.now(), t0: Date.now(), errors: [] };
  page.on("pageerror", (e) => net.errors.push(String(e.message).slice(0, 160)));
  page.on("request", () => { net.inflight++; net.last = Date.now(); });
  const done = async (req, failed) => {
    net.inflight--; net.last = Date.now();
    if (failed) return;
    let bytes = 0;
    let body = 0;
    try { const z = await req.sizes(); bytes = z.responseBodySize + z.responseHeadersSize; body = z.responseBodySize; } catch { /* a request the browser dropped */ }
    const resp = await req.response().catch(() => null);
    net.files.push({ url: req.url(), bytes, body, type: req.resourceType(), at: Date.now() - net.t0, status: resp?.status() ?? 0 });
  };
  page.on("requestfinished", (r) => void done(r, false));
  page.on("requestfailed", (r) => void done(r, true));
  // Chrome can say what really crossed the wire (nothing, for a file it already had): the
  // sizes above count a file again when it comes from the browser's cache.
  net.wire = null;
  if (browser.browserType().name() === "chromium") {
    net.wire = { bytes: 0, cached: 0, at: [] };
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.loadingFinished", (e) => { net.wire.bytes += e.encodedDataLength; net.wire.at.push([Date.now() - net.t0, e.encodedDataLength]); });
    cdp.on("Network.requestServedFromCache", () => net.wire.cached++);
  }
  net.t0 = Date.now();
  await page.goto(site + path, { waitUntil: "commit", timeout: 2 * MIN });
  return { ctx, page, net };
}

/** Wait until nothing has been downloading for `quietMs` (or `capMs` has passed). */
async function quiet(page, net, quietMs = 4000, capMs = 90_000) {
  const end = Date.now() + capMs;
  while (Date.now() < end && !(net.inflight <= 0 && Date.now() - net.last > quietMs)) await page.waitForTimeout(250);
  return Date.now() < end;
}

/** The downloads so far: the total, by kind, and the biggest files. */
function weigh(net, site, upTo = Infinity) {
  const files = net.files.filter((f) => f.at <= upTo && !f.url.startsWith("data:") && !f.url.startsWith("blob:"));
  const short = (u) => (u.startsWith(site) ? u.slice(site.length) : u.replace(/^https:\/\//, "")).replace(/\?.*$/, "");
  const kind = (f) => {
    const u = f.url;
    if (/pyodide/.test(u)) return "python (Pyodide)";
    if (/boatsim\.zip|forcing_|\.npz/.test(u)) return "simulator and weather";
    if (/\.(glb|gltf|bin)(\?|$)/.test(u)) return "3D models";
    if (/\.(hdr|exr|ktx2)(\?|$)/.test(u)) return "sky and light maps";
    if (/\.(png|jpe?g|webp|avif|svg)(\?|$)/.test(u)) return "pictures";
    if (/\.(mp3|ogg|wav|m4a|opus)(\?|$)/.test(u)) return "sound";
    if (/\.(woff2?|ttf)(\?|$)/.test(u)) return "fonts";
    if (/\.(m?js)(\?|$)/.test(u)) return "code";
    if (/\.json(\?|$)/.test(u)) return "data (json)";
    if (/\.css(\?|$)/.test(u) || f.type === "document") return "page";
    return "other";
  };
  const by = {};
  for (const f of files) by[kind(f)] = (by[kind(f)] ?? 0) + f.bytes;
  return {
    // Chrome only: bytes that crossed the wire for the page itself (its workers' downloads are not in this count), and files served from its cache.
    wireKB: net.wire ? Math.round(net.wire.at.filter((w) => w[0] <= upTo).reduce((a, w) => a + w[1], 0) / 1024) : null,
    fromCache: net.wire ? net.wire.cached : null,
    requests: files.length,
    kB: Math.round(files.reduce((a, f) => a + f.bytes, 0) / 1024),
    byKind: Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v / 1024)])),
    biggest: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 15).map((f) => [short(f.url), Math.round(f.bytes / 1024), Math.round(f.at)]),
  };
}

const now = (page) => page.evaluate(() => Math.round(performance.now()));
/** The page's own clock (ms since it began to load) when `cond` first holds. */
async function when(page, cond, arg, timeout = 3 * MIN) {
  await page.waitForFunction(cond, arg, { timeout, polling: 50 });
  return now(page);
}

/** Frames, stutters, long tasks and draws over the next `ms`. */
async function watch(page, ms) {
  await page.evaluate(() => window.__spd.reset());
  await page.waitForTimeout(ms);
  const s = await page.evaluate(() => { const s = window.__spd; return { dts: s.dts.slice(), long: s.long.slice(), draws: s.draws.slice(), tris: s.tris.slice() }; });
  const drawn = s.draws.map((d, i) => [d, s.tris[i]]).filter(([d]) => d > 0);
  return {
    frames: s.dts.length,
    frameMs: { median: r1(pct(s.dts, 50)), p95: r1(pct(s.dts, 95)), worst: r1(Math.max(0, ...s.dts)) },
    // A stutter: a frame that took more than twice the median and at least 50 ms.
    stutters: s.dts.filter((d) => d > 50 && d > 2 * pct(s.dts, 50)).length,
    longTasks: { count: s.long.length, totalMs: s.long.reduce((a, l) => a + l[1], 0), worstMs: Math.max(0, ...s.long.map((l) => l[1])) },
    drawCalls: { median: pct(drawn.map((d) => d[0]), 50), worst: Math.max(0, ...drawn.map((d) => d[0])) },
    triangles: { median: Math.round(pct(drawn.map((d) => d[1]), 50) ?? 0), worst: Math.round(Math.max(0, ...drawn.map((d) => d[1]))) },
  };
}

/** Chrome only: where the main thread's time goes for `ms` (a sampled CPU profile, by function). */
async function profile(page, ms) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  await cdp.send("Profiler.start");
  await page.waitForTimeout(ms);
  const { profile: p } = await cdp.send("Profiler.stop");
  await cdp.detach().catch(() => {});
  const self = new Map();
  const dt = p.timeDeltas ?? [];
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  let total = 0;
  (p.samples ?? []).forEach((id, i) => {
    const n = byId.get(id);
    const us = dt[i] ?? 0;
    total += us;
    if (!n) return;
    const f = n.callFrame;
    const key = `${f.functionName || "(anonymous)"} @ ${(f.url || "").replace(/^.*\//, "").replace(/\?.*$/, "") || "browser"}`;
    self.set(key, (self.get(key) ?? 0) + us);
  });
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, us]) => [k, r1((100 * us) / (total || 1))]);
  return { ms: Math.round(total / 1000), topSelfPercent: top };
}

export async function speedCheck(browser, { SITE, BROWSER }) {
  const out = { browser: BROWSER, site: SITE, at: new Date().toISOString(), pages: {} };

  // 1. The title: first frame of the sea, the menu, and what a visit downloads (the helm's
  //    simulator is fetched behind the title, so the weight is given before and after that).
  {
    const { ctx, page, net } = await fresh(browser, SITE, "");
    const first = await when(page, () => window.__sea3d && window.__sea3d.frames >= 1);
    const firstAt = Date.now() - net.t0;
    const twenty = await when(page, () => window.__sea3d.frames > 20);
    const paint = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType("paint").map((e) => [e.name, Math.round(e.startTime)])));
    const sea = await watch(page, 15_000);
    const idle = await quiet(page, net, 5000, 2 * MIN);
    out.pages.title = { firstSeaFrameMs: first, twentyFramesMs: twenty, paint, sea, toFirstFrame: weigh(net, SITE, firstAt), whole: weigh(net, SITE), wentQuiet: idle, errors: net.errors };
    await ctx.close();
  }

  // 2. The sailing screen, opened cold (no title first): the card, Set sail, the simulator, then sailing.
  {
    const { ctx, page, net } = await fresh(browser, SITE, "helm.html");
    const card = await when(page, () => window.__helm && window.__helm.frames > 2 && !document.getElementById("go")?.disabled);
    const cardAt = Date.now() - net.t0;
    const model = await when(page, () => window.__helm.frames > 20);
    const cardLook = await watch(page, 8000);
    await page.evaluate(() => { const d = document.getElementById("more"); if (d) d.open = true; });
    const pressed = await now(page);
    const pressedAt = Date.now() - net.t0;
    await page.click("#go", { noWaitAfter: true, timeout: T(30_000) });
    const ready = await when(page, () => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, Number(process.env.SPEED_SIM_MS) || 8 * MIN).catch(() => -1);
    const readyAt = Date.now() - net.t0;
    const st = await page.evaluate((late) => ({ err: late ? "the simulator did not start in time" : window.__helm.error, quality: window.__helm.quality, msgs: window.__spd.msgs }), ready < 0);
    const h = { setSailReadyMs: card, twentyFramesMs: model, card: cardLook, simulatorStartMs: ready - pressed, startMessages: st.msgs.filter((m) => m[0] >= pressed).map((m) => [m[0] - pressed, m[1]]), quality: st.quality, error: st.err || "",
      toCard: weigh(net, SITE, cardAt), simulatorDownloads: null, whole: null, errors: net.errors };
    if (!st.err) {
      // Real time first, then 6 h a second: the two a player spends longest in.
      await page.evaluate(() => document.querySelector('#timebar .rate[data-rate="rt"]')?.click());
      await page.evaluate(() => { if (!(window.__helm.clock > 0)) document.getElementById("t-pause")?.click(); });
      await page.waitForTimeout(3000);
      h.sailingRealTime = await watch(page, 30_000);
      await page.evaluate(() => document.querySelector('#timebar .rate[data-rate="6"]')?.click());
      await page.evaluate(() => { if (!(window.__helm.clock > 0)) document.getElementById("t-pause")?.click(); });
      await page.waitForTimeout(2000);
      h.sailingSixHours = await watch(page, 30_000);
      if (BROWSER === "chromium") {
        await page.evaluate(() => document.querySelector('#timebar .rate[data-rate="rt"]')?.click());
        await page.evaluate(() => { if (!(window.__helm.clock > 0)) document.getElementById("t-pause")?.click(); });
        h.cpuRealTime = await profile(page, 15_000).catch((e) => ({ error: String(e.message).slice(0, 120) }));
        await page.evaluate(() => document.querySelector('#timebar .rate[data-rate="6"]')?.click());
        await page.evaluate(() => { if (!(window.__helm.clock > 0)) document.getElementById("t-pause")?.click(); });
        h.cpuSixHours = await profile(page, 15_000).catch((e) => ({ error: String(e.message).slice(0, 120) }));
      }
      h.dayReached = await page.evaluate(() => window.__helm.status?.day ?? null);
    }
    const all = { ...net, wire: null, files: net.files.filter((f) => f.at > pressedAt && f.at <= readyAt) };
    h.simulatorDownloads = weigh(all, SITE);
    h.whole = weigh(net, SITE);
    out.pages.helm = h;
    await ctx.close();
  }

  // 2b. Title to sailing, as a visitor does it: `linger` ms on the title, then Set sail there,
  //     then Set sail on the card. What the title had downloaded when they left it, and how long
  //     from leaving the title to sailing. (Before the prefetch waited for intent, the title
  //     fetched the simulator on every visit: this is what that bought, and what it cost.)
  out.journeys = {};
  // A phone is a touch screen with no mouse; only Chrome can pretend to be one here.
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const trips = [["quick", 1500, {}], ["lingering", 20_000, {}], ["never sails (30 s)", 30_000, {}]];
  if (BROWSER === "chromium") trips.push(["phone, quick", 1500, phone], ["phone, never sails (30 s)", 30_000, phone]);
  for (const [name, linger, more] of trips) {
    const { ctx, page, net } = await fresh(browser, SITE, "", more);
    try {
      await when(page, () => window.__sea3d && window.__sea3d.frames >= 3);
      await page.waitForTimeout(linger);
      const j = { lingerMs: linger, titleKB: weigh(net, SITE).kB, titleWireKB: weigh(net, SITE).wireKB };
      if (!/never/.test(name)) {
        const left = Date.now();
        await (more.hasTouch ? page.tap("#t-setsail", { noWaitAfter: true, timeout: T(30_000) }) : page.click("#t-setsail", { noWaitAfter: true, timeout: T(30_000) }));
        await page.waitForFunction(() => /helm\.html/.test(location.pathname) && window.__helm && window.__helm.frames > 2 && !document.getElementById("go")?.disabled, null, { timeout: 3 * MIN, polling: 50 });
        j.toCardMs = Date.now() - left;
        await page.click("#go", { noWaitAfter: true, timeout: T(30_000) });
        const ok = await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: Number(process.env.SPEED_SIM_MS) || 8 * MIN, polling: 50 }).then(() => true).catch(() => false);
        j.toSailingMs = ok ? Date.now() - left : null;
        j.error = await page.evaluate(() => window.__helm.error || "");
        j.wholeKB = weigh(net, SITE).kB;
        j.wholeWireKB = weigh(net, SITE).wireKB;
        j.fromCache = weigh(net, SITE).fromCache;
      }
      out.journeys[name] = j;
    } catch (e) {
      out.journeys[name] = { error: String(e.message).split("\n")[0].slice(0, 160) };
    }
    await ctx.close();
  }

  // 3. The other pages: when each is ready, and what it downloads.
  const others = [
    ["voyage", "voyage.html", () => window.__replay && (window.__replay.ready || window.__replay.error)],
    ["boatyard", "boatyard.html", () => !!window.__yard],
    ["race", "race.html", () => document.readyState === "complete"],
    ["leaderboard", "leaderboard.html", () => window.__leaderboard?.ready],
  ];
  for (const [name, path, cond] of others) {
    const { ctx, page, net } = await fresh(browser, SITE, path);
    let ready = null;
    try { ready = await when(page, cond, null, 2 * MIN); } catch { /* reported as null */ }
    const idle = await quiet(page, net, 4000, 90_000);
    const look = await watch(page, 6000);
    out.pages[name] = { readyMs: ready, look, whole: weigh(net, SITE), wentQuiet: idle, errors: net.errors };
    await ctx.close();
  }

  const json = JSON.stringify(out);
  console.log(`SPEED-BEGIN ${BROWSER}`);
  for (let i = 0; i < json.length; i += 4000) console.log(json.slice(i, i + 4000));
  console.log(`SPEED-END ${BROWSER}`);
  const t = out.pages.title;
  const h = out.pages.helm;
  return `title: first sea frame ${t.firstSeaFrameMs} ms, ${t.toFirstFrame.kB} kB by then, ${t.whole.kB} kB in all; helm: Set sail ready ${h.setSailReadyMs} ms (${h.toCard.kB} kB), simulator start ${h.simulatorStartMs} ms${h.error ? ` (error: ${h.error})` : ""}, sailing in real time ${h.sailingRealTime?.frameMs.median} ms a frame, ${h.sailingRealTime?.drawCalls.median} draw calls, ${h.sailingRealTime?.triangles.median} triangles, ${h.sailingRealTime?.longTasks.count} long tasks in 30 s; ` +
    others.map(([n]) => `${n} ${out.pages[n].readyMs} ms, ${out.pages[n].whole.kB} kB`).join("; ") +
    "; journeys: " + Object.entries(out.journeys).map(([n, j]) => `${n}: title ${j.titleKB} kB${j.toSailingMs !== undefined ? `, to sailing ${j.toSailingMs} ms` : ""}${j.error ? ` (${j.error})` : ""}`).join("; ");
}
