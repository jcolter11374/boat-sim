// Frame-time budget: median frame time per quality and scene, for comparing
// builds (QA, 12 Nov). Based on Kai's sky/tools/fps.mjs.
//   node tests/fps_budget.mjs <site-url> [runs=3] [label] [qualities=low,high]
// Scenes: a clear hour (30) and a rainy hour (431) of the 1 April voyage.
// SwiftShader single runs swing about 15%, so each cell is the median of `runs`.
import { chromium } from "playwright";

const [site, runsArg = "3", label = site, qArg = "low,high"] = process.argv.slice(2);
const RUNS = Number(runsArg);
const SCENES = { clear: 30, rain: 431 };
const QUALITIES = qArg.split(",").filter((q) => q === "low" || q === "high");

async function once(quality, hour) {
  const b = await chromium.launch({ args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
  try {
    const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await p.goto(`${site}voyage.html?quality=${quality}&bar=0`, { timeout: 180000 });
    await p.waitForFunction(() => window.__replay, null, { timeout: 180000 });
    await p.evaluate((h) => { window.__replay.pause(); window.__replay.setHour(h); }, hour);
    await p.waitForTimeout(5000);
    return await p.evaluate(() => new Promise((res) => {
      let n = 0; const t0 = performance.now();
      const f = () => { n++; if (performance.now() - t0 < 8000) requestAnimationFrame(f); else res((performance.now() - t0) / n); };
      requestAnimationFrame(f);
    }));
  } finally {
    await b.close();
  }
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const out = { label, runs: RUNS, cells: {} };
for (const q of QUALITIES)
  for (const [scene, hour] of Object.entries(SCENES)) {
    const ms = [];
    for (let i = 0; i < RUNS; i++) ms.push(await once(q, hour));
    out.cells[`${q}/${scene}`] = { median_ms: Math.round(median(ms)), runs_ms: ms.map(Math.round) };
    console.error(label, q, scene, ms.map(Math.round).join(" "));
  }
console.log(JSON.stringify(out));
