// Close-up pictures of a Boatyard boat, panels hidden, for judging how a model looks.
//   node tools/qa/boat-look.mjs [base ...]     bases: kayak revc revb stock_pearson31_2 stock_cruiser31
// SITE (default http://localhost:5173/, an `npm run dev` server), OUT (file prefix, default "look"),
// SHOTS (side,quarter,bow,above: which to take), ZOOM (wheel clicks in, default 7), QUALITY (high or low),
// VIEW=lifted (out of the water, to see keel and rudders), PAINT (a paint scheme's id, such as navy).
// A cloud browser has no graphics card: left alone the pages then draw at 0.6 of full size with edge
// smoothing off, and every boat looks jagged. "?gl=full" asks for the picture a real card draws
// (slow, but right), so pictures taken here match what a player sees. See docs/qa/boat-look-2026-11.md.
import * as pw from "playwright";
const SITE = process.env.SITE ?? "http://localhost:5173/";
const OUT = process.env.OUT ?? "look";
const bases = process.argv.slice(2).length ? process.argv.slice(2) : ["revc", "kayak"];
// Each shot: wheel clicks towards the boat, then a drag (px) that swings the camera round her.
const SHOTS = { side: [0, 0], quarter: [260, -40], bow: [-420, -60], above: [200, 150] };
/** Wait for the page to draw n more frames (software drawing manages only a few a second). */
async function frames(p, n) {
  const f0 = await p.evaluate(() => window.__yard.frames);
  await p.waitForFunction(([f, k]) => window.__yard.frames >= f + k, [f0, n], { timeout: 300000 });
}
const b = await pw.chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const base of bases) {
  for (const [shot, [dx, dy]] of Object.entries(SHOTS)) {
    if (process.env.SHOTS && !process.env.SHOTS.split(",").includes(shot)) continue;
    const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await p.goto(`${SITE}boatyard.html?gl=full&quality=${process.env.QUALITY ?? "high"}${process.env.PAINT ? `&paint=${process.env.PAINT}` : ""}#base=${base}`, { waitUntil: "commit", timeout: 120000 });
    await p.waitForFunction(() => window.__yard?.ready && window.__yard.models !== "loading", null, { timeout: 120000 });
    await frames(p, 40); // a late model swaps in; the camera's fly-in ends
    if (process.env.VIEW) {
      await p.evaluate((v) => window.__yard.setView(v), process.env.VIEW);
      await frames(p, 60);
    }
    await p.evaluate(() => {
      const c = document.querySelector("canvas");
      for (const el of document.querySelectorAll("body > *")) if (el !== c && !el.contains(c)) el.style.visibility = "hidden";
    });
    await p.mouse.move(640, 400);
    for (let i = 0; i < Number(process.env.ZOOM ?? 7); i++) await p.mouse.wheel(0, -120);
    await p.mouse.down();
    await p.mouse.move(640 + dx, 400 + dy, { steps: 8 });
    await p.mouse.up();
    await frames(p, 30); // the camera coasts to a stop
    await p.screenshot({ path: `${OUT}-${base}-${shot}.png` });
    console.log(`${OUT}-${base}-${shot}.png`, await p.evaluate(() => window.__yard.models));
    await p.close();
  }
}
await b.close();
