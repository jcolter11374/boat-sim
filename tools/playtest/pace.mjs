// How slowly this machine draws, and click waits that stretch to match.
//
// A GitHub runner draws the sea with software graphics, and one runner can be three times
// slower than the next: on 14 Nov 2026 one scheduled live check, one commit, four machines
// drew the helm at 450 to 1630 ms a frame (run 43606637583). Playwright won't click a button
// until it has held still for two frames in a row, so a click wait that is generous on a fast
// machine runs out on a slow one, and the check fails on the machine, not on the game.
//
// So each run measures its machine once, on the title's sea at Low, and stretches the click
// waits by that: T(ms) is ms on a machine drawing at REFERENCE_MS a frame or faster, and up to
// MAX_PACE times ms on a slower one. Only waits stretch. What a check asserts doesn't change,
// and a button that never becomes clickable still fails, a little later.

/** The frame time the checks' waits were written for: a fast runner's helm at Low. */
export const REFERENCE_MS = 450;
/** No wait stretches further than this, however slow the machine. */
export const MAX_PACE = 4;

let pace = 1;

/** The stretch for a machine drawing at `frameMs` a frame: 1 at the reference or faster, capped at MAX_PACE. */
export function paceFor(frameMs) {
  if (!(frameMs > 0)) return 1;
  return Math.min(MAX_PACE, Math.max(1, frameMs / REFERENCE_MS));
}

/** A wait of `ms`, stretched for this machine. */
export const T = (ms) => Math.round(ms * pace);

/** Measure this machine on the site's sea at Low (a dozen frames) and set the stretch.
 *  Returns { frameMs, pace }. If the page won't draw, the stretch stays 1 and the checks say why themselves. */
export async function measurePace(browser, site) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  let frameMs = 0;
  try {
    const page = await ctx.newPage();
    await page.goto(`${site}?title=0&quality=low`, { waitUntil: "load", timeout: 120_000 });
    await page.waitForFunction(() => (window.__sea3d?.frames ?? 0) > 5, null, { timeout: 120_000 });
    frameMs = await page.evaluate(
      () =>
        new Promise((done) => {
          const gaps = [];
          let last = performance.now();
          const tick = (now) => {
            gaps.push(now - last);
            last = now;
            if (gaps.length < 12) requestAnimationFrame(tick);
            else done(gaps.sort((a, b) => a - b)[6]);
          };
          requestAnimationFrame(tick);
        }),
    );
  } catch {
    frameMs = 0;
  } finally {
    await ctx.close().catch(() => {});
  }
  pace = paceFor(frameMs);
  return { frameMs: Math.round(frameMs), pace: Math.round(pace * 100) / 100 };
}
