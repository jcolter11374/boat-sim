import { writeFile } from "node:fs/promises";

// Visual checks for the live-site test (Iris, for Ravi). What "working" looks like
// on each 3D page, as assertions a Playwright run can make against the live site.
//
// Usage (Playwright, any viewport; tuned at 960x540 on software graphics):
//   import { checkPage, PAGES } from "./live-visual-checks.mjs";
//   for (const p of PAGES) {
//     const problems = await checkPage(page, BASE_URL, p);   // [] when working
//     ...
//   }
//
// Each page is judged three ways:
// 1. It draws: the page's own frame counter climbs, and no page errors.
// 2. The picture is right, from the 3D canvas's own pixels (the panels are hidden
//    for the screenshot so they can't hide a fault or fake a pass):
//    - not blank: the picture varies (a dead WebGL canvas is one flat colour);
//    - no black holes: under 2% pure black pixels (a shader that fails or a NaN
//      in the sea paints black);
//    - no missing-texture magenta: under 0.5%;
//    - the sky isn't blank: the top fifth isn't pure black or pure white, and has
//      some structure or a sky colour;
//    - the sea is there: the bottom fifth is mostly blue-ish (blue above red);
//    - the boat is visible: our kayak's orange hull, at least 0.1% of the picture.
//      (Measured 0.3% to 1.7%. The test uses the default boat on every page.)
// 3. The main button responds: clicking it changes the page's state within 15 s.
//
// Thresholds have about 3x headroom over what healthy pages measure (see the
// numbers in live-visual-checks.md), and each check fails when it should: tested
// by turning the canvas black (blank, black holes) and grey (no boat, no sea).

/** Pixel statistics of the 3D (largest) canvas, panels hidden. */
export async function pixels(page) {
  await page.evaluate(() => {
    // The 3D view: the canvas covering the most of the window. Not the one with the most
    // pixels: on software graphics the 3D canvas draws at half resolution, and the voyage
    // page's chart (a 2D canvas) can then hold more pixels than it, so the check measured
    // the chart and found no boat (#298).
    const area = (c) => { const r = c.getBoundingClientRect(); return Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)); };
    const big = [...document.querySelectorAll("canvas")].sort((a, b) => area(b) - area(a))[0];
    if (big) big.dataset.livecheck = "1";
    // For the failure report (#298): every canvas, and which one we judged.
    window.__livecheckCanvases = [...document.querySelectorAll("canvas")].map((c) => {
      const r = c.getBoundingClientRect();
      return `${c === big ? "*" : ""}${c.id || c.parentElement?.id || "canvas"} ${Math.round(r.width)}x${Math.round(r.height)}css/${c.width}x${c.height}px`;
    });
    const s = document.createElement("style");
    s.id = "livecheck-hide";
    s.textContent = "*{visibility:hidden!important;backdrop-filter:none!important} canvas[data-livecheck]{visibility:visible!important}";
    document.head.appendChild(s);
  });
  let png;
  try {
    png = await page.screenshot();
  } finally {
    await page.evaluate(() => document.getElementById("livecheck-hide")?.remove());
  }
  const stats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const W = img.width, H = img.height;
    const g = new OffscreenCanvas(W, H).getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    const region = (y0, y1) => {
      let n = 0, s = 0, s2 = 0, black = 0, white = 0, magenta = 0, blue = 0, warm = 0;
      // "Warm-ish" (a looser orange) for the failure report: how much, where, and what colour.
      let wn = 0, wr = 0, wg = 0, wb = 0, x0 = W, x1 = -1, y0b = H, y1b = -1, sx = 0, sy = 0, sxx = 0, syy = 0;
      for (let y = Math.floor(y0 * H); y < y1 * H; y += 2)
        for (let x = 0; x < W; x += 2) {
          const i = (y * W + x) * 4, r = d[i], gr = d[i + 1], b = d[i + 2];
          const l = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
          n++; s += l; s2 += l * l;
          if (r + gr + b < 6) black++;
          if (r > 250 && gr > 250 && b > 250) white++;
          if (r > 200 && b > 200 && gr < 60) magenta++;
          if (b > r + 10) blue++;
          if (r > b + 60 && r > gr + 20) warm++; // the kayak's orange hull
          if (r > b + 25 && r > gr + 8) {
            wn++; wr += r; wg += gr; wb += b; sx += x; sy += y; sxx += x * x; syy += y * y;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0b) y0b = y; if (y > y1b) y1b = y;
          }
        }
      const mean = s / n;
      // density: how much of the warm-ish box is warm-ish (samples are every 2nd pixel each way).
      const warmish = wn ? { share: wn / n, rgb: [wr, wg, wb].map((v) => Math.round(v / wn)), box: [x0, y0b, x1, y1b],
        density: wn / (((x1 - x0) / 2 + 1) * ((y1b - y0b) / 2 + 1)),
        // spread: root-mean-square distance (px) of the warm-ish pixels from their centre. Unlike
        // the box, one stray glint far away barely moves it.
        spread: Math.sqrt(Math.max(0, sxx / wn - (sx / wn) ** 2 + syy / wn - (sy / wn) ** 2)) } : { share: 0, density: 0, spread: Infinity };
      return { mean, sd: Math.sqrt(Math.max(0, s2 / n - mean * mean)), black: black / n, white: white / n, magenta: magenta / n, blue: blue / n, warm: warm / n, warmish };
    };
    return { all: region(0, 1), sky: region(0, 0.2), sea: region(0.8, 1), size: [W, H] };
  }, png.toString("base64"));
  stats.canvases = await page.evaluate(() => window.__livecheckCanvases ?? []);
  stats.png = png;
  return stats;
}

/** One line on what the judged picture held, for a failure report (#298). */
export function describe(px) {
  const w = px.all.warmish;
  const f = (v) => v.toFixed(4);
  return `[picture ${px.size?.join("x")}, canvases ${px.canvases?.join(", ")}; orange ${f(px.all.warm)}, warm-ish ${f(w.share)}` +
    (w.share ? ` rgb(${w.rgb.join(",")}) in box ${w.box.join(",")}, density ${w.density.toFixed(2)}, spread ${w.spread.toFixed(0)} px` : "") +
    `; mean brightness ${px.all.mean.toFixed(0)}, sky ${px.sky.mean.toFixed(0)}, sea blue ${f(px.sea.blue)}]`;
}

/**
 * Is the boat in the picture? Either plenty of strict orange (the hull in good light),
 * or a compact patch of warm-ish colour: Firefox's software graphics draw the voyage
 * hull paler and pinker (rgb 168,122,104 against Chromium's 148,82,57, #298), which
 * misses strict orange. "Compact" (a small box, mostly filled) keeps a warm sunset sky
 * or scattered glints from passing for a boat. Healthy: Chromium voyage warm-ish 0.0032
 * at density 0.59; Firefox 0.0009 at 0.31.
 *
 * "Compact" is judged by spread (how far the warm-ish pixels sit from their centre), with
 * a loose density floor: the old rule (density >= 0.15 in a box <= 30% of the picture)
 * failed a real Firefox boat at density 0.13 (warm-ish 0.0008 in a 36x80 px box at
 * 960x540, #336), a coin flip on PRs that touch no page. That boat's spread is about
 * 25 px; the limit is 6% of the picture width (58 px at 960), so about 2x margin either
 * way, while a sunset sky or glints across the sea spread over hundreds of pixels.
 */
export function boatInView(px) {
  const a = px.all, w = a.warmish;
  if (a.warm >= 0.001) return true;
  if (!w || !(w.share >= 0.0004) || !(w.density >= 0.06) || !px.size) return false;
  const [W, H] = px.size;
  return w.spread <= 0.06 * W && w.box[2] - w.box[0] <= 0.5 * W && w.box[3] - w.box[1] <= 0.5 * H;
}

/** What's wrong with these pixel statistics ([] = looks right). */
export function judge(px, { boat = true } = {}) {
  const bad = [];
  const f = (v) => v.toFixed(3);
  if (px.all.sd < 8) bad.push(`blank picture (brightness varies by only ${px.all.sd.toFixed(1)})`);
  if (px.all.black > 0.02) bad.push(`black holes: ${f(px.all.black)} of the picture is pure black`);
  if (px.all.magenta > 0.005) bad.push(`missing textures: ${f(px.all.magenta)} magenta`);
  if (px.sky.black > 0.5) bad.push("blank sky: black");
  if (px.sky.white > 0.5) bad.push("blank sky: white");
  if (px.sky.sd < 1.5 && px.sky.blue < 0.1) bad.push(`blank sky: flat (sd ${px.sky.sd.toFixed(1)}) and not sky-coloured`);
  if (px.sea.blue < 0.5) bad.push(`no sea: only ${f(px.sea.blue)} of the bottom is blue`);
  if (boat && !boatInView(px)) bad.push(`no boat in view: ${f(px.all.warm)} orange`);
  return bad;
}

/** The 3D pages and what "working" means on each. */
export const PAGES = [
  {
    name: "sea (index)",
    path: "?quality=low",
    drawing: () => (window.__sea3d?.frames ?? 0) > 10,
    frames: () => window.__sea3d.frames,
    // The sea selector rebuilds the sea at the new wave height.
    // The title screen (if this deploy has one) hides the sea panel until "Just watch the sea".
    act: async (page, o) => {
      if (await page.locator("#t-sea").isVisible()) await page.click("#t-sea", o);
      return page.selectOption("#sea", "gale", o);
    },
    responded: () => Math.abs(window.__sea3d.hs - 5) < 1e-6,
  },
  {
    name: "voyage replay",
    path: "voyage.html?quality=low",
    drawing: () => window.__replay?.ready && window.__replay.frames > 10 && !window.__replay.error,
    frames: () => window.__replay.frames,
    // Play/pause toggles playing.
    act: async (page, o) => page.click("#play", o),
    before: () => window.__replay.playing,
    responded: (was) => window.__replay.playing !== was,
  },
  {
    name: "helm",
    path: "helm.html?quality=low",
    drawing: () => (window.__helm?.frames ?? 0) > 10,
    frames: () => window.__helm.frames,
    // "Take the helm": the game starts loading (busy), starts, or says why not.
    act: async (page, o) => page.click("#go", o),
    responded: () => window.__helm.busy || window.__helm.ready || !!window.__helm.error || document.getElementById("startmsg").textContent.trim() !== "",
    // After it starts (the simulator takes up to a few minutes to load), it must be ready, not an error.
    finished: () => (window.__helm.ready && !window.__helm.busy) || !!window.__helm.error,
    ok: () => window.__helm.ready && !window.__helm.error,
  },
  {
    name: "boatyard",
    path: "boatyard.html?quality=low",
    drawing: () => window.__yard?.ready && window.__yard.frames > 10 && !window.__yard.error,
    frames: () => window.__yard.frames,
    // A part swap changes the totals and the share link.
    act: async (page, o) => {
      // Slots are one line each until opened (Boatyard M5).
      // Sections fold as well (Elena): open Power first, if this build has folding sections.
      const power = page.locator('.slot[data-group="Power"] h3');
      if ((await power.count()) && (await power.getAttribute("aria-expanded")) !== "true") await power.click(o);
      if ((await page.locator('.sl-head[data-slot="bat"]').getAttribute("aria-expanded")) !== "true") await page.locator('.sl-head[data-slot="bat"]').click(o);
      return page.locator('.opt[data-slot="bat"][data-opt="two-100ah"]').click(o);
    },
    responded: () => window.__yard.share.includes("bat=two-100ah"),
  },
  {
    name: "race",
    path: "race.html",
    canvas: false, // a chart page until the race starts; its 3D views are checked after
    drawing: () => !!window.__race,
    act: async (page, o) => page.click("#go", o),
    responded: () => window.__race.busy || window.__race.ready || !!window.__race.error,
    finished: () => window.__race.ready || !!window.__race.error,
    ok: () => window.__race.ready && !window.__race.error,
    // Then sail a day: both 3D views draw, each with its boat.
    after: async (page) => {
      await page.click("#day");
      await page.waitForFunction(() => !window.__race.busy, null, { timeout: 240000 });
      await page.locator("#views").scrollIntoViewIfNeeded();
      return page
        .waitForFunction(() => window.__race.views.length === 2 && window.__race.views.every((v) => v.frames > 3 && v.boat), null, { timeout: 60000 })
        .then(() => [], async () => [`race 3D views not drawing: ${await page.evaluate(() => JSON.stringify(window.__race.views))}`]);
    },
  },
];

/** Run every check on one page. Returns a list of problems ([] = working). */
export async function checkPage(page, base, p, { readyMs = 120000, startMs = 300000, shots = true } = {}) {
  const problems = [];
  const errors = [];
  const onErr = (e) => errors.push(String(e));
  page.on("pageerror", onErr);
  try {
    await page.goto(base + p.path);
    try {
      await page.waitForFunction(p.drawing, null, { timeout: readyMs });
    } catch {
      problems.push("never started drawing");
      return problems;
    }
    if (p.frames) {
      const f0 = await page.evaluate(p.frames);
      await page.waitForTimeout(3000);
      if (!((await page.evaluate(p.frames)) > f0)) problems.push("the picture froze (no new frames in 3 s)");
    }
    if (p.canvas !== false) {
      const px = await pixels(page);
      // The exact picture judged, panels hidden (uploaded with the gate's live-*.png).
      if (shots) await writeFile(`live-judged-${p.name.replace(/\W+/g, "-")}.png`, px.png).catch(() => {});
      const bad = judge(px);
      if (bad.length) bad.push(describe(px));
      problems.push(...bad);
    }
    const was = p.before ? await page.evaluate(p.before) : undefined;
    try {
      await p.act(page, { timeout: 15000 });
    } catch (e) {
      problems.push(`couldn't use the main control: ${String(e.message).split("\n")[0]}`);
      return problems;
    }
    try {
      await page.waitForFunction(p.responded, was, { timeout: 15000 });
    } catch {
      problems.push("the main control did nothing within 15 s");
    }
    if (p.finished) {
      await page.waitForFunction(p.finished, null, { timeout: startMs }).catch(() => {});
      if (!(await page.evaluate(p.ok))) problems.push(`didn't start: ${await page.evaluate(() => JSON.stringify(window.__helm?.error ?? window.__race?.error ?? null))}`);
      else if (p.after) problems.push(...(await p.after(page)));
    }
    if (errors.length) problems.push(`page errors: ${errors.join("; ")}`);
    return problems;
  } finally {
    page.off("pageerror", onErr);
  }
}
