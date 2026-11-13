// Nina's playtest: plays the DEPLOYED pages the way a person does, in Chrome and
// Firefox, and fails on what a player would hit. It sits beside Ravi's
// tools/live_site_check.mjs (which checks that each page starts and sails a day)
// and covers the paths a player takes after that: cinematic mode, "sail until
// something happens", the real base station, and the same core paths in Firefox.
// Read-only: it only visits the public site.
//
//   BROWSER=firefox node tools/playtest/play.mjs [check ...]   (no names = all)
//   SITE=https://example.github.io/boat-sim/ node tools/playtest/play.mjs helm-cinematic
//
// Each check prints one PASS/FAIL line with evidence, and saves
// play-<browser>-<check>.png. Exit code 1 if anything failed.
import * as pw from "playwright";
import { appendFileSync, readFileSync } from "node:fs";

const SITE = (process.env.SITE ?? "https://jcolter11374.github.io/boat-sim/").replace(/\/?$/, "/");
const BROWSER = process.env.BROWSER ?? "chromium";
const MIN = 60_000;
const NOTICE = /being updated|can['’]t start|cannot start|aren['’]t published|isn['’]t published|no simulator files|simulator stopped|failed/i;
// Stops a player can legitimately hit (helm.ts Stop).
const STOPS = ["time", "battery", "wind", "land", "breakdown", "silence", "ghost_passed", "passed_ghost", "over", "order_arrived", "left_data_box"];

class CheckFail extends Error {}
class SkipCheck extends Error {}
const must = (ok, msg) => {
  if (!ok) throw new CheckFail(msg);
};

async function open(browser, path) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  const notes = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) notes.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  await page.goto(SITE + path, { waitUntil: "load", timeout: 2 * MIN });
  return { ctx, page, errors, notes };
}

async function visibleNotices(page) {
  const text = await page.evaluate(() => document.body.innerText);
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && NOTICE.test(l));
}


/** Pick a boat row. The Set sail card keeps the radios hidden and picks through the top bar's
 * My boat picker, which ticks the row and fires change: do the same when the row can't be seen. */
async function tickBoat(r) {
  if (await r.isVisible()) return r.check();
  await r.evaluate((el) => {
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Press Set sail. If a crossing is saved in this browser (#462), the card asks before a new one
 *  ends it (#465): a check wants the new crossing, so it answers that and carries on. */
async function pressSetSail(page, opts = {}) {
  await page.click("#go", opts);
  const ask = page.locator("#ss-ask");
  if ((await ask.count()) && (await ask.isVisible().catch(() => false))) await page.click("#ss-ask-new", { noWaitAfter: true, timeout: 15_000 });
}

async function helmStart(page, setup = async () => {}) {
  await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
  // Launch day, challenges and how you steer sit under "More options" (Nina's review); open it if this page has it.
  await page.evaluate(() => { const d = document.getElementById("more"); if (d) d.open = true; });
  await setup(page);
  await pressSetSail(page);
  await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
  const s = await page.evaluate(() => ({ ready: window.__helm.ready, err: window.__helm.error, msg: document.querySelector("#startmsg").textContent }));
  must(s.ready && !s.err, `didn't start: ${s.err || "no error"}; the page says "${s.msg}"`);
  // Time runs by itself once you set sail (#339): pause it, and let the picture settle, so a hop measures only the hop.
  await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
  // The status can lag the start by a frame or two: settle only once there's a day to read.
  // The status reads day 0 until the clock's first run (already under way when we paused) comes
  // back, which can take a few seconds in Firefox: settle only after that (#368 gate, helm-until).
  await page.waitForFunction(() => (window.__helm.status?.day ?? 0) > 0, null, { timeout: 30_000 }).catch(() => {});
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const d = await page.evaluate(() => window.__helm.status?.day ?? 0);
    if (d === last) break;
    last = d;
    await page.waitForTimeout(1000);
  }
}

/** The helm's orders drawer (Leo's layout plan): open it before using what's inside. Builds without one: nothing to do. */
async function openOrders(page) {
  if (!(await page.locator("#orders-tab").count())) return;
  // At the start the drawer opens by itself for 10 s with a tip, then slides shut unless it's
  // in use; on slow software graphics the slide takes seconds. So: open it if it's shut, wait
  // until it has fully slid in, then point at it, which keeps it open (the player is using it).
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator("#orders.open").count())) await page.click("#orders-tab", { timeout: 15_000 }).catch(() => {});
    const there = await page
      .waitForFunction(() => { const o = document.getElementById("orders"); return o.classList.contains("open") && o.getBoundingClientRect().x >= 0; }, null, { timeout: 20_000 })
      .then(() => true, () => false);
    if (!there) continue;
    await page.hover("#orders h2", { timeout: 10_000 }).catch(() => {});
    if (await page.locator("#orders.open").count()) return;
  }
}
async function hop(page, button) {
  const t0 = Date.now();
  const day0 = await page.evaluate(() => window.__helm.status?.day ?? 0);
  await openOrders(page);
  await page.click(button);
  await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 10 * MIN });
  const st = await page.evaluate(() => ({ day: window.__helm.status?.day, stop: window.__helm.lastStop, err: window.__helm.error, over: window.__helm.status?.over }));
  st.secs = Math.round((Date.now() - t0) / 1000);
  st.day0 = day0;
  must(!st.err, `sailing failed: ${st.err}`);
  must(STOPS.includes(st.stop), `unknown stop ${JSON.stringify(st.stop)} at day ${st.day}`);
  return st;
}

/** Cinematic mode: panels hide, the picture keeps moving, the clock doesn't move, any key leaves. */
async function cinematic(page, framesOf) {
  const day0 = await page.evaluate(() => window.__helm?.status?.day ?? null);
  // The button only toggles a class; don't wait for navigations (software GL can stall that wait, 11 Nov).
  await page.click("#cinebtn", { noWaitAfter: true });
  await page.waitForFunction(() => document.body.classList.contains("cinema"), null, { timeout: 10_000 }).catch(() => {
    throw new CheckFail("clicking Cinematic didn't start cinematic mode");
  });
  const f0 = await page.evaluate(framesOf);
  await page.waitForTimeout(8000);
  const f1 = await page.evaluate(framesOf);
  // Headless browsers draw on software graphics at about 1 frame a second on a
  // PC without a GPU (John's, 11 Nov: 9-10 frames in 8 s), so "moving" means a few frames.
  must(f1 - f0 >= 3, `the picture froze in cinematic mode (${f1 - f0} frames in 8 s)`);
  await page.screenshot({ path: `play-${BROWSER}-cinematic-inside.png` }).catch(() => {});
  const day1 = await page.evaluate(() => window.__helm?.status?.day ?? null);
  must(day0 === day1, `cinematic mode moved the clock from day ${day0} to ${day1}`);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.body.classList.contains("cinema"), null, { timeout: 10_000 }).catch(() => {
    throw new CheckFail("a key press didn't leave cinematic mode");
  });
  return `cinematic ran ${f1 - f0} frames in 8 s and a key press left it`;
}

/** A look frame. On software graphics one heavy frame can take more than 30 s to draw (look-heel,
 * 12 Nov), so allow 90 s and try twice; a frame that still won't come is noted, not a failure. */
async function jpeg(page, path) {
  for (let i = 0; i < 2; i++) {
    try {
      await page.screenshot({ path, type: "jpeg", quality: 85, timeout: 90_000, animations: "disabled" });
      return true;
    } catch (e) {
      console.log(`(frame ${path} not taken, try ${i + 1}: ${String(e.message).split("\n")[0]})`);
    }
  }
  return false;
}
/** Practice: start "The triangle" and wait until you have the wheel. The course buttons can
 * resolve before they take clicks (still loading or sliding in; look-heel 12 Nov), so wait for
 * the page to be idle and the button to be visible and enabled, retry, then click in-page. */
async function practiceTriangle(page) {
  // The Set sail card opens on Annapolis on a practice page (M1): pick the triangle, then Set sail.
  const sel = "#go";
  await page.waitForFunction(() => document.querySelector("#ss-course-opts .ss-pill"), null, { timeout: 3 * MIN }).catch(() => {});
  await page.evaluate(() => document.querySelector("#ss-course-opts .ss-pill")?.click()); // the first course: the triangle
  await page.waitForFunction(() => !window.__helm?.busy, null, { timeout: 3 * MIN }).catch(() => {});
  for (let i = 0; i < 3 && !(await page.evaluate(() => !!window.__wheel?.on)); i++) {
    await page.waitForFunction((s) => { const b = document.querySelector(s); return b && !b.disabled && b.offsetParent !== null; }, sel, { timeout: MIN }).catch(() => {});
    await page.click(sel, { timeout: 15_000 }).catch(() => page.evaluate((s) => document.querySelector(s)?.click(), sel));
    await page.waitForFunction(() => window.__wheel?.on, null, { timeout: 30_000 }).catch(() => {});
  }
  const on = await page.evaluate(() => !!window.__wheel?.on);
  if (!on) {
    const why = await page.evaluate((s) => { const b = document.querySelector(s); if (!b) return "no button"; const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return `button ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} disabled=${b.disabled}; on top: ${top ? top.tagName + "#" + top.id + "." + top.className : "nothing"}`; }, sel);
    throw new CheckFail(`"The triangle" didn't put me at the wheel (${why})`);
  }
}
/** Reload once the page has finished fetching: in Chromium, leaving while the boat model's
 * textures are still decoding logs "GLTFLoader: Couldn't load texture blob:" (sound-helm, 12 Nov). */
async function calmReload(page) {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: "load", timeout: 2 * MIN });
}
/** Ada's proof clock (tools/proof/capture.mjs), plus release(): held, the page's rAF,
 * performance.now and Date.now only move when stepped, so each filmed frame is exactly 1/fps. */
const FILM_CLOCK = `(() => {
  const realRaf = window.requestAnimationFrame.bind(window), realNow = performance.now.bind(performance), realDate = Date.now.bind(Date);
  let held = null, vt = 0, lag = 0; const q = [];
  window.__proofClock = {
    hold() { if (held === null) { held = realNow(); vt = held - lag; } },
    step(ms) { vt += ms; const cbs = q.splice(0); for (const cb of cbs) { try { cb(vt); } catch (e) { console.error(e); } } return cbs.length; },
    release() { if (held === null) return; lag = realNow() - vt; held = null; for (const cb of q.splice(0)) realRaf(cb); },
  };
  performance.now = () => (held === null ? realNow() - lag : vt);
  Date.now = () => realDate() - (realNow() - performance.now());
  window.requestAnimationFrame = (cb) => (held === null ? realRaf((t) => cb(t - lag)) : (q.push(cb), q.length));
})();`;
/** #385: count the page's AudioContexts (an init script, so it sees the very first one). */
const soundSpy = () => {
  window.__ac = [];
  const Orig = window.AudioContext;
  if (Orig) window.AudioContext = class extends Orig { constructor(...a) { super(...a); window.__ac.push(this); } };
};
const soundState = (page) =>
  page.evaluate(() => {
    const b = document.getElementById("soundbtn");
    let stored = null;
    try { stored = localStorage.getItem("boatsim-sound"); } catch {}
    return { contexts: (window.__ac ?? []).length, state: (window.__ac ?? []).map((c) => c.state).join(",") || "none", pressed: b?.getAttribute("aria-pressed") === "true", text: b?.textContent.trim(), icon: b?.textContent.trim(), stored };
  });

const CHECKS = {
  // The four pages load and draw in this browser.
  index: {
    path: "",
    run: async (page) => {
      await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 5, null, { timeout: 2 * MIN });
      return "drawing";
    },
  },
  // The default helm game: start, sail 6 hours, sail a day.
  "helm-play": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page);
      const a = await hop(page, "#s6");
      must(a.day - a.day0 > 0.2 || a.stop !== "time", `"Sail 6 hours" only went from day ${a.day0} to ${a.day}`);
      const b = await hop(page, "#sday");
      return `6 h hop to day ${a.day.toFixed(2)} (${a.secs} s), 1 day hop to ${b.day.toFixed(2)} (${b.secs} s, stop ${b.stop})`;
    },
  },
  // #339 as a first-timer sees it: only the start card at first, Set sail in view,
  // a loading message, then time runs by itself, pauses on an event and says why,
  // and the 3D day label agrees with the panel.
  "helm-first-timer": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.locator("#timebar").count())) throw new SkipCheck("this build has no time bar (#339 not deployed)");
      const first = await page.evaluate(() => {
        const shown = (id) => { const e = document.getElementById(id); if (!e || e.hidden) return false; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0.05; };
        const go = document.getElementById("go").getBoundingClientRect();
        return { orders: shown("orders"), status: shown("status"), timebar: shown("timebar"), go: shown("go"), goInView: go.bottom <= innerHeight && go.top >= 0, moreOpen: !!document.getElementById("more")?.open, label: document.getElementById("go").textContent.trim() };
      });
      must(first.go && first.goInView, `"${first.label}" isn't visible without scrolling on the first screen`);
      must(!first.orders && !first.status && !first.timebar, `game controls show before you set sail (orders ${first.orders}, status ${first.status}, time bar ${first.timebar})`);
      must(!first.moreOpen, `"More options" starts open`);
      await page.screenshot({ path: `play-${BROWSER}-first-screen.png` }).catch(() => {});
      await page.click("#go");
      const loading = await page.waitForFunction(() => !document.getElementById("loading").hidden || window.__helm.ready, null, { timeout: 10_000 }).then(() => page.evaluate(() => !document.getElementById("loading").hidden || "already ready")).catch(() => false);
      must(loading, "nothing said it was loading after Set sail");
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      const st = await page.evaluate(() => ({ err: window.__helm.error, clock: window.__helm.clock, loading: !document.getElementById("loading").hidden, timebar: !document.getElementById("timebar").hidden, state: document.getElementById("timestate").textContent }));
      must(!st.err, `didn't start: ${st.err}`);
      must(!st.loading, "the loading message stayed up after it started");
      must(st.timebar, "no time bar once sailing");
      must(st.clock > 0, `time didn't start by itself (clock ${st.clock}, says "${st.state}")`);
      // The strip's time cell at three window widths: the day, date and zone whole and above the speed
      // buttons, every button on one line, all of it inside the strip. Measured as the browser draws it and
      // again with the letters spaced out, which stands in for a browser whose system face is wider (a wide
      // face once wrapped "Real time" onto two lines, and the taller bar hid the day and date).
      await page.waitForFunction(() => { const s = document.getElementById("strip"); return getComputedStyle(s).visibility === "visible" && +getComputedStyle(s).opacity > 0.9; }, null, { timeout: 60_000 }).catch(() => {});
      for (const wide of [false, true]) {
        const tag = wide ? await page.addStyleTag({ content: "#strip, #strip * { letter-spacing: .08em !important; }" }) : null;
        for (const [w, h] of [[1100, 700], [1280, 720], [1920, 1080]]) {
          await page.setViewportSize({ width: w, height: h });
          await page.waitForTimeout(400);
          const bad = await page.evaluate(() => {
            const R = (e) => e.getBoundingClientRect();
            const strip = R(document.getElementById("strip")), cell = R(document.querySelector("#strip .c-time")), v = document.querySelector("#strip .c-time .v"), vr = R(v), bar = R(document.getElementById("timebar"));
            const out = [];
            if (vr.height < parseFloat(getComputedStyle(v).fontSize)) out.push(`the day and date line is squashed to ${Math.round(vr.height)} px`);
            if (vr.top < strip.top - 1) out.push("the day and date stick out above the strip");
            if (vr.bottom > bar.top + 1) out.push("the speed buttons cover the day and date");
            if (v.scrollWidth > v.clientWidth + 1) out.push(`the day, date and zone are cut off ("${v.textContent.trim().slice(0, 40)}")`);
            if (bar.bottom > strip.bottom + 1) out.push("the speed buttons stick out below the strip");
            for (const b of document.querySelectorAll("#timebar button")) {
              const r = R(b);
              if (r.height > parseFloat(getComputedStyle(b).fontSize) * 2.2) out.push(`"${b.textContent.trim()}" wraps onto two lines`);
              if (r.right > cell.right + 1) out.push(`"${b.textContent.trim()}" runs past the time cell`);
            }
            return out;
          });
          if (bad.length) await page.screenshot({ path: `play-${BROWSER}-strip-time-${w}${wide ? "-wide" : ""}.png` }).catch(() => {});
          must(!bad.length, `the strip's time cell at ${w}x${h}${wide ? " with wider letters" : ""}: ${bad.join("; ")}`);
        }
        if (tag) await tag.evaluate((e) => e.remove());
      }
      await page.setViewportSize({ width: 1400, height: 900 });
      const d0 = await page.evaluate(() => window.__helm.status?.day ?? 0);
      await page.waitForFunction((d0) => (window.__helm.status?.day ?? 0) > d0 || window.__helm.clock === 0, d0, { timeout: 60_000 }).catch(() => {
        throw new CheckFail(`the day didn't move on its own in 60 s (day ${d0})`);
      });
      // Go fastest so an event comes soon, then wait for the clock to pause itself.
      const fast = page.locator('#timebar .rate[data-rate="96"]');
      if (await fast.count()) await fast.click({ noWaitAfter: true });
      await page.waitForFunction(() => window.__helm.clock === 0 || window.__helm.error || window.__helm.card, null, { timeout: 6 * MIN }).catch(() => {
        throw new CheckFail("the clock never paused itself for an event in 6 minutes");
      });
      const p = await page.evaluate(() => ({ err: window.__helm.error, stop: window.__helm.stops?.at(-1), state: document.getElementById("timestate").textContent, note: document.querySelector("#notes .note .txt")?.textContent ?? "", day: window.__helm.status?.day, over: window.__helm.status?.over }));
      must(!p.err, `sailing failed: ${p.err}`);
      if (!p.over) {
        must(/paused/i.test(p.state), `paused but the time bar says "${p.state}"`);
        // The reason's note appears once the picture has played on to the moment it stopped (#341), so give it time.
        // A "Your call" card is a reason too: since #391 the battery stop can carry one (the
        // Gulf Stream, a night call) and the card, not a note, says why the clock stopped.
        if (p.stop !== "time") {
          const why = await page
            .waitForFunction(() => {
              const card = document.getElementById("decide");
              if (card && !card.hidden) return `Your call: ${document.getElementById("decidetext")?.textContent ?? ""}`;
              return [...document.querySelectorAll("#notes .note .txt")].map((e) => e.textContent).find((t) => /^Paused:/.test(t));
            }, null, { timeout: 30_000 })
            .then((h) => h.jsonValue())
            .catch(() => "");
          must(why, `paused for "${p.stop}" with no "Paused: ..." reason or "Your call" card after 30 s (latest note "${p.note}")`);
          p.note = why;
        }
      }
      // The picture plays on to the moment it stopped; then the 3D label and the panel must agree.
      const agree = await page.waitForFunction(() => { const c = document.getElementById("clock").textContent.trim(); return c && c === document.getElementById("day").textContent.trim(); }, null, { timeout: 30_000 }).then(() => true).catch(() => false);
      const labels = await page.evaluate(() => [document.getElementById("clock").textContent.trim(), document.getElementById("day").textContent.trim()]);
      await page.screenshot({ path: `play-${BROWSER}-first-pause.png` }).catch(() => {});
      must(agree || p.over, `the 3D day label says "${labels[0]}" but the panel says "${labels[1]}"`);
      return `first screen clean; ran by itself from day ${d0.toFixed(2)}; paused at day ${p.day?.toFixed(2)} (${p.stop}): "${p.note}"; labels ${labels.join(" = ")}`;
    },
  },
  // #334 "Sound on?" and #341 decision stops: the question shows once, "No thanks" closes it;
  // running at speed, a decision stops the clock with buttons, and picking one carries on.
  "helm-moments": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.locator("#decide").count())) throw new SkipCheck("this build has no decision stops (#341 not deployed)");
      await page.evaluate(() => {
        const a = document.getElementById("soundask");
        if (a) new MutationObserver(() => { if (!a.hidden) window.__askedSound = true; }).observe(a, { attributes: true });
      });
      await page.click("#go", { timeout: 15_000 }).catch(() => {
        throw new CheckFail(`couldn't click "Set sail"`);
      });
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      const out = [];
      const fast = page.locator('#timebar .rate[data-rate="96"]');
      let decided = null;
      for (let i = 0; i < 12 && !decided; i++) {
        if (await page.evaluate(() => window.__helm.card || window.__helm.status?.over)) break;
        // Key 5 is "4 days a second" (key 1 is real time since T1) (the key hint); a key can't be blocked by a panel over the button.
        if (await page.evaluate(() => window.__helm.clock === 0)) {
          if (await fast.isVisible()) await fast.click({ noWaitAfter: true, timeout: 10_000 }).catch(() => page.keyboard.press("5"));
          else await page.keyboard.press("5");
        }
        await page.waitForFunction(() => window.__helm.clock === 0 || window.__helm.error || window.__helm.card, null, { timeout: 4 * MIN }).catch(() => {});
        must(!(await page.evaluate(() => window.__helm.error)), "sailing failed");
        const shown = await page.waitForFunction(() => !document.getElementById("decide").hidden && document.querySelectorAll("#decidebtns button").length, null, { timeout: 15_000 }).then(() => true).catch(() => false);
        if (shown) {
          const d = await page.evaluate(() => ({ text: document.getElementById("decidetext").textContent, btns: [...document.querySelectorAll("#decidebtns button")].map((b) => b.textContent) }));
          must(d.text.trim() && d.btns.length >= 2, `a decision showed without a question or choices: ${JSON.stringify(d)}`);
          await page.screenshot({ path: `play-${BROWSER}-decision.png` }).catch(() => {});
          await page.locator("#decidebtns button").first().click({ noWaitAfter: true, timeout: 10_000 }).catch(() => {
            throw new CheckFail(`couldn't click "${d.btns[0]}" on the decision`);
          });
          await page.waitForFunction(() => document.getElementById("decide").hidden && window.__helm.clock > 0, null, { timeout: 20_000 }).catch(() => {
            throw new CheckFail(`picking "${d.btns[0]}" didn't close the question and carry on`);
          });
          decided = `asked "${d.text.slice(0, 90)}", picked "${d.btns[0]}", carried on`;
        }
      }
      if (!decided) out.push("no decision came up in this voyage (not a fail)");
      else out.push(decided);
      // "Sound on?" (#334, then Leo's one-thing-at-a-time opening): asked once, a minute in or
      // a few seconds after the first call, whichever comes first (older builds: on Set sail).
      // It closes by itself after 20 s, so: it was asked, and it goes away.
      if (await page.locator("#soundask").count()) {
        const asked = await page.waitForFunction(() => !document.getElementById("soundask").hidden || window.__askedSound, null, { timeout: 75_000 }).then(() => true).catch(() => false);
        must(asked, `"Sound on?" was never asked (expected a minute in, or after the first call)`);
        const clicked = (await page.click("#soundno", { noWaitAfter: true, timeout: 5_000 }).then(() => true).catch(() => false));
        const gone = await page.waitForFunction(() => document.getElementById("soundask").hidden, null, { timeout: 25_000 }).then(() => true).catch(() => false);
        must(gone, `the "Sound on?" question didn't go away${clicked ? ' after "No thanks"' : ""}`);
        out.push(`"Sound on?" asked, ${clicked ? 'closed with "No thanks"' : "closed by itself after 20 s"}`);
      }
      return out.join("; ");
    },
  },
  // #348: on the cruiser, holding an arrow keeps turning, and "Take the wheel" hands you the boat until Esc.
  "helm-wheel": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page, async (p) => {
        const r = p.locator('input[name="boat"][value="stock_cruiser31"]');
        if ((await r.count()) !== 1) throw new SkipCheck("the cruiser isn't offered in the helm's boat picker");
        await tickBoat(r);
      });
      if (!(await page.locator("#b-wheel").count())) throw new SkipCheck("this build has no Take the wheel (#348 not deployed)");
      const out = [];
      // Hold-to-turn: a tap is 5 degrees; holding for 1.5 s should turn well past that.
      await page.evaluate(() => document.activeElement?.blur?.()); // keys to the page, not a focused control
      const read = () => page.evaluate(() => document.getElementById("ordertext").textContent);
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(300);
      const tapped = await read();
      const h0 = Number((tapped.match(/Steering (\d+)/) || [])[1]);
      must(Number.isFinite(h0), `an arrow key didn't give a heading to steer (orders say "${tapped}")`);
      await page.keyboard.down("ArrowRight");
      await page.waitForTimeout(1500);
      await page.keyboard.up("ArrowRight");
      await page.waitForTimeout(300);
      const held = await read();
      const h1 = Number((held.match(/Steering (\d+)/) || [])[1]);
      const turned = ((h1 - h0 + 540) % 360) - 180;
      must(turned > 10, `holding the right arrow 1.5 s only turned from ${h0}° to ${h1}°`);
      out.push(`holding → turned ${h0}° to ${h1}°`);
      // The new heading starts a simulator run; Take the wheel waits for it (takeWheel awaits the
      // run in flight), which on a busy runner in Firefox can pass 20 s (Lena, #368). Let it finish
      // first, then time the handover itself; a slow one is reported, not failed.
      const tIdle = Date.now();
      await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 2 * MIN }).catch(() => {});
      await page.waitForTimeout(1500);
      const idleSecs = Math.round((Date.now() - tIdle) / 1000);
      await openOrders(page);
      const b = page.locator("#b-wheel");
      must(await b.isVisible(), `no "Take the wheel" button on the cruiser`);
      const t0 = Date.now();
      await b.click({ noWaitAfter: true, timeout: 10_000 }).catch(() => {
        throw new CheckFail(`couldn't click "Take the wheel"`);
      });
      await page.waitForFunction(() => window.__wheel?.on, null, { timeout: 60_000 }).catch(async () => {
        const n = await page.evaluate(() => document.querySelector("#notes .note .txt")?.textContent ?? "");
        throw new CheckFail(`"Take the wheel" didn't hand over the boat in 60 s (busy ${await page.evaluate(() => window.__helm.busy)}; latest note "${n}")`);
      });
      const handSecs = (Date.now() - t0) / 1000;
      out.push(`after the new heading the simulator was busy ~${idleSecs} s; the wheel took ${handSecs.toFixed(1)} s${handSecs > 5 ? " (slow for a player)" : ""}`);
      await page.keyboard.down("ArrowLeft");
      await page.waitForTimeout(1000);
      await page.keyboard.up("ArrowLeft");
      await page.screenshot({ path: `play-${BROWSER}-wheel.png` }).catch(() => {});
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !window.__wheel.on, null, { timeout: 15_000 }).catch(() => {
        throw new CheckFail("Esc didn't hand the boat back");
      });
      const n = await page.evaluate(() => [...document.querySelectorAll("#notes .note")].filter((e) => /At the wheel/.test(e.textContent)).length);
      must(n >= 1, "no 'At the wheel' note after taking and handing back the wheel");
      out.push("took the wheel, steered, Esc handed back");
      return out.join("; ");
    },
  },
  // #359: near Annapolis (between the city and Thomas Point) the Bay's coast squares load around
  // the boat. No game start is inside the Bay yet, so this puts the boat there with ?spot= (for tests).
  "helm-bay-squares": {
    path: "helm.html?quality=low&spot=38.92,-76.42",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.evaluate(() => "squares" in (window.__helm.land ?? {})))) throw new SkipCheck("this build has no coast squares (#359 not deployed)");
      const n = await page.waitForFunction(() => window.__helm.land.squares > 0 && window.__helm.land.squares, null, { timeout: 90_000 }).then((h) => h.jsonValue()).catch(() => 0);
      await page.screenshot({ path: `play-${BROWSER}-bay-squares.png` }).catch(() => {});
      must(n > 0, `no coast squares loaded around the boat near Annapolis in 90 s (land ${JSON.stringify(await page.evaluate(() => window.__helm.land))})`);
      const credit = await page.evaluate(() => document.body.innerText.match(/[^\n]*CUDEM[^\n]*/)?.[0] ?? "");
      return `${n} coast squares around the boat; credit "${credit.trim().slice(0, 100)}"`;
    },
  },
  // #374 (Kai's NOW list): the default start is a good day with a "Rough start" offered, the chip
  // says "My boat: Our kayak" with no boat saved, both day labels agree running and after a player's
  // pause, and an event that happens to you and the ghost together is one note.
  "helm-now": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      const card = await page.evaluate(() => ({
        sel: document.querySelector("#launch option:checked")?.textContent ?? "",
        rough: [...document.querySelectorAll("#launch option")].some((o) => /rough start/i.test(o.textContent)),
        chip: document.querySelector("#topbar .boat")?.textContent.trim() ?? "",
      }));
      if (!/23 April/.test(card.sel)) throw new SkipCheck(`this build's default launch is "${card.sel}" (#374 not deployed)`);
      must(card.rough, 'no "Rough start" launch on the card');
      must(/My boat:\s*Our kayak/.test(card.chip), `the top bar chip says "${card.chip}" with no boat saved`);
      await page.click("#go");
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      await page.click("#soundno", { timeout: 3000 }).catch(() => {});
      await page.waitForFunction(() => (window.__helm.hour ?? 0) > 24 || window.__helm.clock === 0, null, { timeout: 3 * MIN }).catch(() => {});
      const read = () => page.evaluate(() => [document.getElementById("clock").textContent.trim(), document.getElementById("day").textContent.trim()]);
      const running = await read();
      if (await page.evaluate(() => window.__helm.clock > 0)) await page.click("#t-pause", { noWaitAfter: true });
      await page.waitForTimeout(2500);
      const paused = await read();
      await page.screenshot({ path: `play-${BROWSER}-now-paused.png` }).catch(() => {});
      must(paused[0] && paused[0] === paused[1], `after pressing pause the picture says "${paused[0]}" and the panel "${paused[1]}"`);
      must(running[0] === running[1], `while running the picture said "${running[0]}" and the panel "${running[1]}" in the same frame`);
      // Shared events: no two notes with the same words for "You" and "Ghost" at the same time.
      const notes = await page.evaluate(() => [...document.querySelectorAll("#notes .note")].map((n) => ({ when: n.querySelector(".when")?.textContent ?? "", txt: n.querySelector(".txt")?.textContent ?? "" })));
      const seen = new Map();
      const doubled = [];
      for (const n of notes) {
        const day = n.when.replace(/^(You|Ghost)\s*·\s*/, "");
        const k = `${day}|${n.txt}`;
        if (seen.has(k) && seen.get(k) !== n.when) doubled.push(`"${n.txt.slice(0, 60)}" (${seen.get(k)} and ${n.when})`);
        seen.set(k, n.when);
      }
      must(!doubled.length, `the same event shows twice: ${doubled.join("; ")}`);
      return `default "${card.sel}", rough start offered, chip "${card.chip}"; labels ${running.join(" = ")} running, ${paused.join(" = ")} paused; ${notes.length} notes, none doubled`;
    },
  },
  // #374: Watch a voyage has no text cut off with "..." and nothing hanging off the window.
  "voyage-fit": {
    path: "voyage.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN });
      await page.waitForTimeout(3000);
      for (const [w, h] of [[1400, 900], [1280, 720], [1024, 700]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(1500);
        const bad = await page.evaluate(() => {
          const out = [];
          for (const e of document.querySelectorAll("body *")) {
            if (!e.offsetParent || e.closest("canvas, svg, select, option, #cine, .cinema")) continue;
            const cs = getComputedStyle(e);
            const r = e.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            const text = (e.textContent || "").trim().slice(0, 40);
            if (cs.textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 1) out.push(`cut off: "${text}"`);
            if (e.children.length === 0 && text && r.right > innerWidth + 1 && cs.position === "fixed") out.push(`off the right edge: "${text}"`);
          }
          return [...new Set(out)].slice(0, 6);
        });
        await page.screenshot({ path: `play-${BROWSER}-voyage-${w}.png` }).catch(() => {});
        must(!bad.length, `at ${w}x${h}: ${bad.join("; ")}`);
      }
      return "no cut-off text at 1400x900, 1280x720 or 1024x700";
    },
  },
  // #376: Practice off Annapolis (the triangle course at the wheel), the harbour prologue on the
  // cruiser from Annapolis (skip with Esc, then "Start the crossing"), and the orders drawer opens.
  "helm-376": {
    path: "helm.html?practice&quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.locator("#ss-course-opts").count())) throw new SkipCheck("this build has no practice courses on the Set sail card (M1 piece 3 not deployed)");
      const out = [];
      await page.waitForFunction(() => !document.getElementById("start").hidden && !document.getElementById("ss-course").hidden, null, { timeout: MIN }).catch(() => {
        throw new CheckFail("Practice didn't open the Set sail card on its courses");
      });
      // On software graphics Practice's first frames can hold the page for over 15 s, so a click
      // waits there (Owen, 12 Nov); the helper waits for it to be idle and retries.
      await practiceTriangle(page);
      await page.keyboard.down("ArrowLeft"); await page.waitForTimeout(800); await page.keyboard.up("ArrowLeft");
      await page.screenshot({ path: `play-${BROWSER}-practice-triangle.png` }).catch(() => {});
      out.push("Practice: the triangle put me at the wheel");
      // The prologue: cruiser from Annapolis.
      await page.goto(SITE + "helm.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await page.evaluate(() => { const d = document.getElementById("more"); if (d) d.open = true; });
      await tickBoat(page.locator('input[name="boat"][value="stock_cruiser31"]'));
      await page.waitForFunction(() => !document.querySelector("#portpick").hidden, null, { timeout: MIN });
      await page.selectOption("#port", "annapolis");
      const offered = await page.waitForFunction(() => !document.getElementById("prologuepick").hidden, null, { timeout: 30_000 }).then(() => true).catch(() => false);
      must(offered, 'the cruiser from Annapolis wasn\'t offered "Sail her out of the harbour yourself first"');
      await page.click("#go");
      await page.waitForFunction(() => window.__wheel?.on, null, { timeout: 2 * MIN }).catch(() => {
        throw new CheckFail("the harbour prologue didn't put you at the wheel");
      });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `play-${BROWSER}-prologue.png` }).catch(() => {});
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.getElementById("prologue-end").hidden, null, { timeout: 30_000 }).catch(() => {
        throw new CheckFail("Esc in the prologue didn't bring up the 'Start the crossing' card");
      });
      const sum = await page.evaluate(() => document.getElementById("prologue-sum").textContent);
      await page.click("#prologue-go");
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), "the crossing didn't start after the prologue");
      out.push(`prologue: "${sum}", then the crossing started`);
      // The orders drawer.
      await page.click("#soundno", { timeout: 3000 }).catch(() => {});
      // The drawer slides in and out by itself at the start (and #406 shows one thing at a time),
      // so the tab can be moving; openOrders waits for it to settle (Owen, 12 Nov).
      await openOrders(page);
      const open = await page.waitForFunction(() => { const o = document.getElementById("orders"); return o.classList.contains("open") && o.getBoundingClientRect().x >= 0; }, null, { timeout: 20_000 }).then(() => true).catch(() => false);
      must(open, "the Orders tab didn't open the orders drawer");
      out.push("orders drawer opens");
      return out.join("; ");
    },
  },
  // Sam's spot 5: "Sail until something happens" stops within 72 h.
  "helm-until": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page);
      const st = await hop(page, "#sevent");
      must(st.day - st.day0 <= 3 + 1e-3, `"until something happens" ran past 72 h (day ${st.day0} to ${st.day})`);
      return `from day ${st.day0.toFixed(2)}, stopped at day ${st.day.toFixed(2)} for "${st.stop}" (${st.secs} s)`;
    },
  },
  // Sam's spot 3: real base station, an order takes about a day to arrive.
  "helm-base-order": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page, async (p) => p.evaluate(() => document.querySelector('#ss-mode-opts .ss-pill:nth-child(2)').click()));
      await openOrders(page); // Send lives in the orders drawer
      const visible = await page.isVisible("#send");
      must(visible, "in base-station mode there's no Send button");
      await page.click("#send");
      const stops = [];
      for (let i = 0; i < 4; i++) {
        const st = await hop(page, "#sday");
        stops.push(`${st.stop}@${st.day.toFixed(2)}`);
        if (st.day >= 2) break;
      }
      return `stops: ${stops.join(", ")}`;
    },
  },
  // Maya, 11 Nov: the paths the stale simulator bundle blocked.
  "helm-norfolk": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page, async (p) => {
        await p.waitForFunction(() => !document.querySelector("#portpick").hidden, null, { timeout: MIN }).catch(() => {
          throw new CheckFail("the port picker never appeared");
        });
        await p.selectOption("#port", "norfolk");
      });
      const st = await hop(page, "#sday");
      must(!(st.stop === "land" && st.day < 0.05), `an instant "land" stop at day ${st.day}`);
      return `from Norfolk to day ${st.day.toFixed(2)} (stop ${st.stop}, ${st.secs} s)`;
    },
  },
  ...Object.fromEntries(
    [["helm-drone", "stock_sail_drone7"], ["helm-rower", "stock_ocean_rower45"], ["helm-cruiser", "stock_cruiser31"], ["helm-pearson", "stock_pearson31_2"]].map(([n, b]) => [
      n,
      {
        path: "helm.html?quality=low",
        run: async (page) => {
          await helmStart(page, async (p) => {
            const r = p.locator(`input[name="boat"][value="${b}"]`);
            // Only boats in PLAYABLE_STOCK (sea3d/src/boats/specs.ts) are offered; others skip.
            if ((await r.count()) !== 1) throw new SkipCheck(`${b} isn't offered in the helm's boat picker`);
            await tickBoat(r);
          });
          const st = await hop(page, "#sday");
          return `${b} to day ${st.day.toFixed(2)} (stop ${st.stop}, ${st.secs} s)`;
        },
      },
    ]),
  ),
  "helm-cinematic": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page);
      await hop(page, "#s6");
      return cinematic(page, () => window.__helm.frames);
    },
  },
  "voyage-cinematic": {
    path: "voyage.html?voyage=2020-04-15&quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN });
      const err = await page.evaluate(() => window.__replay.error);
      must(!err, `the replay didn't load: ${err}`);
      return cinematic(page, () => window.__replay.frames);
    },
  },
  boatyard: {
    path: "boatyard.html",
    run: async (page) => {
      await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 2, null, { timeout: 2 * MIN });
      await page.click("#launch");
      await page.waitForFunction(() => window.__yard.launch || window.__yard.launchError, null, { timeout: 15 * MIN });
      const r = await page.evaluate(() => ({ backend: window.__yard.backend, err: window.__yard.launchError, n: window.__yard.launch?.replays?.length ?? 0 }));
      must(!r.err, `the launch failed: ${r.err}`);
      must(r.n > 0, "the launch gave no voyages");
      return `launched via ${r.backend}: ${r.n} voyages`;
    },
  },
  race: {
    path: "race.html",
    run: async (page) => {
      await page.waitForFunction(() => !!window.__race, null, { timeout: MIN });
      await page.click("#go");
      await page.waitForFunction(() => window.__race.ready || window.__race.error, null, { timeout: 8 * MIN });
      const s = await page.evaluate(() => ({ ready: window.__race.ready, err: window.__race.error, msg: document.querySelector("#msg")?.textContent }));
      must(s.ready && !s.err, `didn't start: ${s.err}; the page says "${s.msg}"`);
      return "race started";
    },
  },
  // Results (#307): play "until something happens" to the end of the voyage; the
  // card says where the build stands and offers the three ways on, which work.
  "helm-results": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page);
      if (!(await page.$("#r-next"))) throw new SkipCheck("the deployed helm has no Results 'where this leaves you' yet");
      // The finish scene (#334): note whether the banner showed before the card.
      await page.evaluate(() => {
        const a = document.getElementById("arrive");
        if (a) new MutationObserver(() => { if (!a.hidden) window.__sawArrive = document.getElementById("arrivehead")?.textContent || "(no headline)"; }).observe(a, { attributes: true });
      });
      let hops = 0;
      for (; hops < 60 && !(await page.evaluate(() => window.__helm.card)); hops++) {
        // The voyage can end while the button is hidden behind the card: wait for the card then.
        if (!(await page.evaluate(() => window.__helm.card))) await openOrders(page);
        if (!(await page.locator("#sevent").isVisible())) {
          await page.waitForFunction(() => window.__helm.card || window.__helm.error, null, { timeout: 4 * MIN }).catch(() => {
            throw new CheckFail(`"Sail until something happens" disappeared at hop ${hops} and no results card came`);
          });
          break;
        }
        const st = await hop(page, "#sevent");
        if (st.stop === "over") await page.waitForFunction(() => window.__helm.card || window.__helm.error, null, { timeout: 4 * MIN });
      }
      const card = await page.evaluate(() => window.__helm.card);
      must(card, `no results card after ${hops} hops of "until something happens"`);
      const arrive = await page.evaluate(() => ({ outcome: window.__helm.card?.boat?.outcome, saw: window.__sawArrive ?? null, has: !!document.getElementById("arrive") }));
      if (arrive.has && arrive.outcome === "arrived") must(arrive.saw, "the boat arrived but the finish scene's banner never showed");
      must(await page.locator("#result").isVisible(), "the results card isn't shown");
      await page.waitForFunction(() => window.__helm.standing, null, { timeout: MIN }).catch(() => {
        throw new CheckFail("the results card never said where the build stands");
      });
      const next = await page.evaluate(() => ({
        kind: window.__helm.standing,
        head: document.querySelector("#r-next .standing")?.textContent ?? "",
        // The ways on: under the standing line (before #406), or the card's button row and quiet links (#406).
        links: [...document.querySelectorAll("#r-next .next a, #result .rc-btns a, #result .rc-links a")].map((a) => ({ text: a.textContent, href: a.getAttribute("href") })),
      }));
      must(next.head.trim(), "the standing line is empty");
      for (const want of [/boatyard/, /race|against=/, /leaderboard/]) must(next.links.some((l) => want.test(l.href ?? "")), `no ${want.source} link among the ways on: ${JSON.stringify(next.links)}`);
      await page.screenshot({ path: `play-${BROWSER}-results-card.png` }).catch(() => {});
      // Follow the leaderboard link like a player: the board loads.
      const lb = next.links.find((l) => /leaderboard/.test(l.href));
      must(lb, "no Leaderboard link on the card");
      const link = page.locator(`#result a[href="${lb.href}"]`).first();
      await link.scrollIntoViewIfNeeded().catch(() => {});
      await link.click({ timeout: 15_000 }).catch((e) => {
        throw new CheckFail(`the card's Leaderboard link can't be clicked: ${String(e).split("\n")[0]}`);
      });
      await page.waitForFunction(() => window.__leaderboard?.ready, null, { timeout: MIN }).catch(() => {
        throw new CheckFail(`the card's Leaderboard link (${lb.href}) didn't open a working board`);
      });
      return `${hops} hops to the card (${card.verdict}, day ${card.boat.days.toFixed(1)}); "${next.head.trim()}" [${next.kind}]; links ${next.links.map((l) => l.text.trim()).join(" / ")}; the Leaderboard link opened the board${arrive.saw ? `; finish scene: "${arrive.saw}"` : `; outcome ${arrive.outcome}, no finish scene`}`;
    },
  },
  // Randolph Rev C5 preset (#304): labelled as our model, its weight, and it launches.
  "boatyard-revc5": {
    path: "boatyard.html?quality=low#base=revc",
    run: async (page) => {
      await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 2, null, { timeout: 2 * MIN });
      // The button's accessible name: since #416 "our model" is said once for both Randolph boats,
      // beside them and in each button's aria-label, rather than on every button's face.
      const rc = page.locator('#bases button[data-base="revc"]');
      const label = ((await rc.getAttribute("aria-label").catch(() => null)) || (await rc.textContent().catch(() => "")) || "");
      if (!/C5/.test(label)) throw new SkipCheck(`the deployed Boatyard has no Rev C5 preset yet ("${label.trim()}")`);
      const pressed = await page.getAttribute('#bases button[data-base="revc"]', "aria-pressed");
      must(pressed === "true", "opening #base=revc didn't select the Rev C5 preset");
      must(/our model/i.test(label), `the preset isn't labelled as our model: "${label.trim()}" (${await page.evaluate(() => JSON.stringify([...document.querySelectorAll('[data-base="revc"]')].map((e) => [e.closest("[id]")?.id, e.getAttribute("aria-label"), e.textContent.trim()])))})`);
      // The boat's totals fill in a moment after the preset is picked: give them a few seconds.
      const shown = await page.waitForFunction(() => /26\.9\s*kg/.test(document.body.innerText), null, { timeout: 20_000 }).then(() => true).catch(() => false);
      const kg = shown ? "" : await page.evaluate(() => (document.body.innerText.match(/\d+(\.\d)?\s*kg/g) || []).slice(0, 4).join(", "));
      must(shown, `the page doesn't show 26.9 kg for the Rev C5's boat after 20 s (weights on the page: ${kg || "none"})`);
      await page.screenshot({ path: `play-${BROWSER}-revc5.png` }).catch(() => {});
      await page.click("#launch");
      await page.waitForFunction(() => window.__yard.launch || window.__yard.launchError, null, { timeout: 15 * MIN });
      const r = await page.evaluate(() => ({ err: window.__yard.launchError, n: window.__yard.launch?.replays?.length ?? 0 }));
      must(!r.err, `the Rev C5 launch failed: ${r.err}`);
      must(r.n > 0, "the Rev C5 launch gave no voyages");
      return `"${label.trim()}" selected, 26.9 kg shown, launched: ${r.n} voyages`;
    },
  },
  // "My boat" (#310): a Boatyard design saved as my boat carries to the helm,
  // race and voyage pages in the same browser. The name has tags in it, which
  // must show as plain text everywhere: the visible text has to include them
  // literally (the page's own <b> formatting around the name is fine). Skips until the deployed Boatyard has it.
  // #346: a hint by the replay's speed bar for a few seconds as a replay opens.
  "voyage-hint": {
    path: "voyage.html?quality=low",
    run: async (page) => {
      if (!(await page.locator("#warphint").count())) throw new SkipCheck("this build has no speed-bar hint (#346 not deployed)");
      const text = await page.waitForFunction(() => { const e = document.getElementById("warphint"); return !e.hidden && e.textContent.trim(); }, null, { timeout: 2 * MIN }).then((h) => h.jsonValue()).catch(() => "");
      must(text, "no hint showed by the speed bar as the replay opened");
      await page.screenshot({ path: `play-${BROWSER}-warphint.png` }).catch(() => {});
      const gone = await page.waitForFunction(() => document.getElementById("warphint").hidden, null, { timeout: 15_000 }).then(() => true).catch(() => false);
      must(gone, `the speed-bar hint "${text}" didn't go away`);
      return `hint "${text}" showed, then went`;
    },
  },
  // #344: the Boatyard's odds update as you swap a part, and parts show how they'd change them.
  "boatyard-odds": {
    path: "boatyard.html?quality=low",
    run: async (page) => {
      if (!(await page.locator("#s-odds").count())) throw new SkipCheck("this build has no live odds (#344 not deployed)");
      await page.waitForFunction(() => /\d+%/.test(document.getElementById("s-odds").textContent) && document.querySelector(".opt .delta.up, .opt .delta.down"), null, { timeout: 2 * MIN }).catch(async () => {
        const t = await page.evaluate(() => document.getElementById("s-odds").textContent);
        throw new CheckFail(`no odds with part changes showed (odds "${t}")`);
      });
      const before = await page.evaluate(() => document.getElementById("s-odds").textContent.trim());
      const opt = page.locator(".opt:has(.delta.down), .opt:has(.delta.up)").first();
      const delta = (await opt.locator(".delta").textContent())?.trim();
      // Sections and slots fold to one line (#416): open the ones holding this part first. Old builds: no-ops.
      const where = await opt.evaluate((el) => ({ group: el.closest(".slot[data-group]")?.getAttribute("data-group") ?? null, gopen: !!el.closest(".slot[data-group]")?.classList.contains("gopen"), slot: el.closest(".sl")?.getAttribute("data-slot") ?? null, sopen: !!el.closest(".sl")?.classList.contains("open") }));
      if (where.group && !where.gopen) await page.locator(`.slot[data-group="${where.group}"] h3`).click();
      if (where.slot && !where.sopen) await page.locator(`.sl-head[data-slot="${where.slot}"]`).click();
      await opt.scrollIntoViewIfNeeded().catch(() => {});
      await opt.click({ noWaitAfter: true, timeout: 30_000 }).catch(async (e) => {
        const why = await opt.evaluate((el) => { const r = el.getBoundingClientRect(); return { text: el.textContent.trim().slice(0, 60), box: [r.x, r.y, r.width, r.height].map(Math.round), hiddenBy: el.closest("[hidden], details:not([open])")?.outerHTML.slice(0, 120) ?? "", where: el.closest(".slot")?.outerHTML.slice(0, 160) ?? "" }; }).catch(() => ({}));
        throw new CheckFail(`couldn't click the part marked ${delta}: ${JSON.stringify({ where, ...why })} (${String(e).split("\n")[0]})`);
      });
      const after = await page.waitForFunction((b) => { const t = document.getElementById("s-odds").textContent.trim(); return t !== b && /\d+%/.test(t) && t; }, before, { timeout: 30_000 }).then((h) => h.jsonValue()).catch(() => "");
      must(after, `picking a part marked ${delta} left the odds at "${before}"`);
      await page.screenshot({ path: `play-${BROWSER}-odds.png` }).catch(() => {});
      return `odds ${before}, picked a part marked ${delta}, now ${after}`;
    },
  },
  // #309 (first-time items 10 and 23): the title menu shows on a first visit, "Just watch the sea"
  // brings the sea panel back (with "Sail this sea", #349), and every top-bar link opens its page with the bar.
  "title-nav": {
    path: "?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 5, null, { timeout: 2 * MIN });
      if (!(await page.locator("#title").count())) throw new SkipCheck("this build has no title menu (#309 not deployed)");
      must(await page.locator("#title").isVisible(), "the title menu didn't show on a first visit");
      const menu = await page.evaluate(() => [...document.querySelectorAll("#title a, #title button")].filter((e) => e.offsetParent).map((e) => e.textContent.trim().split("\n")[0]));
      await page.screenshot({ path: `play-${BROWSER}-title.png` }).catch(() => {});
      // "Just watch the sea" lives under More since the one-front-door title (#437): open it first.
      if (await page.locator("#t-more").count()) await page.click("#t-more summary", { timeout: 10_000 }).catch(() => {});
      await page.click("#t-sea", { noWaitAfter: true, timeout: 10_000 }).catch(() => {
        throw new CheckFail(`couldn't click "Just watch the sea"`);
      });
      await page.waitForFunction(() => document.getElementById("title").hidden, null, { timeout: 10_000 }).catch(() => {
        throw new CheckFail(`"Just watch the sea" didn't close the menu`);
      });
      must(await page.locator("#panel").isVisible(), `"Just watch the sea" didn't bring the sea panel back`);
      const way = await page.locator("#sail").isVisible().catch(() => false);
      // The bar's own links plus the ones in its More menu (since #437 the bar shows three and keeps the rest under More).
      const BAR = "#topbar a.nav, #topbar .more .menu a:not([target])";
      const links = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((a) => ({ href: a.href, text: (a.querySelector(".l") ?? a).textContent.trim() })), BAR);
      must(links.length >= 5, `the top bar has ${links.length} links: ${JSON.stringify(links)}`);
      const bad = [];
      // Each link in its own tab: leaving this page mid-load would abort its textures (console noise, not a fault).
      for (const l of links) {
        const tab = await page.context().newPage();
        const r = await tab.goto(l.href, { waitUntil: "load", timeout: 2 * MIN }).catch((e) => ({ status: () => String(e).split("\n")[0] }));
        const st = r?.status?.() ?? "no response";
        const bar = await tab.locator(BAR).count().catch(() => 0);
        await tab.close().catch(() => {});
        if (st !== 200 || bar < 3) bad.push(`${l.text} (${l.href}): HTTP ${st}, ${bar} bar links`);
      }
      must(!bad.length, `top bar links that don't open a page with the bar: ${bad.join("; ")}`);
      return `menu: ${menu.join(" / ")}; sea panel back${way ? ' with "Sail this sea"' : ""}; ${links.length} bar links all open (${links.map((l) => l.text).join(", ")})`;
    },
  },
  // Not a pass/fail check: run by name only (`play.mjs look`, or the playtest dispatch's
  // "checks" input). Screenshots of the live pages at 1280x720 and High quality for
  // the Creative Director, whose sandbox can't open github.io. The thread sandboxes
  // can't fetch run artifacts either, so each JPEG is also printed to the log in base64
  // between LOOK-BEGIN/LOOK-END lines, to be decoded back into files from the job log.
  look: {
    manual: true,
    path: "",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      const go = async (path, ready, settle = 4000) => {
        await page.goto(SITE + path, { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(ready, null, { timeout: 3 * MIN }).catch(() => {});
        await page.waitForTimeout(settle);
      };
      // 1. Title screen over the sea.
      await go("", () => window.__sea3d && window.__sea3d.frames > 30, 6000);
      await shot("01-index-title");
      // 2. Helm start card; 3. after Set sail, at about day 2, paused.
      await go("helm.html", () => window.__helm && window.__helm.frames > 30, 5000);
      await shot("02-helm-start-card");
      await page.click("#go").catch(() => {});
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN }).catch(() => {});
      await page.click("#soundno", { timeout: 3000 }).catch(() => {});
      await page.waitForFunction(() => (window.__helm.status?.day ?? 0) >= 2 || window.__helm.clock === 0, null, { timeout: 4 * MIN }).catch(() => {});
      if (!(await page.locator("#decide").isVisible().catch(() => false))) await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
      await page.waitForTimeout(4000);
      await shot("03-helm-sailing-day2");
      // 4. Practice sailing.
      await go("helm.html?practice", () => window.__helm && window.__helm.frames > 30, 6000);
      await shot("04-practice-sailing");
      // 5. Watch a voyage, default view; 6-8. cinematic, three frames 10 s apart.
      await go("voyage.html", () => window.__replay && (window.__replay.frames ?? 0) > 30, 8000);
      await shot("05-voyage-default");
      await page.click("#cinebtn", { noWaitAfter: true, timeout: 10_000 }).catch(() => {});
      for (const n of ["06", "07", "08"]) {
        await page.waitForTimeout(n === "06" ? 4000 : 10_000);
        await shot(`${n}-voyage-cinematic`);
      }
      // 9. Boatyard, 10. race, 11. leaderboard.
      await go("boatyard.html", () => window.__yard?.ready && window.__yard.frames > 30, 5000);
      await shot("09-boatyard");
      await go("race.html", () => document.readyState === "complete", 5000);
      await shot("10-race");
      await go("leaderboard.html", () => window.__leaderboard?.ready, 3000);
      await shot("11-leaderboard");
      return `${shots.length} looks: ${shots.join(", ")}`;
    },
  },
  // Manual: the helm at night (#373), 1 Apr 2020 kayak, paused near 1 AM local on 2 Apr
  // (about day 0.75) and at day 1.5, each with the panels and in cinematic mode. Printed to the log like "look".
  "look-night": {
    manual: true,
    path: "helm.html",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 3 * MIN });
      await page.evaluate(() => { const d = document.getElementById("more"); if (d) d.open = true; });
      const day = page.locator("#launch");
      if (await day.count()) await day.selectOption("0").catch(() => {});
      await page.click("#go");
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      await page.click("#soundno", { timeout: 3000 }).catch(() => {});
      for (const target of [0.75, 1.5]) {
        await page.evaluate(() => { if (window.__helm.clock === 0) document.querySelector('#timebar .rate[data-rate="6"]')?.click(); });
        await page.evaluate(() => document.querySelector("#decidebtns button")?.click());
        await page.waitForFunction((t) => (window.__helm.hour ?? 0) / 24 >= t || window.__helm.clock === 0, target, { timeout: 4 * MIN }).catch(() => {});
        await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
        await page.waitForTimeout(5000);
        const when = await page.evaluate(() => `${document.getElementById("clock")?.textContent} ${document.getElementById("local")?.textContent}`.replace(/[^\w.:+-]+/g, "_"));
        await shot(`night-${target}-panels-${when}`.slice(0, 80));
        await page.click("#cinebtn", { noWaitAfter: true, timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(6000);
        await shot(`night-${target}-cinematic`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(1500);
      }
      return `${shots.length} looks: ${shots.join(", ")}`;
    },
  },
  // Manual: Elena's #376 set at 1280x720 and 1920x1080: Practice by day, the default helm screen
  // (sailing, drawer shut) and the orders drawer open. Printed to the log like "look".
  "look-376": {
    manual: true,
    path: "",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      for (const [w, h] of [[1280, 720], [1920, 1080]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(SITE + "helm.html?practice", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 3 * MIN }).catch(() => {});
        await page.evaluate(() => document.querySelector("#ss-course-opts .ss-pill")?.click()); // the triangle, on the Set sail card
        await page.click("#go", { timeout: 30_000 }).catch(() => {});
        await page.waitForFunction(() => window.__wheel?.on, null, { timeout: MIN }).catch(() => {});
        await page.waitForTimeout(8000);
        await shot(`${w}-practice-day`);
        await page.goto(SITE + "helm.html", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 3 * MIN }).catch(() => {});
        await page.click("#go").catch(() => {});
        await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN }).catch(() => {});
        // The clock runs by itself after Set sail (#339); pause it so the frame is the first screen
        // the player sees (morning on 23 Apr), not however far it ran on software graphics (Rosa).
        await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
        await page.click("#soundno", { timeout: 3000 }).catch(() => {});
        // The drawer opens by itself for 10 s at the start; the default screen is after it shuts.
        await page.waitForFunction(() => !document.querySelector("#orders.open"), null, { timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(4000);
        await shot(`${w}-helm-default`);
        await page.click("#orders-tab", { timeout: 15_000 }).catch(() => {});
        await page.waitForFunction(() => { const o = document.getElementById("orders"); return o?.classList.contains("open") && o.getBoundingClientRect().x >= 0; }, null, { timeout: 20_000 }).catch(() => {});
        await page.hover("#orders h2", { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1500);
        await shot(`${w}-helm-orders-open`);
      }
      return `${shots.length} looks: ${shots.join(", ")}`;
    },
  },
  // Manual: #381, Take the wheel in Practice (triangle) on both tacks: the boat should lean away
  // from the wind and the sail sit on the side away from it. Frames printed to the log; the
  // wheel panel's wind line says which side the wind is on.
  "look-heel": {
    manual: true,
    path: "helm.html?practice",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      // The wheel panel's wind line: "upwind, left" etc. (wheelSession.ts); older builds said "on the port side".
      const SIDE = /(?:upwind|reach|behind), (left|right)|off the bow on the (port|starboard)/;
      const wind = () => page.evaluate((src) => (document.body.innerText.match(new RegExp(src)) || [""])[0], SIDE.source);
      const left = (w) => /left|port/.test(w);
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 3 * MIN });
      await practiceTriangle(page);
      // Skip every lesson step (step 2 puts the sail out of trim on purpose), and let the
      // auto-trim keep the sail drawing so she sails through the turn instead of stalling head to wind.
      for (let i = 0; i < 4; i++) await page.click(".w-gskip", { timeout: 2000 }).catch(() => {});
      if (/\(off\)/.test(await page.evaluate(() => document.body.innerText.match(/auto-trim \((on|off)\)/i)?.[0] ?? ""))) await page.keyboard.press("t");
      await page.waitForTimeout(6000);
      const a = await wind();
      await shot("heel-tack-a");
      must(SIDE.test(a), `couldn't read which side the wind is on ("${a}")`);
      // Tack: turn toward the wind (left when it's on the left) until it comes over to the other side (up to 25 s).
      // On a runner's software graphics the boat's clock runs far slower than ours (a tack is ~12 s
      // of boat time), so turn at 10x until the wheel counts a tack and the wind line reads the other side, then back to 1x.
      const key = left(a) ? "ArrowLeft" : "ArrowRight";
      const tacks0 = await page.evaluate(() => window.__wheel?.wheel?.s?.tacks ?? 0);
      await page.click('.w-rate button[data-x="10"], button[data-x="10"]', { timeout: 5000 }).catch(() => page.keyboard.press("4"));
      await page.keyboard.down(key);
      await page.waitForFunction(([src, wasLeft, t0]) => {
        // Past the tack itself, keep turning until she's sailing on the new side (out of "too close").
        if ((window.__wheel?.wheel?.s?.tacks ?? 0) <= t0) return false;
        const m = document.body.innerText.match(new RegExp(src));
        return m && /left|port/.test(m[0]) !== wasLeft;
      }, [SIDE.source, left(a), tacks0], { timeout: 90_000 }).catch(() => {});
      await page.waitForTimeout(800);
      await page.keyboard.up(key);
      await page.waitForTimeout(4000);
      await page.click('button[data-x="1"]', { timeout: 5000 }).catch(() => page.keyboard.press("1"));
      await page.waitForTimeout(4000);
      const b = await wind();
      const tacks = (await page.evaluate(() => window.__wheel?.wheel?.s?.tacks ?? 0)) - tacks0;
      await shot("heel-tack-b");
      // A look check: the frames are what Elena judges. A missed tack is reported, not a failure,
      // since on software graphics it can be the runner's speed rather than the game.
      const tacked = SIDE.test(b) && left(a) !== left(b);
      return `tack A: "${a}"; tack B: "${b}"; ${tacked ? `tacked (${tacks} by the wheel's count)` : `NOT on the other tack (wheel counted ${tacks})`}; ${shots.join(", ")}`;
    },
  },
  // Manual: #379, close frames of the kayak's bow (no "V4") in the Boatyard (zoomed in, from
  // a few sides) and in the voyage replay's cinematic view. Printed to the log like "look".
  "look-bow": {
    manual: true,
    path: "boatyard.html",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 30, null, { timeout: 3 * MIN });
      await page.waitForTimeout(3000);
      const c = await page.locator("canvas").first().boundingBox();
      const cx = c.x + c.width / 2, cy = c.y + c.height / 2;
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(150); }
      await page.waitForTimeout(1500);
      await shot("bow-yard-1");
      for (const [n, dx] of [["2", 220], ["3", -440]]) {
        await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + dx, cy, { steps: 12 }); await page.mouse.up();
        await page.waitForTimeout(1500);
        await shot(`bow-yard-${n}`);
      }
      await page.goto(SITE + "voyage.html", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__replay && (window.__replay.frames ?? 0) > 30, null, { timeout: 3 * MIN }).catch(() => {});
      await page.click("#cinebtn", { noWaitAfter: true, timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(5000);
      await shot("bow-voyage-cinematic");
      return `${shots.length} looks: ${shots.join(", ")}`;
    },
  },
  // Manual: looks at "Continue your voyage" (#462, #465) and at Race it on the sailing screen
  // (#456, #469) on the live site, printed to the log like "look". Both need the simulator.
  "look-continue-race": {
    manual: true,
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      const out = [];
      const shot = async (name) => {
        const path = `lcr-${BROWSER}-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
      };
      const ready = () => page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      // 1. Sail a crossing for a day or so, then leave: the title and the Set sail card offer it back.
      await helmStart(page);
      await page.evaluate(() => document.querySelector('#timebar .rate[data-rate="6"]')?.click());
      await page.waitForFunction(() => (window.__helm.status?.day ?? 0) >= 1.5, null, { timeout: 3 * MIN }).catch(() => {});
      await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
      await page.waitForTimeout(3000);
      // Paused for 3 s, then left (#482, Sam): the save's "left" is the day on the screen as the
      // page went, and "day", where the simulator's code stands, is never behind it. The day on
      // the screen is noted as the page goes, as the keeper does.
      await page.evaluate(() => addEventListener("pagehide", () => sessionStorage.setItem("omar.left", String(window.__helm.hour / 24))));
      const left = { day: NaN, saved: null };
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      for (const [w, h, tag] of [[1280, 720, "1280"], [375, 667, "375"]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(SITE, { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 20, null, { timeout: 2 * MIN }).catch(() => {});
        await page.waitForTimeout(4000);
        const t = await page.evaluate(() => { const a = document.getElementById("t-continue"); const c = document.getElementById("title"); return { shown: !!a && !a.hidden && a.offsetParent !== null, text: (a?.innerText ?? "").replace(/\s+/g, " "), scrolls: c.scrollHeight > c.clientHeight + 1 }; });
        if (!left.saved) {
          Object.assign(left, await page.evaluate(() => ({ day: Number(sessionStorage.getItem("omar.left")), saved: JSON.parse(localStorage.getItem("boatsim.voyage.v1") ?? "null") })));
          must(left.saved, `no crossing was saved in the browser after pausing and leaving on day ${left.day.toFixed(2)}`);
          must(typeof left.saved.left === "number" && Math.abs(left.saved.left - left.day) <= 0.05, `paused for 3 s and left on day ${left.day.toFixed(2)}, but the save says she was left on day ${left.saved.left}`);
          must(left.saved.day >= left.saved.left, `the save's code stands at day ${left.saved.day}, behind the day she was left on (${left.saved.left})`);
          out.push(`paused 3 s and left on day ${left.day.toFixed(2)}; the save says left on day ${left.saved.left}, code at day ${left.saved.day}`);
        }
        await shot(`title-${tag}`);
        must(t.shown, `the title doesn't offer "Continue your voyage" at ${tag} after a crossing was left at day ${left.day}`);
        out.push(`title ${tag}: "${t.text}"${t.scrolls ? " (the menu scrolls inside itself)" : ""}`);
        await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      }
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(SITE + "helm.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await page.waitForTimeout(3000);
      const card = await page.evaluate(() => { const c = document.getElementById("ss-continue"); return { shown: !!c && !c.hidden, text: (c?.innerText ?? "").replace(/\s+/g, " ") }; });
      await shot("card");
      must(card.shown, "the Set sail card doesn't offer the saved crossing");
      await page.click("#go", { noWaitAfter: true, timeout: 30_000 });
      await page.waitForTimeout(1000);
      const ask = await page.evaluate(() => { const a = document.getElementById("ss-ask"); return { shown: !!a && !a.hidden, text: (a?.innerText ?? "").replace(/\s+/g, " ") }; });
      await shot("ask");
      must(ask.shown, "Set sail didn't ask before a new crossing ends the saved one");
      out.push(`card: "${card.text}"; ask: "${ask.text}"`);
      await page.click("#ss-ask-keep", { noWaitAfter: true, timeout: 15_000 });
      await page.waitForFunction(() => /continue=1/.test(location.search) && window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await ready();
      await page.waitForTimeout(5000);
      const back = await page.evaluate(() => ({ day: window.__helm.hour / 24, err: window.__helm.error, clock: window.__helm.clock, rt: document.querySelector("#timebar .rate")?.dataset.rate, notes: document.getElementById("notes").innerText.replace(/\s+/g, " ") }));
      await shot("continued");
      must(!back.err && Math.abs(back.day - left.day) <= 0.05, `"Keep sailing" didn't come back where she was left: left day ${left.day}, back ${JSON.stringify(back)}`);
      must(/right where you left off/.test(back.notes), `back on the day she was left, but the welcome doesn't say "right where you left off": "${back.notes.slice(0, 200)}"`);
      must(back.rt === "rt", `Real time isn't first on the speed bar after continuing (${back.rt})`);
      out.push(`continued on day ${back.day.toFixed(2)} (left on ${left.day.toFixed(2)})`);
      // 2. Race it on the sailing screen: our kayak against our model of the Rev C5, 1 May 2020.
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await page.goto(SITE + "helm.html?race=kayak,revc&launch=2&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await ready();
      await page.waitForTimeout(5000);
      const bar = () => page.evaluate(() => ({ view: window.__helm.view, day: window.__helm.status?.day, over: !!window.__helm.status?.over, err: window.__helm.error, shown: !document.getElementById("timebar").hidden, rates: [...document.querySelectorAll("#timebar .rate")].filter((e) => e.offsetParent).map((e) => e.dataset.rate + (e.getAttribute("aria-pressed") === "true" ? "*" : "")), strip: document.getElementById("strip").innerText.replace(/\s+/g, " ") }));
      const r0 = await bar();
      await shot("race-start");
      must(!r0.err && r0.view === "race", `the race didn't open on the sailing screen: ${JSON.stringify(r0)}`);
      must(r0.shown && r0.rates[0]?.startsWith("rt"), `Real time isn't first on the race's speed bar: ${JSON.stringify(r0.rates)}`);
      await page.evaluate(() => document.querySelector('#timebar .rate[data-rate="24"]')?.click());
      await page.waitForFunction(() => (window.__helm.status?.day ?? 0) >= 3 || window.__helm.status?.over, null, { timeout: 4 * MIN }).catch(() => {});
      await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
      await page.waitForTimeout(4000);
      const r1 = await bar();
      await shot("race-day3");
      out.push(`race: opens (${r0.rates.join(" ")}), strip "${r0.strip.slice(0, 160)}"; later day ${r1.day?.toFixed(1)}, over ${r1.over}, strip "${r1.strip.slice(0, 160)}"`);
      return out.join("; ");
    },
  },
  // Manual: what a saved crossing promises (#482, Sam's bounds, 13 Nov). The save is
  // localStorage boatsim.voyage.v1: "day" is where the simulator's code stands, "left" the day
  // on the screen when the page was last written. Leaving is a navigation to the title, which
  // fires pagehide as closing the tab does.
  "continue-save": {
    manual: true,
    path: "helm.html?quality=low",
    run: async (page) => {
      const out = [];
      const ready = () => page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      const saved = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem("boatsim.voyage.v1") ?? "null"); } catch { return null; } });
      const rate = (r) => page.evaluate((r) => document.querySelector(`#timebar .rate[data-rate="${r}"]`)?.click(), r);
      const play = () => page.evaluate(() => { if (!(window.__helm.clock > 0)) document.getElementById("t-pause")?.click(); });
      /** Keep her sailing until the simulator (or, with `screen`, the picture) reaches `day`: a
       *  call or an event pauses the clock, and play is pressed again. Where she stands at the end. */
      const sailTo = async (day, ms, screen = false) => {
        const end = Date.now() + ms;
        for (;;) {
          const st = await page.evaluate(() => ({ sim: window.__helm.status?.day ?? 0, screen: window.__helm.hour / 24, over: !!window.__helm.status?.over, clock: window.__helm.clock, busy: !!window.__helm.busy }));
          if (st.over || ((screen ? st.screen : st.sim) >= day && st.clock > 0) || Date.now() > end) return st;
          if (!(st.clock > 0) && !st.busy) await play();
          await page.waitForTimeout(400);
        }
      };
      /** Leave for the title while she runs; the day on the screen is noted as the page goes. */
      const leave = async () => {
        await page.evaluate(() => addEventListener("pagehide", () => sessionStorage.setItem("omar.left", String(window.__helm.hour / 24))));
        await page.goto(SITE, { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 20, null, { timeout: 2 * MIN }).catch(() => {});
        const t = await page.evaluate(() => { const a = document.getElementById("t-continue"); return { on: Number(sessionStorage.getItem("omar.left")), shown: !!a && !a.hidden, sub: document.getElementById("t-continue-sub")?.textContent ?? "", href: a?.getAttribute("href") ?? "" }; });
        return { ...t, v: await saved() };
      };
      /** Come back by the title's own link; checks the day and the welcome against the save. */
      const comeBack = async (t, what) => {
        const stands = Math.min(t.v.day, t.v.left);
        // 6. The title's "Day N" is the whole part of the day she comes back on.
        const want = stands < 1 ? "The first day" : `Day ${Math.floor(stands)}`;
        must(t.shown && t.sub.startsWith(want), `${what}: the title says "${t.sub}", but she comes back on day ${stands.toFixed(2)} ("${want}")`);
        await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
        await page.goto(new URL(t.href, SITE).href + "&quality=low", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
        await ready();
        await page.waitForTimeout(4000);
        const b = await page.evaluate(() => ({ day: window.__helm.hour / 24, err: window.__helm.error, notes: document.getElementById("notes").innerText.replace(/\s+/g, " ") }));
        must(!b.err, `${what}: coming back failed: ${b.err}`);
        must(Math.abs(b.day - stands) <= 0.05, `${what}: came back on day ${b.day.toFixed(2)}, the save stands at day ${stands.toFixed(2)} (left ${t.v.left}, code ${t.v.day})`);
        const same = /right where you left off/.test(b.notes);
        if (Math.abs(b.day - t.v.left) <= 0.05) must(same, `${what}: back on the day she was left (${b.day.toFixed(2)}), but the welcome doesn't say so: "${b.notes.slice(0, 200)}"`);
        else {
          must(!same, `${what}: the welcome says "right where you left off" on day ${b.day.toFixed(2)}, but she was left on day ${t.v.left}`);
          must(b.notes.includes(`day ${t.v.left.toFixed(1)}`) && b.notes.includes(`day ${b.day.toFixed(1)}`), `${what}: back on day ${b.day.toFixed(2)}, not the day she was left (${t.v.left}), and the welcome doesn't name both days: "${b.notes.slice(0, 200)}"`);
        }
        return `${what}: on screen day ${t.on.toFixed(2)} as she was left, save left ${t.v.left} code ${t.v.day}, title "${t.sub}", back on day ${b.day.toFixed(2)}${same ? ", right where you left off" : ", told it was saved a little before"}`;
      };
      await helmStart(page);
      // 4. Real time: after 20 s the save's "left" is the day on the screen.
      await rate("rt");
      await play();
      await page.waitForTimeout(20_000);
      const rt = await page.evaluate(() => ({ day: window.__helm.hour / 24, v: JSON.parse(localStorage.getItem("boatsim.voyage.v1") ?? "null") }));
      must(rt.v && typeof rt.v.left === "number" && Math.abs(rt.v.left - rt.day) <= 0.01, `real time for 20 s: day ${rt.day.toFixed(3)} on screen, the save says ${JSON.stringify(rt.v && { left: rt.v.left, day: rt.v.day })}`);
      out.push(`real time 20 s: screen day ${rt.day.toFixed(3)}, save left ${rt.v.left}`);
      // 2. Leave without pausing at 6 h a second.
      await rate("6");
      // (On a runner's software graphics Chrome's picture can take minutes to show a day: a third of one will do.)
      let at = await sailTo(1.5, 3 * MIN, true);
      must(!at.over && at.clock > 0 && at.screen >= 0.3, `6 h a second: the picture didn't sail on and keep going: ${JSON.stringify(at)}`);
      let t = await leave();
      must(t.v, "6 h a second: nothing was saved on leaving");
      must(Math.abs(t.v.left - t.on) <= 0.1, `6 h a second: left on day ${t.on.toFixed(2)}, the save says left on day ${t.v.left}`);
      must(t.v.day >= t.v.left - 0.5, `6 h a second: the save's code stands at day ${t.v.day}, more than half a day before she was left (${t.v.left})`);
      out.push(await comeBack(t, "6 h a second, not paused"));
      // 5. An order: send one, wait 3 s, leave without pausing; back and playing, the strip shows it.
      await play();
      await openOrders(page);
      await page.click("#b-finish", { timeout: 15_000 });
      const sent = await page.evaluate(() => document.getElementById("c-orderv").textContent);
      await page.waitForTimeout(3000);
      t = await leave();
      must(t.v, "an order: nothing was saved on leaving");
      out.push(await comeBack(t, "after an order"));
      await play();
      await page.waitForTimeout(3000);
      const order = await page.evaluate(() => document.getElementById("c-orderv").textContent);
      must(order === sent && /finish/i.test(order), `the order sent before leaving was "${sent}"; back and playing, the strip shows "${order}"`);
      out.push(`order kept: "${order}"`);
      // 3. Leave without pausing at 4 days a second.
      // (Left once the simulator is 8 days on: a runner's Chrome draws the picture far behind it.)
      const from = await page.evaluate(() => window.__helm.status?.day ?? 0);
      await rate("96");
      const fast = await sailTo(from + 8, 3 * MIN);
      must(!fast.over && fast.clock > 0 && fast.sim >= from + 8, `4 days a second: from day ${from.toFixed(2)} she didn't sail 8 days on and keep going: ${JSON.stringify(fast)}`);
      t = await leave();
      must(t.v, "4 days a second: nothing was saved on leaving");
      must(t.v.day >= t.v.left - 8, `4 days a second: the save's code stands at day ${t.v.day}, more than 8 days before she was left (${t.v.left})`);
      out.push(await comeBack(t, "4 days a second, not paused"));
      return out.join("; ");
    },
  },
  // #385 (Felix): sound waits for a click, "No thanks" is remembered, N and the speaker button
  // agree, cinematic with sound on is clean, and a remembered "on" returns at the first click,
  // never on load. Nobody can hear on a runner: this checks state and errors, not the sound.
  "sound-helm": {
    manual: true,
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.addInitScript(soundSpy);
      await calmReload(page);
      const out = [];
      const loaded = async () => {
        await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
        await page.waitForTimeout(3000);
      };
      const sailed = () => page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      const watchAsk = () => page.evaluate(() => {
        window.__askedSound = false;
        const a = document.getElementById("soundask");
        if (a) new MutationObserver(() => { if (!a.hidden) window.__askedSound = true; }).observe(a, { attributes: true });
      });
      /** Whether "Sound on?" shows within `ms` of now (it resolves as soon as it does). */
      const askedWithin = (ms) => page.waitForFunction(() => !document.getElementById("soundask").hidden || window.__askedSound, null, { timeout: ms }).then(() => true).catch(() => false);
      // 1. First visit: nothing on load; "Set sail" asks once; "No thanks" is remembered.
      await loaded();
      let s = await soundState(page);
      must(s.contexts === 0, `an AudioContext existed on load, before any click (${s.contexts})`);
      must(!s.pressed, `the speaker button says on before any click`);
      await watchAsk();
      await pressSetSail(page, { noWaitAfter: true, timeout: 30_000 }); // the busy page can hold a click past 15 s on a runner
      await sailed();
      s = await soundState(page);
      must(s.contexts === 0, `clicking "Set sail" started sound without being asked (${s.contexts} AudioContext)`);
      // The question waits: it comes a minute in, or after the first call, whichever is first (#406, Leo).
      const asked = await askedWithin(90_000);
      must(asked, `"Sound on?" was never asked in the first 90 s after Set sail`);
      // Pressed in the page: on a runner Playwright's own click could wait out the question's 20 s, and
      // the "asked again" assertions below were then skipped. Now it lands, or the check fails saying so.
      const clicked = await page.evaluate(() => { if (document.getElementById("soundask").hidden) return false; document.getElementById("soundno").click(); return true; });
      must(clicked, `"Sound on?" showed but had closed again before "No thanks" could be pressed`);
      await page.waitForFunction(() => document.getElementById("soundask").hidden, null, { timeout: 25_000 });
      s = await soundState(page);
      must(s.stored === "off", `"No thanks" wasn't remembered (stored ${JSON.stringify(s.stored)})`);
      out.push(`load: no AudioContext, button off; "Sound on?" asked within 90 s of Set sail, "No thanks" stored "off"`);
      // 2. Second visit after "No thanks": no question.
      await calmReload(page);
      await loaded();
      await watchAsk();
      await pressSetSail(page, { noWaitAfter: true, timeout: 30_000 }); // the busy page can hold a click past 15 s on a runner
      await sailed();
      // The question would come up to a minute in (or after the first call): watch as long as step 1 allows before saying it didn't.
      const again = await askedWithin(90_000);
      must(!again, `"Sound on?" was asked again after "No thanks"`);
      s = await soundState(page);
      must(s.contexts === 0, `sound started after "No thanks" without N or the button (${s.contexts} AudioContext)`);
      out.push(`reload after "No thanks": not asked again in 90 s, still silent`);
      // 3. N while sailing: on, then off; the speaker button follows.
      await page.keyboard.press("n");
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(s.pressed && s.contexts === 1, `N didn't turn sound on: button pressed ${s.pressed}, ${s.contexts} AudioContext`);
      const on1 = `${s.icon} ${s.state}`;
      await page.keyboard.press("n");
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(!s.pressed && s.stored === "off", `N didn't turn sound off: button pressed ${s.pressed}, stored ${s.stored}`);
      const off1 = s.icon;
      await page.click("#soundbtn", { noWaitAfter: true, timeout: 10_000 });
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(s.pressed && s.stored === "on" && s.contexts === 1, `the speaker button didn't turn sound on: pressed ${s.pressed}, stored ${s.stored}, ${s.contexts} AudioContext`);
      out.push(`N on (${on1}), N off (${off1}), button on again; one AudioContext`);
      // 4. Cinematic with sound on (paused, so the clock check in cinematic() holds).
      await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
      await page.waitForFunction(() => window.__helm.clock === 0 && !window.__helm.busy, null, { timeout: 2 * MIN }).catch(() => {});
      out.push(await cinematic(page, () => window.__helm.frames));
      // 5. Second visit after "on": silent on load, back at the first click, no question.
      await calmReload(page);
      await loaded();
      s = await soundState(page);
      must(s.contexts === 0 && !s.pressed, `a remembered "on" started sound on load (${s.contexts} AudioContext, button ${s.pressed})`);
      await watchAsk();
      await pressSetSail(page, { noWaitAfter: true, timeout: 30_000 }); // the busy page can hold a click past 15 s on a runner
      await page.waitForTimeout(1000);
      s = await soundState(page);
      must(s.contexts === 1 && s.pressed, `a remembered "on" didn't come back at the first click (${s.contexts} AudioContext, button ${s.pressed})`);
      await sailed();
      must(!(await askedWithin(90_000)), `"Sound on?" was asked although sound was on`);
      out.push(`reload after "on": silent on load, on at the first click (${s.state}), not asked in 90 s`);
      return out.join("; ");
    },
  },
  "sound-voyage": {
    manual: true,
    path: "voyage.html?voyage=2020-04-15&quality=low",
    run: async (page) => {
      await page.addInitScript(soundSpy);
      await calmReload(page);
      const out = [];
      const loaded = async () => {
        await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN });
        must(!(await page.evaluate(() => window.__replay.error)), "the replay didn't load");
        await page.waitForTimeout(3000);
      };
      await loaded();
      let s = await soundState(page);
      must(s.contexts === 0 && !s.pressed, `sound before any click: ${s.contexts} AudioContext, button ${s.pressed}`);
      // A click on the sea is not "sound on".
      await page.mouse.click(700, 450);
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(s.contexts === 0, `a click on the sea started sound (${s.contexts} AudioContext)`);
      out.push("load and a click on the sea: no AudioContext, button off");
      await page.keyboard.press("n");
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(s.pressed && s.contexts === 1, `N didn't turn sound on: button pressed ${s.pressed}, ${s.contexts} AudioContext`);
      const on1 = `"${s.text}" ${s.state}`;
      await page.keyboard.press("n");
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(!s.pressed && s.stored === "off", `N didn't turn sound off: button pressed ${s.pressed}, stored ${s.stored}`);
      const off1 = `"${s.text}"`;
      await page.click("#soundbtn", { noWaitAfter: true, timeout: 10_000 });
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(s.pressed && s.stored === "on", `the Sound button didn't turn sound on: pressed ${s.pressed}, stored ${s.stored}`);
      out.push(`N on (${on1}), N off (${off1}), button on again`);
      out.push(await cinematic(page, () => window.__replay.frames));
      await calmReload(page);
      await loaded();
      s = await soundState(page);
      must(s.contexts === 0 && !s.pressed, `a remembered "on" started sound on load (${s.contexts} AudioContext, button ${s.pressed})`);
      await page.mouse.click(700, 450);
      await page.waitForTimeout(1000);
      s = await soundState(page);
      must(s.contexts === 1 && s.pressed, `a remembered "on" didn't come back at the first click (${s.contexts} AudioContext, button ${s.pressed})`);
      out.push(`reload after "on": silent on load, on at the first click (${s.state})`);
      return out.join("; ");
    },
  },
  // Manual: #384 (Sam), the practice marks float: they ride the sea under them (height and tilt
  // change, a beat behind the water), sit at their draft rather than above or under it, and
  // don't blink in and out. Both browsers measure; Chromium also prints frames: the course
  // as the player sees it, then the first mark moved (by the test, in this tab only) to about
  // 35 m off the boat so its waterline can be judged up close.
  // Manual: #397 (Felix), story moments by state, not by ear: window.__sound.played logs one
  // {name, t} per moment. Nothing logs while sound is off; turning it on says hello once; a voyage
  // sailed to its end at 4 days a second logs each breakdown once, the horn at a finish and the
  // result card's settle once. Watch a voyage plays only the sea: no moments there.
  "sound-moments": {
    manual: true,
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.evaluate(() => Array.isArray(window.__sound?.played)))) throw new SkipCheck("this build has no sound log (Felix's played-log patch not deployed)");
      const played = () => page.evaluate(() => window.__sound.played.map((p) => ({ ...p })));
      const out = [];
      await page.click("#go", { timeout: 15_000 });
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      await page.waitForTimeout(2000);
      must((await played()).length === 0, `moments logged with sound off: ${JSON.stringify(await played())}`);
      // Sound on from the question (or N if it has gone).
      if (await page.locator("#soundyes").isVisible().catch(() => false)) await page.click("#soundyes", { noWaitAfter: true });
      else await page.keyboard.press("n");
      await page.waitForTimeout(1500);
      let p = await played();
      must(p.filter((x) => x.name === "hello").length === 1, `turning sound on should say hello once: ${JSON.stringify(p)}`);
      out.push("silent with sound off; hello once on turning it on");
      // Sail to the end at 4 days a second, taking the first choice at every decision.
      for (let i = 0; i < 40; i++) {
        if (await page.evaluate(() => window.__helm.status?.over)) break;
        if (await page.evaluate(() => !document.getElementById("decide").hidden && document.querySelectorAll("#decidebtns button").length)) {
          await page.locator("#decidebtns button").first().click({ noWaitAfter: true, timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }
        if (await page.evaluate(() => window.__helm.clock === 0 && !window.__helm.status?.over)) await page.keyboard.press("4");
        await page.waitForFunction(() => window.__helm.clock === 0 || window.__helm.status?.over || window.__helm.error, null, { timeout: 4 * MIN }).catch(() => {});
        must(!(await page.evaluate(() => window.__helm.error)), "sailing failed");
      }
      const st = await page.evaluate(() => ({ over: window.__helm.status?.over, day: window.__helm.status?.day, outcome: window.__helm.status?.outcome ?? window.__helm.lastStop }));
      await page.waitForTimeout(8000); // the result card and its settle
      p = await played();
      const names = p.map((x) => x.name);
      const count = (n) => names.filter((x) => x === n || x.startsWith(n + ":")).length;
      const KNOWN = /^(hello|crash|horn|settle|flog|alarm|bell:[123]|breakdown:[a-z_]+)$/;
      const odd = names.filter((n) => !KNOWN.test(n));
      must(!odd.length, `unknown moments: ${odd.join(", ")}`);
      // "Once per event": the same moment twice within a second is a double fire.
      // t is the sound clock: in Firefox on the runner it never starts (no audio device), so every t is
      // the same and nothing can be told apart; at 4 days a second two real knockdowns can land within a
      // second of each other, so only a repeat within a quarter second counts.
      const frozen = p.length > 1 && p.every((x) => x.t === p[0].t);
      const doubles = frozen ? [] : p.filter((x, i) => i && p[i - 1].name === x.name && Math.abs(x.t - p[i - 1].t) < 0.25);
      if (frozen) out.push("sound clock frozen (no audio device): double-fire test not possible");
      must(!doubles.length, `fired twice for one event: ${doubles.map((d) => d.name).join(", ")}`);
      must(count("hello") === 1, `hello ${count("hello")} times`);
      if (st.over) must(count("settle") === 1, `the end of the voyage should settle once, got ${count("settle")}`);
      if (/arrived|finish/.test(String(st.outcome))) must(count("horn") === 1, `a finish should sound the horn once, got ${count("horn")}`);
      out.push(`voyage ${st.over ? "ended" : "not ended"} at day ${st.day?.toFixed?.(1)} (${st.outcome}); moments: ${names.join(", ") || "none"}`);
      // Watch a voyage: the sound object, no moments.
      await page.goto(SITE + "voyage.html?voyage=2020-04-15&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN });
      await page.keyboard.press("n");
      await page.waitForTimeout(5000);
      const vp = await page.evaluate(() => (window.__sound?.played ?? null));
      must(vp !== null, "Watch a voyage has no window.__sound");
      must(vp.every((x) => x.name === "hello"), `Watch a voyage logged story moments: ${JSON.stringify(vp)}`);
      out.push(`Watch a voyage: ${vp.length ? vp.map((x) => x.name).join(", ") : "no moments"}`);
      return out.join("; ");
    },
  },
  // Manual: #400 (Marco), ships at sea live. ?ship=container puts one under way 900 m off the
  // starboard bow, crossing ahead; window.__traffic.ships() says where. Checks she's there, under
  // way (speed > 0, so the bow wave shows), runs without errors, and prints frames as she crosses.
  "look-ships": {
    manual: true,
    path: "helm.html?ship=container",
    run: async (page) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        if (BROWSER !== "chromium") return;
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.evaluate(() => typeof window.__traffic?.ships === "function"))) throw new SkipCheck("this build has no traffic hook (Marco's traffic patch not deployed)");
      await page.click("#go", { timeout: 15_000 });
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      await page.click("#soundno", { timeout: 3000 }).catch(() => {});
      // Paused: traffic moves in boat time, and any fast-forward carries her off (Marco). The frame
      // shows her where she was put, 900 m off the starboard bow.
      await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
      await page.waitForFunction(() => !document.querySelector("#orders.open"), null, { timeout: 30_000 }).catch(() => {});
      const ships = () => page.evaluate(() => window.__traffic.ships().map((s) => ({ kind: s.kind, d: Math.round(s.distance ?? Math.hypot(s.x, s.z)), b: Math.round(s.bearing ?? 0), sp: s.speed, anch: s.anchored })));
      const s0 = await ships();
      const ours = s0.filter((s) => /container/.test(s.kind));
      must(ours.length, `?ship=container didn't put a container ship near us: ${JSON.stringify(s0)}`);
      must(ours.some((s) => !s.anch && s.sp > 0), `the container ship isn't under way (speed ${ours.map((s) => s.sp).join(", ")}), so there's no bow wave`);
      await page.waitForTimeout(4000);
      await shot("ships-container");
      const c0 = ours[0];
      // Close: the same ship started 200 m off (&near=, Marco).
      if (BROWSER === "chromium") {
        await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
        await page.goto(SITE + "helm.html?ship=container&near=200", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
        await page.click("#go", { timeout: 15_000 });
        await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
        await page.click("#soundno", { timeout: 3000 }).catch(() => {});
        await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
        await page.waitForFunction(() => !document.querySelector("#orders.open"), null, { timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(4000);
        await shot("ships-container-200m");
      }
      return `container ship at ${c0.d} m on bearing ${c0.b}°, speed ${c0.sp}; ${s0.length} ships in all${shots.length ? `; frames ${shots.join(", ")}` : ""}`;
    },
  },
  // Manual: the opening of Elena's 60 s film for John (title, the helm's start, the first sailing),
  // frame by frame so it's smooth on a runner without a graphics card: the page's clock is held
  // and stepped 1/30 s per frame (Ada's proof clock, tools/proof/capture.mjs), captured over CDP
  // (page.screenshot hangs while the clock is held), and joined into an MP4 with ffmpeg. The MP4
  // prints to the log like the look frames. Ada renders the sea shots; the cut is joined after.
  "film-opening": {
    manual: true,
    path: "",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("filmed in Chromium only");
      const { execSync } = await import("node:child_process");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      try { execSync("ffmpeg -version", { stdio: "ignore" }); } catch { execSync("sudo apt-get install -y -qq ffmpeg", { stdio: "ignore", timeout: 5 * MIN }); }
      const FPS = 30;
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.addInitScript(FILM_CLOCK);
      const cdp = await page.context().newCDPSession(page);
      mkdirSync("film", { recursive: true });
      let n = 0;
      const frame = async () => {
        await page.evaluate((ms) => window.__proofClock.step(ms), 1000 / FPS);
        const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
        writeFileSync(`film/${String(n++).padStart(5, "0")}.jpg`, Buffer.from(r.data, "base64"));
      };
      const film = async (secs) => {
        await page.evaluate(() => window.__proofClock.hold());
        await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 10 }); // the first one can be blank
        for (let i = 0; i < secs * FPS; i++) await frame();
        await page.evaluate(() => window.__proofClock.release());
      };
      const out = [];
      // High quality throughout, to match Ada's sea shots (Low keeps faint bands on the sea).
      // 1. The title (4 s).
      await page.goto(SITE + "?quality=high", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 5, null, { timeout: 2 * MIN });
      await page.waitForTimeout(3000);
      await film(4);
      out.push(`title ${n} frames`);
      // 2. The helm's start card (3 s), then Set sail on the real clock.
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await page.goto(SITE + "helm.html?quality=high", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 3 * MIN });
      await page.waitForTimeout(3000);
      const n1 = n;
      await film(3);
      out.push(`start card ${n - n1}`);
      await page.click("#go", { timeout: 30_000 });
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), "Set sail failed");
      await page.click("#soundno", { timeout: 5000 }).catch(() => {});
      await page.waitForFunction(() => !document.querySelector("#orders.open"), null, { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2000);
      // 3. Sailing at the helm (13 s), the clock running by itself as a new player sees it.
      const n2 = n;
      await film(13);
      out.push(`sailing ${n - n2}`);
      execSync(`ffmpeg -y -loglevel error -framerate ${FPS} -i film/%05d.jpg -c:v libx264 -pix_fmt yuv420p -crf 24 -movflags +faststart film-opening.mp4`);
      const b64 = readFileSync("film-opening.mp4").toString("base64");
      console.log("LOOK-BEGIN film-opening.mp4");
      for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
      console.log("LOOK-END film-opening.mp4");
      return `${out.join(", ")} frames at ${FPS} fps: film-opening.mp4, ${(b64.length * 0.75 / 1e6).toFixed(1)} MB`;
    },
  },
  // Manual: the new sea up close (Maya, 12 Nov): at forces 5, 6 and 8 on High, in daylight, is the
  // wake a bright veined web ("cracked glass"), and are there flat pale foam slabs with hard edges
  // in the near water? Frames from the replay's proof hooks (force.wind/hs/sea/cloud, cam, setHour).
  "look-sea": {
    manual: true,
    path: "voyage.html?voyage=2020-04-15&quality=high",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 3 * MIN });
      if (!(await page.evaluate(() => "cam" in window.__replay && Array.isArray(window.__replay.force?.sea)))) throw new SkipCheck("this build has no proof hooks (force.sea, cam)");
      // Midday on day 2: the sun high, so foam and wake read in plain light.
      await page.evaluate(() => {
        const r = window.__replay;
        r.pause();
        let best = 30, el = -90;
        for (let h = 24; h < 48; h += 0.25) { const e = r.sunAt?.(h) ?? -90; if (e > el) [best, el] = [h, e]; }
        r.setHour(best);
      });
      const SEAS = { f5: [9.8, 2.5, 6.3, 0.45], f6: [12.9, 4.0, 8.0, 0.6], f8: [19.0, 6.0, 9.8, 0.9] };
      const VIEWS = { chase: { az: 180, dist: 9, h: 2.2, fov: 45, look: 0.3 }, over: { az: 180, dist: 2, h: 18, fov: 45 }, low: { az: 150, dist: 7, h: 0.4, fov: 35, look: 0.3 } };
      for (const [sea, [wind, hs, tp, cloud]] of Object.entries(SEAS)) {
        await page.evaluate(([wind, hs, tp, cloud]) => {
          const f = window.__replay.force;
          f.wind = wind; f.cloud = cloud; f.fog = 0; f.sea = [hs, tp, -1];
          window.__replay.setHour(window.__replay.hour); // re-seek so the forced sea is built now
        }, [wind, hs, tp, cloud]);
        await page.waitForTimeout(6000);
        for (const [view, cam] of Object.entries(VIEWS)) {
          await page.evaluate((cam) => { window.__replay.cam = cam; }, cam);
          await page.waitForTimeout(3000);
          await shot(`sea-${sea}-${view}`);
        }
      }
      return `${shots.length} frames: ${shots.join(", ")}`;
    },
  },
  "look-calm": {
    manual: true,
    path: "voyage.html?voyage=2020-04-15&quality=high",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 3 * MIN });
      if (!(await page.evaluate(() => "cam" in window.__replay && Array.isArray(window.__replay.force?.sea)))) throw new SkipCheck("this build has no proof hooks (force.sea, cam)");
      // Midday on day 2: the sun high, so foam and wake read in plain light.
      await page.evaluate(() => {
        const r = window.__replay;
        r.pause();
        let best = 30, el = -90;
        for (let h = 24; h < 48; h += 0.25) { const e = r.sunAt?.(h) ?? -90; if (e > el) [best, el] = [h, e]; }
        r.setHour(best);
      });
      // #480: on a calm sea the hull's reflection sits under the hull, joined at the waterline.
      const SEAS = { calm: [1.5, 0.15, 5.0, 0.15], light: [4.0, 0.4, 5.0, 0.2] };
      const VIEWS = { side: { az: 90, dist: 7, h: 0.8, fov: 35, look: 0.2 }, quarter: { az: 140, dist: 8, h: 1.4, fov: 35, look: 0.2 }, close: { az: 100, dist: 4.5, h: 0.5, fov: 35, look: 0.1 } };
      for (const [sea, [wind, hs, tp, cloud]] of Object.entries(SEAS)) {
        await page.evaluate(([wind, hs, tp, cloud]) => {
          const f = window.__replay.force;
          f.wind = wind; f.cloud = cloud; f.fog = 0; f.sea = [hs, tp, -1];
          window.__replay.setHour(window.__replay.hour); // re-seek so the forced sea is built now
        }, [wind, hs, tp, cloud]);
        await page.waitForTimeout(6000);
        for (const [view, cam] of Object.entries(VIEWS)) {
          await page.evaluate((cam) => { window.__replay.cam = cam; }, cam);
          await page.waitForTimeout(3000);
          await shot(`calm-${sea}-${view}`);
        }
      }
      return `${shots.length} frames: ${shots.join(", ")}`;
    },
  },
  // #442 (M1 piece 6): the title hero, your own boat at golden hour behind the menu (desktop) or
  // above it (phone). Elena: look at the hull's top edge at a pixel ratio of 2 or more.
  "look-title": {
    manual: true,
    path: "",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      const browser = page.context().browser();
      const shots = [];
      const out = [];
      const cutAny = [];
      const SIZES = [
        { name: "1280-dpr2", viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 },
        { name: "phone-390-dpr3", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
        // Short phones (#457, #459): the boat above the menu; at 320x568 no intro line, so the choices and More fit.
        { name: "phone-375x667-dpr2", viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
        { name: "phone-360x640-dpr3", viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
        { name: "phone-320x568-dpr2", viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
      ];
      for (const s of SIZES) {
        const { name, ...opts } = s;
        const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" });
        const p = await ctx.newPage();
        const errs = [];
        p.on("pageerror", (e) => errs.push(e.message));
        await p.goto(SITE + "?quality=high", { waitUntil: "load", timeout: 2 * MIN });
        await p.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 30, null, { timeout: 3 * MIN }).catch(() => {});
        await p.waitForTimeout(8000);
        const info = await p.evaluate(() => ({
          title: !document.getElementById("title")?.hidden,
          heroClass: document.body.classList.contains("title"),
          cut: ["#t-setsail", "#t-build", "#t-practice", "#t-more > summary"].filter((q) => { const r = document.querySelector(q)?.getBoundingClientRect(); return !r || r.height === 0 || r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth; }),
          tag: (() => { const e = document.querySelector("#title .tag"); return !!e && e.offsetParent !== null; })(),
          menu: (() => { const r = document.querySelector("#title nav")?.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] : null; })(),
        }));
        const path = `look-title-${name}.jpg`;
        if (await jpeg(p, path)) {
          const b64 = readFileSync(path).toString("base64");
          console.log(`LOOK-BEGIN ${path}`);
          for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
          console.log(`LOOK-END ${path}`);
          shots.push(name);
        }
        if (info.cut.length) cutAny.push(`${name}: ${info.cut.join(", ")}`);
        out.push(`${name}: menu ${info.title ? "shown" : "NOT shown"} at ${JSON.stringify(info.menu)}, intro line ${info.tag ? "shown" : "hidden"}${info.cut.length ? `, OFF SCREEN: ${info.cut.join(", ")}` : ", all choices and More on screen"}${errs.length ? `, page errors: ${errs.slice(0, 2).join(" | ")}` : ""}`);
        await ctx.close().catch(() => {});
      }
      must(!cutAny.length, `title choices off the screen: ${cutAny.join("; ")} (${out.join("; ")})`);
      return `${out.join("; ")}; frames ${shots.join(", ")}`;
    },
  },
  // #458 (locked item S1): the helm strip shows the boat's time zone beside the local time, and it
  // agrees with the map panel's line, at the crossing's start (expect "UTC−5" and "(UTC−5, sea zone)").
  "helm-zone": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await page.evaluate(() => document.getElementById("go").click());
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), "the crossing didn't start");
      await page.waitForFunction(() => document.getElementById("c-date")?.textContent.trim() && document.getElementById("local")?.textContent.trim(), null, { timeout: MIN }).catch(() => {});
      const t = await page.evaluate(() => ({ strip: document.getElementById("c-date")?.textContent.trim() ?? "", panel: document.getElementById("local")?.textContent.trim() ?? "", wind: document.getElementById("c-windv")?.textContent.trim() ?? "", windl: document.getElementById("c-wavel")?.textContent.trim() ?? "" }));
      const zone = t.strip.match(/(UTC(?:[−+-]\d+(?::\d+)?)?|[A-Z]{3,4})$/)?.[1];
      if (!zone) throw new SkipCheck(`the strip shows no time zone yet (#458 not deployed): "${t.strip}"; panel "${t.panel}"`);
      must(t.panel.includes(zone), `the strip says ${zone} ("${t.strip}") but the map panel says "${t.panel}"`);
      const exp = zone === "UTC−5" && /\(UTC−5, sea zone\)/.test(t.panel);
      return `strip "${t.strip}", panel "${t.panel}"${exp ? "" : " (NOT the expected UTC−5 / (UTC−5, sea zone))"}; wind cell "${t.wind}" over "${t.windl}"`;
    },
  },
  // #443 (M1 piece 5): the Set sail card is the one place to pick. Pick a day…, a challenge,
  // More options (steering, breakdowns, battery as pills), then set sail; practice from the card too.
  "setsail-card": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.locator("#ss-when-opts").count())) throw new SkipCheck("this build has no Set sail card");
      await page.waitForFunction(() => document.querySelectorAll("#ss-when-opts .ss-pill").length >= 3, null, { timeout: MIN }).catch(() => {
        throw new CheckFail("the card's launch day pills didn't show");
      });
      const out = [];
      const pillTexts = (box) => page.evaluate((b) => [...document.querySelectorAll(`${b} .ss-pill`)].map((e) => ({ t: e.textContent.trim(), on: e.getAttribute("aria-pressed") === "true", vis: e.offsetParent !== null })), box);
      // The old start lists must not show anywhere.
      const old = await page.evaluate(() => ["#launch", "#challenge", "#modes", "#breakdowns", "#safe"].filter((s) => { const e = document.querySelector(s); return e && e.offsetParent !== null; }));
      must(!old.length, `the old pickers still show: ${old.join(", ")}`);
      // #461: "Who steers" shows only with ?who= in the address; the plain card has no such row.
      const who = await page.evaluate(() => { const e = document.getElementById("ss-who"); return !!e && e.offsetParent !== null; });
      // Since #489 the row is on for everyone; before it, it needed ?who=. Either is reported, neither fails here
      // (setsail-who checks the row itself).
      out.push(who ? "Who steers row shown" : "no Who steers row");
      const rows = await page.evaluate(() => [...document.querySelectorAll("#ss-card .ss-row")].filter((e) => e.offsetParent !== null).map((e) => e.querySelector(".ss-l")?.textContent.trim()));
      out.push(`rows ${rows.join(" / ")}`);
      // Pick a day…
      let days = await pillTexts("#ss-when-opts");
      const pick = days.findIndex((d) => /Pick a day/.test(d.t));
      must(pick >= 0, `no "Pick a day…" pill: ${days.map((d) => d.t).join(" / ")}`);
      await page.locator("#ss-when-opts .ss-pill").nth(pick).click({ timeout: 15_000 });
      days = await pillTexts("#ss-when-opts");
      must(days.length >= 5, `"Pick a day…" didn't open the other days: ${days.map((d) => d.t).join(" / ")}`);
      const dayIdx = days.findIndex((d) => /May/.test(d.t)) >= 0 ? days.findIndex((d) => /May/.test(d.t)) : days.length - 1;
      await page.locator("#ss-when-opts .ss-pill").nth(dayIdx).click({ timeout: 15_000 });
      const launch = await page.evaluate(() => document.getElementById("launch").value);
      days = await pillTexts("#ss-when-opts");
      must(days[dayIdx]?.on, `the picked day "${days[dayIdx]?.t}" isn't shown as picked`);
      out.push(`days ${days.map((d) => d.t).join(" / ")}; picked "${days[dayIdx].t}" (launch=${launch})`);
      // A challenge.
      const chShown = await page.evaluate(() => !document.getElementById("ss-ch").hidden);
      let chName = "";
      if (chShown) {
        const ch = await pillTexts("#ss-ch-opts");
        const i = ch.findIndex((c) => c.t !== "None" && !/More/.test(c.t));
        must(i > 0, `no challenge pills: ${ch.map((c) => c.t).join(" / ")}`);
        await page.locator("#ss-ch-opts .ss-pill").nth(i).click({ timeout: 15_000 });
        const after = await page.evaluate(() => ({ v: document.getElementById("challenge").value, why: document.getElementById("ss-why").textContent.trim(), whyShown: !document.getElementById("ss-why").hidden }));
        must(after.v, `picking "${ch[i].t}" didn't set a challenge`);
        must(after.whyShown && after.why, `picking "${ch[i].t}" showed no line saying why`);
        chName = after.v;
        out.push(`challenge "${ch[i].t}" (${after.v}): "${after.why.slice(0, 90)}"`);
        // More… shows the rest.
        const more = (await pillTexts("#ss-ch-opts")).findIndex((c) => /More/.test(c.t));
        if (more >= 0) {
          await page.locator("#ss-ch-opts .ss-pill").nth(more).click({ timeout: 15_000 });
          out.push(`More… opened ${(await pillTexts("#ss-ch-opts")).length} challenge pills`);
        }
      } else out.push("no challenge row (challenges not loaded)");
      // More options: steering, breakdowns, battery.
      await page.click("#more > summary", { timeout: 15_000 });
      const steer = await pillTexts("#ss-mode-opts");
      const toggles = await pillTexts("#ss-toggles");
      must(steer.length === 2 && steer.every((s) => s.vis), `How you steer should be two pills: ${JSON.stringify(steer)}`);
      must(toggles.length === 2 && toggles.every((s) => s.vis), `Breakdowns and Save the battery should be two pills: ${JSON.stringify(toggles)}`);
      await page.locator("#ss-mode-opts .ss-pill").nth(1).click({ timeout: 15_000 });
      const sat = await page.evaluate(() => ({ mode: document.querySelector('input[name="mode"]:checked')?.value, safe: document.getElementById("safe").checked, line: document.getElementById("ss-mode-line").textContent.trim() }));
      must(sat.mode === "base", `the second steering pill didn't pick satellite steering (${sat.mode})`);
      await page.locator("#ss-mode-opts .ss-pill").nth(0).click({ timeout: 15_000 });
      const bd0 = await page.evaluate(() => document.getElementById("breakdowns").checked);
      await page.locator("#ss-toggles .ss-pill").nth(0).click({ timeout: 15_000 });
      const bd1 = await page.evaluate(() => document.getElementById("breakdowns").checked);
      must(bd0 !== bd1, "the Breakdowns pill didn't switch breakdowns");
      await page.locator("#ss-toggles .ss-pill").nth(0).click({ timeout: 15_000 });
      out.push(`steer ${steer.map((s) => s.t).join(" / ")} (satellite turned Save the battery ${sat.safe ? "on" : "off"}); toggles ${(await pillTexts("#ss-toggles")).map((s) => s.t).join(" / ")}`);
      // Is Set sail still in view with More options open?
      const goSeen = await page.evaluate(() => { const r = document.getElementById("go").getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; });
      out.push(`Set sail ${goSeen ? "in view" : "OFF SCREEN"} with More options open`);
      await page.screenshot({ path: `play-${BROWSER}-setsail-card.png` }).catch(() => {});
      // Set sail on the crossing.
      await page.click("#go", { timeout: 30_000, noWaitAfter: true });
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN }).catch(() => {});
      const st = await page.evaluate(() => ({ err: window.__helm.error, ready: window.__helm.ready, ch: window.__helm.challenge, hidden: document.getElementById("start").hidden || getComputedStyle(document.getElementById("start")).display === "none" }));
      must(!st.err, `setting sail failed: ${st.err}`);
      must(st.ready, "the crossing didn't start within 8 min");
      must(st.hidden, "the Set sail card stayed up after Set sail");
      if (chName) must(st.ch === chName, `sailing challenge "${st.ch}", not the picked "${chName}"`);
      out.push(`crossing started${chName ? ` on challenge ${st.ch}` : ""}`);
      // Practice from the card.
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.goto(SITE + "helm.html?practice&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (await page.locator("#ss-course-opts").count()) {
        await practiceTriangle(page);
        must(await page.evaluate(() => !!window.__wheel?.on), "Practice from the card didn't put me at the wheel");
        out.push("practice: triangle from the card, at the wheel");
      } else out.push("practice: no courses on the card");
      return out.join("; ");
    },
  },
  // M1 piece 7 (Jonas, qa/m1-30-second-check.md): title to sailing, timed, a fresh browser
  // (empty cache) per run, 1280x720, three runs each of the crossing, practice and a challenge. Bar: 30 s.
  "time30": {
    manual: true,
    path: "",
    run: async (page) => {
      const browser = page.context().browser();
      const RUNS = Number(process.env.TIME30_RUNS || 3);
      const rows = [];
      const rateNow = (p) => p.evaluate(() => document.querySelector("#timebar .rate[aria-pressed=true]")?.textContent.trim() ?? "?");
      const firstRate = (p) => p.evaluate(() => document.querySelector("#timebar .rate")?.textContent.trim() ?? "?");
      // Clicks go in through the page (el.click()): on the runner's software graphics Playwright's
      // own click waits for a steady frame and times out, while a player's click simply lands late.
      // (Wait, then click in a second step: a click that leaves the page would otherwise be retried on the next page.)
      const tap = async (p, sel) => {
        await p.waitForFunction((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel, { timeout: 3 * MIN, polling: 250 });
        await p.evaluate((s) => document.querySelector(s).click(), sel).catch(() => {});
      };
      const KINDS = {
        crossing: async (p, mark) => {
          await tap(p, "#t-setsail");
          await p.waitForURL(/helm\.html/, { timeout: 2 * MIN });
          await p.waitForSelector("#go", { state: "visible", timeout: 2 * MIN });
          mark("card");
          await tap(p, "#go");
          await p.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
          mark(`sailing (rate ${await rateNow(p)}, first on bar ${await firstRate(p)})`);
        },
        practice: async (p, mark) => {
          await tap(p, "#t-practice");
          await p.waitForURL(/helm\.html/, { timeout: 2 * MIN });
          await p.waitForFunction(() => !document.getElementById("start").hidden && !document.getElementById("ss-course").hidden, null, { timeout: 2 * MIN });
          mark("card");
          await tap(p, "#go");
          await p.waitForFunction(() => window.__wheel?.on, null, { timeout: 4 * MIN });
          mark(`at the wheel (rate ${await rateNow(p)})`);
        },
        challenge: async (p, mark) => {
          await tap(p, "#t-setsail");
          await p.waitForURL(/helm\.html/, { timeout: 2 * MIN });
          await p.waitForSelector("#ss-ch-opts .ss-pill:nth-child(2)", { state: "visible", timeout: 2 * MIN });
          mark("card");
          const pill = p.locator("#ss-ch-opts .ss-pill", { hasText: /Gentle June/ });
          if (await pill.count()) await pill.first().evaluate((e) => e.click()); else { await tap(p, "#ss-ch-opts .ss-pill:nth-child(2)"); mark("(no Gentle June pill: took the first challenge)"); }
          await tap(p, "#go");
          await p.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
          mark(`sailing (challenge ${await p.evaluate(() => window.__helm.challenge)}, rate ${await rateNow(p)})`);
        },
      };
      for (let i = 1; i <= RUNS; i++) {
        for (const [kind, steps] of Object.entries(KINDS)) {
          const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
          const p = await ctx.newPage();
          let bytes = 0;
          p.on("response", async (r) => { try { const h = await r.headerValue("content-length"); if (h) bytes += Number(h); } catch {} });
          const t0 = Date.now();
          const marks = [];
          const mark = (m) => marks.push(`${m} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          let total = null;
          try {
            await p.goto(SITE, { waitUntil: "domcontentloaded", timeout: 2 * MIN });
            await p.waitForSelector("#t-setsail", { state: "visible", timeout: 2 * MIN });
            mark("title");
            await steps(p, mark);
            total = (Date.now() - t0) / 1000;
            if (await p.evaluate(() => window.__helm?.error).catch(() => "")) mark("ERROR " + (await p.evaluate(() => window.__helm.error)));
          } catch (e) {
            mark(`FAILED: ${String(e.message).split("\n")[0]}`);
          }
          const line = `TIME30 ${BROWSER} ${kind} run ${i}: ${total == null ? "no finish" : total.toFixed(1) + " s"} | ${marks.join(" | ")} | ${(bytes / 1e6).toFixed(1)} MB`;
          console.log(line);
          rows.push({ kind, total });
          await ctx.close().catch(() => {});
        }
      }
      const sum = Object.keys(KINDS).map((k) => {
        const t = rows.filter((r) => r.kind === k && r.total != null).map((r) => r.total).sort((a, b) => a - b);
        return `${k} ${t.map((x) => x.toFixed(1)).join("/")} s${t.length ? ` (median ${t[Math.floor(t.length / 2)].toFixed(1)})` : ""}`;
      });
      return sum.join("; ");
    },
  },
  // #451: the title is silent until the first click; then the sea starts, the pill says so, N toggles it.
  "title-silent": {
    path: "",
    run: async (page) => {
      await page.addInitScript(soundSpy);
      await calmReload(page);
      await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 5, null, { timeout: 3 * MIN });
      if (!(await page.locator("#t-sound").count())) throw new SkipCheck("this build has no title sound (#451 not deployed)");
      await page.waitForTimeout(6000);
      const st = () => page.evaluate(() => ({ contexts: (window.__ac ?? []).length, running: (window.__ac ?? []).filter((c) => c.state === "running").length, on: !!window.__sound?.on, pill: document.getElementById("t-sound")?.textContent.trim(), pressed: document.getElementById("t-sound")?.getAttribute("aria-pressed") }));
      let s = await st();
      must(s.running === 0, `sound was running on the title before any click (${s.running} of ${s.contexts} AudioContexts running)`);
      must(!s.on && s.pill === "Sound: off", `the title says sound is on before any click (pill "${s.pill}", on ${s.on})`);
      const out = [`before a click: ${s.contexts} AudioContext, none running, pill "${s.pill}"`];
      // Moving the pointer is not a click.
      await page.mouse.move(700, 300);
      await page.mouse.move(300, 450);
      await page.waitForTimeout(1500);
      s = await st();
      must(s.running === 0 && !s.on, `moving the pointer started the title's sound`);
      // The first click (on the picture, not a choice).
      await page.mouse.click(1000, 300);
      await page.waitForTimeout(2500);
      s = await st();
      must(s.on && s.pill === "Sound: on", `the first click didn't turn the title's sound on (pill "${s.pill}", on ${s.on})`);
      out.push(`first click: pill "${s.pill}", ${s.running} context running`);
      await page.keyboard.press("n");
      await page.waitForTimeout(800);
      s = await st();
      must(!s.on && s.pill === "Sound: off", `N didn't turn the title's sound off (pill "${s.pill}")`);
      await page.keyboard.press("n");
      await page.waitForTimeout(800);
      s = await st();
      must(s.on && s.pill === "Sound: on", `N didn't turn the title's sound back on (pill "${s.pill}")`);
      await page.click("#t-sound", { timeout: 10_000 });
      await page.waitForTimeout(800);
      s = await st();
      must(!s.on && s.pill === "Sound: off", `the pill didn't turn the sound off (pill "${s.pill}")`);
      out.push("N off and on; the pill turns it off");
      return out.join("; ");
    },
  },
  // #452: helm.html?watch= plays a recorded voyage on the helm screen, in Real time, Real time first (T1, T2).
  "helm-watch": {
    path: "helm.html?watch=2020-04-15&quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if ((await page.evaluate(() => window.__helm.view)) !== "watch") throw new SkipCheck("this build has no helm.html?watch= (#452 not deployed)");
      await page.waitForFunction(() => window.__helm.watch || window.__helm.error, null, { timeout: 5 * MIN }).catch(() => {});
      const a = await page.evaluate(() => ({ err: window.__helm.error, watch: !!window.__helm.watch, card: (() => { const e = document.getElementById("start"); return !!e && !e.hidden && e.offsetParent !== null; })(), pressed: document.querySelector("#timebar .rate[aria-pressed=true]")?.dataset.rate ?? null, first: document.querySelector("#timebar .rate")?.textContent.trim(), rates: [...document.querySelectorAll("#timebar .rate")].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()), clock: window.__helm.clock, hour: window.__helm.hour }));
      must(!a.err, `the watched voyage failed: ${a.err}`);
      must(a.watch, "the recorded voyage didn't load within 5 min");
      must(!a.card, "the Set sail card is up on a watch link");
      must(a.first === "Real time", `Real time isn't first on the bar: ${a.rates.join(" / ")}`);
      must(a.pressed === "rt", `the watched voyage opened at "${a.pressed}", not Real time (clock ${a.clock})`);
      await page.waitForTimeout(8000);
      const b = await page.evaluate(() => ({ hour: window.__helm.hour, pressed: document.querySelector("#timebar .rate[aria-pressed=true]")?.dataset.rate ?? null }));
      must(b.pressed === "rt", `it left Real time by itself (now "${b.pressed}")`);
      must(b.hour > a.hour && b.hour - a.hour < 0.05, `in Real time the voyage hour went ${a.hour.toFixed(4)} to ${b.hour.toFixed(4)} in 8 s`);
      await page.screenshot({ path: `play-${BROWSER}-helm-watch.png` }).catch(() => {});
      return `opens in Real time, bar ${a.rates.join(" / ")}; ${((b.hour - a.hour) * 3600).toFixed(0)} s of voyage in 8 s`;
    },
  },
  // Sandy's shadow keeps its one big call, and gets no Gulf Stream call or note (Maya, with #391).
  "sandy-one-call": {
    path: "helm.html?quality=low&challenge=sandys-shadow",
    run: async (page) => {
      await page.addInitScript(() => {
        window.__gulf = [];
        const see = () => { const t = document.body?.innerText ?? ""; for (const m of t.match(/[^\n]*(riding the Gulf Stream|in the Gulf Stream, and|Gulf Stream:)[^\n]*/g) ?? []) if (!window.__gulf.includes(m)) window.__gulf.push(m); };
        addEventListener("DOMContentLoaded", () => new MutationObserver(see).observe(document.body, { childList: true, subtree: true, characterData: true }));
      });
      await calmReload(page);
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await page.waitForFunction(() => document.getElementById("challenge")?.value === "sandys-shadow", null, { timeout: MIN }).catch(() => {
        throw new CheckFail("the link didn't pick Sandy's shadow on the card");
      });
      // The live challenge list: nine challenges, and Sandy's shadow carries its goal (#483).
      const cat = await page.evaluate(async () => { try { const r = await fetch("./challenges/challenges.json", { cache: "no-store" }); const j = await r.json(); const list = Array.isArray(j) ? j : (j.challenges ?? Object.values(j)); const sandy = list.find((c) => c.id === "sandys-shadow"); return { status: r.status, n: list.length, ids: list.map((c) => c.id), goal: sandy?.goal ?? null }; } catch (e) { return { error: String(e) }; } });
      console.log(`SANDY ${BROWSER} catalogue: ${JSON.stringify(cat)}`);
      must(!cat.error, `the live challenge list couldn't be read: ${cat.error}`);
      must(cat.goal, `the live challenge list has no goal on sandys-shadow (${cat.n} challenges)`);
      must(cat.n === 9, `the live challenge list has ${cat.n} challenges, not 9: ${cat.ids.join(", ")}`);
      await page.evaluate(() => document.getElementById("go").click());
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), `Sandy's shadow didn't start: ${await page.evaluate(() => window.__helm.error)}`);
      must((await page.evaluate(() => window.__helm.challenge)) === "sandys-shadow", "the game isn't sailing Sandy's shadow");
      const asked = [];
      // Fact 1 (Maya): is the goal showing? "Day 4 of 9" in the strip's time cell and the storm chip mean the challenge's goal is set.
      const goalNow = () => page.evaluate(() => ({ day: document.getElementById("day")?.textContent.trim() ?? "", chip: (() => { const c = document.getElementById("goalchip"); return c && !c.hidden ? c.textContent.trim().replace(/\s+/g, " ") : ""; })() }));
      const goals = [await goalNow()];
      let streamShot = false;
      const frame = async (name) => {
        const path = `look-${name}.jpg`;
        if (BROWSER !== "chromium" || !(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
      };
      for (let i = 0; i < 80; i++) {
        if (await page.evaluate(() => window.__helm.status?.over)) break;
        // A call is asked once the picture reaches its moment: give it time to show before carrying on
        // (pressing play first would skip it).
        if (await page.evaluate(() => window.__helm.clock === 0)) await page.waitForFunction(() => !document.getElementById("decide").hidden && document.querySelectorAll("#decidebtns button").length, null, { timeout: 12_000 }).catch(() => {});
        if (await page.evaluate(() => !document.getElementById("decide").hidden && document.querySelectorAll("#decidebtns button").length)) {
          asked.push(await page.evaluate(() => (document.getElementById("decide").innerText || "").split("\n")[0].slice(0, 110)));
          goals.push(await goalNow());
          if (!streamShot && /Gulf Stream/.test(asked.at(-1)) && !/Sandy/.test(asked.at(-1))) { streamShot = true; await frame("sandy-stream-call"); }
          await page.locator("#decidebtns button").first().click({ noWaitAfter: true, timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }
        if (await page.evaluate(() => window.__helm.clock === 0 && !window.__helm.status?.over)) await page.evaluate(() => document.querySelector('#timebar .rate[data-rate="96"]')?.click());
        await page.waitForFunction(() => window.__helm.clock === 0 || window.__helm.status?.over || window.__helm.error, null, { timeout: 4 * MIN }).catch(() => {});
        must(!(await page.evaluate(() => window.__helm.error)), "sailing failed");
      }
      const end = await page.evaluate(() => `${window.__helm.status?.over ? `voyage over (${window.__helm.status?.outcome ?? "?"})` : "still sailing"} at day ${window.__helm.status?.day?.toFixed(1)}, last stop ${JSON.stringify(window.__helm.lastStop)}`);
      const r = await page.evaluate(() => ({ d: window.__helm.decisions.map((x) => ({ kind: x.kind, day: +x.day.toFixed(1) })), gulf: window.__gulf, over: !!window.__helm.status?.over, day: window.__helm.status?.day }));
      goals.push(await goalNow());
      const goalSeen = goals.find((g) => / of \d/.test(g.day) || g.chip);
      const facts = `goal ${goalSeen ? `shown ("${goalSeen.day}"${goalSeen.chip ? `, chip "${goalSeen.chip}"` : ""})` : `NOT shown (time cell "${goals[0].day}")`}; big call ${r.d.some((x) => x.kind === "mission") ? "asked" : "NOT asked"}; Gulf Stream ${r.d.some((x) => /stream|gulf/i.test(x.kind)) || r.gulf.length ? "SHOWN" : "not shown"}`;
      console.log(`SANDY ${BROWSER}: ${facts}; decisions ${JSON.stringify(r.d)}; asked ${JSON.stringify(asked)}; notes ${JSON.stringify(r.gulf)}; ${end}`);
      const mission = r.d.filter((x) => x.kind === "mission");
      const stream = r.d.filter((x) => /stream|gulf/i.test(x.kind));
      must(mission.length === 1, `Sandy's big call was asked ${mission.length} times (decisions: ${JSON.stringify(r.d)}; asked: ${JSON.stringify(asked)}; ${end})`);
      must(!stream.length, `Sandy's shadow asked a Gulf Stream call: ${JSON.stringify(stream)}`);
      must(!r.gulf.length, `Sandy's shadow showed a Gulf Stream note: ${JSON.stringify(r.gulf.slice(0, 2))}`);
      return `live list: 9 challenges, Sandy's goal ${JSON.stringify(cat.goal).slice(0, 120)}; ${facts}; one big call on day ${mission[0].day}; no Gulf Stream call or note; decisions ${r.d.map((x) => `${x.kind}@${x.day}`).join(", ")}; ${r.over ? "voyage over" : "still sailing"} at day ${r.day?.toFixed(1)}`;
    },
  },
  // #462 (M3): "Continue your voyage". A crossing is saved in the browser and offered on the title and
  // the Set sail card; practice and a watched voyage never create the offer; a fresh browser has none.
  "continue-voyage": {
    path: "?quality=low",
    run: async (page) => {
      const KEY = "boatsim.voyage.v1";
      const saved = () => page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) ?? "null"); } catch { return "unreadable"; } }, KEY);
      const title = async () => {
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.goto(SITE + "?quality=low", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 5, null, { timeout: 3 * MIN });
        await page.waitForTimeout(1500);
        return page.evaluate(() => { const a = document.getElementById("t-continue"); return { has: !!a, shown: !!a && !a.hidden && a.offsetParent !== null, sub: document.getElementById("t-continue-sub")?.textContent.trim() ?? "", href: a?.getAttribute("href") ?? "", menu: [...document.querySelectorAll("#title nav > a, #title nav > details > summary")].filter((e) => e.offsetParent !== null).map((e) => e.firstChild?.textContent.trim()) }; });
      };
      const out = [];
      // 1. A fresh browser: the title as before.
      await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 5, null, { timeout: 3 * MIN });
      let t = await title();
      if (!t.has) throw new SkipCheck("this build has no Continue your voyage (#462 not deployed)");
      must(!t.shown, `a fresh browser's title offers "Continue your voyage" (${t.sub})`);
      must((await saved()) === null, "a fresh browser already has a saved voyage");
      must(t.menu.join("/") === "Set sail/Boatyard/Practice/More", `the fresh title's menu changed: ${t.menu.join(" / ")}`);
      out.push(`fresh title: ${t.menu.join(" / ")}, no offer`);
      // 2. Practice never creates the offer.
      await page.goto(SITE + "helm.html?practice&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await practiceTriangle(page);
      must(await page.evaluate(() => !!window.__wheel?.on), "practice didn't start");
      await page.waitForTimeout(20_000);
      must((await saved()) === null, `practice saved a voyage: ${JSON.stringify(await saved()).slice(0, 120)}`);
      // 3. A watched voyage never creates it either.
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.goto(SITE + "helm.html?watch=2020-04-15&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && (window.__helm.watch || window.__helm.error || window.__helm.view !== "watch"), null, { timeout: 5 * MIN }).catch(() => {});
      await page.waitForTimeout(20_000);
      must((await saved()) === null, `a watched voyage saved a voyage: ${JSON.stringify(await saved()).slice(0, 120)}`);
      t = await title();
      must(!t.shown, `the title offers "Continue your voyage" after only practice and a watched voyage (${t.sub})`);
      out.push("practice and ?watch= saved nothing; title still has no offer");
      // 4. A crossing: sail a minute, leave, come back.
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.goto(SITE + "helm.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await page.evaluate(() => document.getElementById("go").click());
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), "the crossing didn't start");
      await page.waitForTimeout(60_000);
      await page.waitForFunction((k) => !!localStorage.getItem(k), KEY, { timeout: 40_000 }).catch(() => {});
      const left = await page.evaluate(() => ({ day: window.__helm.status?.day, clock: window.__helm.clock }));
      const kept = await saved();
      must(kept && kept !== "unreadable", `after a minute at sea nothing was saved (day ${left.day?.toFixed(2)})`);
      t = await title();
      must(t.shown, `back on the title there's no "Continue your voyage" (saved day ${kept.day})`);
      must(/Day \d+|The first day/.test(t.sub) && /km to go/.test(t.sub), `the offer doesn't give the day and the km to go: "${t.sub}"`);
      const keptNow = await saved();
      out.push(`left at day ${left.day?.toFixed(2)}; title offers "Continue your voyage": "${t.sub}"`);
      // The Set sail card offers it too.
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.goto(SITE + "helm.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      const card = await page.evaluate(() => { const e = document.getElementById("ss-continue"); return { shown: !!e && !e.hidden && e.offsetParent !== null, words: e?.innerText.trim().replace(/\s+/g, " ") ?? "" }; });
      must(card.shown, "the Set sail card doesn't offer the saved voyage");
      out.push(`card: "${card.words.slice(0, 110)}"`);
      // Open it from the title.
      t = await title();
      await page.evaluate(() => document.getElementById("t-continue").click());
      await page.waitForURL(/helm\.html\?.*continue=1/, { timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && ((window.__helm.ready && !window.__helm.busy) || window.__helm.error), null, { timeout: 10 * MIN });
      const back = await page.evaluate(() => ({ err: window.__helm.error, day: window.__helm.status?.day, clock: window.__helm.clock, first: document.querySelector("#timebar .rate")?.textContent.trim(), pressed: document.querySelector("#timebar .rate[aria-pressed=true]")?.textContent.trim() ?? "none", card: (() => { const e = document.getElementById("start"); return !!e && !e.hidden && e.offsetParent !== null; })() }));
      must(!back.err, `continuing failed: ${back.err}`);
      must(!back.card, "continuing shows the Set sail card instead of the voyage");
      must(Math.abs(back.day - keptNow.day) < 0.05, `the voyage came back at day ${back.day?.toFixed(2)}, but it was saved at day ${keptNow.day?.toFixed?.(2) ?? keptNow.day}`);
      must(back.clock === 0, `the continued voyage isn't paused (clock ${back.clock} h/s)`);
      must(back.first === "Real time", `Real time isn't first on the bar (${back.first})`);
      await page.screenshot({ path: `play-${BROWSER}-continue.png` }).catch(() => {});
      out.push(`continued at day ${back.day.toFixed(2)} (saved ${Number(keptNow.day).toFixed(2)}), paused, Real time first`);
      return out.join("; ");
    },
  },
  // #465 (Elena): with a crossing saved, the Set sail card at 390x844 and 1280x720, before and while
  // "End your voyage…?" is up: is the boat on the sea and whole, above the card (phone) or to its right?
  "look-continue": {
    manual: true,
    path: "helm.html",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.locator("#ss-ask").count())) throw new SkipCheck("this build has no ask before a new crossing (#465 not deployed)");
      // A saved crossing: sail one for a while, then take its save.
      await page.evaluate(() => document.getElementById("go").click());
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      await page.waitForFunction(() => !!localStorage.getItem("boatsim.voyage.v1"), null, { timeout: 2 * MIN }).catch(() => {});
      const raw = await page.evaluate(() => localStorage.getItem("boatsim.voyage.v1"));
      must(raw, "no voyage was saved after setting sail");
      const browser = page.context().browser();
      const shots = [];
      const out = [];
      for (const s of [{ name: "1280x720", viewport: { width: 1280, height: 720 } }, { name: "phone-390x844", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]) {
        const { name, ...opts } = s;
        const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" });
        await ctx.addInitScript((v) => { try { if (!localStorage.getItem("boatsim.voyage.v1")) localStorage.setItem("boatsim.voyage.v1", v); } catch {} }, raw);
        const p = await ctx.newPage();
        const shot = async (tag) => {
          const path = `look-continue-${name}-${tag}.jpg`;
          if (!(await jpeg(p, path))) return;
          const b64 = readFileSync(path).toString("base64");
          console.log(`LOOK-BEGIN ${path}`);
          for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
          console.log(`LOOK-END ${path}`);
          shots.push(`${name}-${tag}`);
        };
        await p.goto(SITE + "helm.html", { waitUntil: "load", timeout: 2 * MIN });
        await p.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 4 * MIN }).catch(() => {});
        await p.waitForLoadState("networkidle").catch(() => {});
        await p.waitForTimeout(6000);
        const offer = await p.evaluate(() => { const e = document.getElementById("ss-continue"); return { shown: !!e && !e.hidden && e.offsetParent !== null, words: e?.innerText.trim().replace(/\s+/g, " ") ?? "" }; });
        await shot("1-card");
        await p.evaluate(() => document.getElementById("go").click());
        const asked = await p.waitForFunction(() => { const e = document.getElementById("ss-ask"); return e && !e.hidden && e.offsetParent !== null; }, null, { timeout: 20_000 }).then(() => true, () => false);
        await p.waitForTimeout(3000);
        const q = await p.evaluate(() => ({ q: document.getElementById("ss-ask-q")?.textContent.trim() ?? "", btns: [...document.querySelectorAll("#ss-ask button")].map((b) => b.textContent.trim()), sailing: !!window.__helm.ready }));
        await shot("2-ask");
        out.push(`${name}: offer ${offer.shown ? `"${offer.words.slice(0, 80)}"` : "NOT shown"}; Set sail ${asked ? `asked "${q.q}" [${q.btns.join(" / ")}]` : "did NOT ask"}${q.sailing ? "; a NEW CROSSING STARTED" : ""}`);
        await ctx.close().catch(() => {});
      }
      return `${out.join("; ")}; frames ${shots.join(", ")}`;
    },
  },
  // Standing check (Maya, after #453 hid it everywhere; fix #466): while sailing, the helm's corner
  // chart shows at 1280 and 1920; at 1000 and 390 it folds to the map button.
  "helm-chart": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await page.evaluate(() => document.getElementById("go").click());
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), "the crossing didn't start");
      // The opening line ("Beat the autopilot to Portugal.") hides the instruments for a few seconds: wait it out.
      await page.waitForFunction(() => !document.body.classList.contains("goal"), null, { timeout: 40_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const seen = (id) => page.evaluate((id) => { const e = document.getElementById(id); if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); let o = 1; for (let n = e; n && n.nodeType === 1; n = n.parentElement) { const c = getComputedStyle(n); if (c.display === "none" || c.visibility === "hidden") return false; o *= Number(c.opacity); } return o > 0.5 && cs.display !== "none" && cs.visibility !== "hidden" && r.width > 8 && r.height > 8 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight; }, id);
      const out = [];
      const bad = [];
      for (const [w, h, want] of [[1280, 720, "chart"], [1920, 1080, "chart"], [1000, 700, "button"], [390, 844, "button"]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(1500);
        const chart = await seen("chart");
        const btn = await seen("mapbtn");
        const got = chart ? "chart" : btn ? "button" : "neither";
        out.push(`${w}x${h}: ${got}${chart && btn ? " and the map button too" : ""}`);
        if (got !== want) bad.push(`${w}x${h} shows ${got === "neither" ? "neither the chart nor the map button" : `the ${got}`}, should show the ${want}`);
        if (w === 1280) {
          const path = `look-helm-chart-${w}.jpg`;
          if (BROWSER === "chromium" && (await jpeg(page, path))) {
            const b64 = readFileSync(path).toString("base64");
            console.log(`LOOK-BEGIN ${path}`);
            for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
            console.log(`LOOK-END ${path}`);
          }
        }
      }
      must(!bad.length, `the corner chart: ${bad.join("; ")} (${out.join("; ")})`);
      return out.join("; ");
    },
  },
  // #460 (the cinematic plays planned sequences; C on the helm and on Watch a voyage), against John's
  // locked items: instruments hide (C2), N still toggles sound (C3), the clock doesn't jump (C4). On
  // voyage.html at 4d a second, leaving the film returns to 4d with the bar unchanged.
  "cinema-460": {
    path: "helm.html?quality=low",
    run: async (page) => {
      const out = [];
      // How visible an instrument is: 0 when not drawn, hidden or faded out.
      const shown = () => page.evaluate(() => Object.fromEntries(["strip", "timebar", "mapbox", "compass", "orders-tab", "topbar"].map((id) => {
        const e = document.getElementById(id);
        if (!e) return [id, null];
        let o = 1;
        for (let n = e; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === "none" || cs.visibility === "hidden") { o = 0; break; } o *= Number(cs.opacity); }
        const r = e.getBoundingClientRect();
        return [id, r.width < 2 || r.height < 2 ? 0 : +o.toFixed(2)];
      })));
      const film = async (name, hourOf, soundOf, maxHours) => {
        const before = await shown();
        const h0 = await page.evaluate(hourOf);
        await page.keyboard.press("c");
        await page.waitForFunction(() => document.body.classList.contains("cinema"), null, { timeout: 15_000 }).catch(() => {
          throw new CheckFail(`${name}: C didn't start the cinematic`);
        });
        // The clock is read once the film is on: at 4 days a second the moment between the key and the film is hours long.
        const hIn = await page.evaluate(hourOf);
        const tIn = Date.now();
        await page.waitForTimeout(4000); // the panels fade
        const inside = await shown();
        const still = Object.entries(inside).filter(([id, o]) => id !== "topbar" && o != null && o > 0.05 && before[id] > 0.05).map(([id, o]) => `#${id} (${o})`);
        must(!still.length, `${name}: instruments still show while filming (C2): ${still.join(", ")}`);
        // N toggles the sound and doesn't end the film (C3).
        const s0 = await page.evaluate(soundOf);
        await page.keyboard.press("n");
        await page.waitForTimeout(800);
        const s1 = await page.evaluate(soundOf);
        must(s0 !== s1, `${name}: N didn't toggle the sound while filming (C3): ${s0} then ${s1}`);
        must(await page.evaluate(() => document.body.classList.contains("cinema")), `${name}: N ended the film`);
        await page.keyboard.press("n");
        await page.waitForTimeout(800);
        must((await page.evaluate(soundOf)) === s0, `${name}: a second N didn't put the sound back`);
        await page.waitForTimeout(6000);
        const h1 = await page.evaluate(hourOf);
        const secs = (Date.now() - tIn) / 1000;
        console.log(`CINEMA ${BROWSER} ${name}: hour ${h0.toFixed(3)} before C, ${hIn.toFixed(3)} as the film began, ${h1.toFixed(3)} after ${secs.toFixed(1)} s of film; ${JSON.stringify(await page.evaluate(() => ({ warp: window.__replay?.warp, playing: window.__replay?.playing, clock: window.__helm?.clock })))}`);
        must(h1 - hIn >= -1e-6 && h1 - hIn <= maxHours, `${name}: the clock went from hour ${hIn.toFixed(3)} to ${h1.toFixed(3)} in ${secs.toFixed(1)} s of film (C4); it stood at ${h0.toFixed(3)} just before C`);
        await jpegLog(page, `cinema-${name}`);
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.body.classList.contains("cinema"), null, { timeout: 15_000 }).catch(() => {
          throw new CheckFail(`${name}: Esc didn't leave the cinematic`);
        });
        await page.waitForTimeout(2500);
        const after = await shown();
        const lost = Object.entries(before).filter(([id, o]) => o > 0.05 && !(after[id] > 0.05)).map(([id]) => `#${id}`);
        must(!lost.length, `${name}: after leaving the film these didn't come back: ${lost.join(", ")}`);
        return `${name}: hidden while filming (${Object.entries(before).filter(([, o]) => o > 0.05).map(([id]) => id).join(", ")}), N toggles sound, clock moved ${((h1 - hIn) * 60).toFixed(1)} min in ${secs.toFixed(0)} s of film, Esc leaves and they come back`;
      };
      const jpegLog = async (p, name) => {
        const path = `look-${name}.jpg`;
        if (BROWSER !== "chromium" || !(await jpeg(p, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
      };
      // The helm, sailing.
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await page.evaluate(() => document.getElementById("go").click());
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), "the crossing didn't start");
      await page.waitForTimeout(5000);
      const rate0 = await page.evaluate(() => document.querySelector("#timebar .rate[aria-pressed=true]")?.textContent.trim() ?? "paused");
      out.push(await film("helm", () => window.__helm.hour, () => !!window.__sound?.on, 0.25));
      const rate1 = await page.evaluate(() => document.querySelector("#timebar .rate[aria-pressed=true]")?.textContent.trim() ?? "paused");
      out.push(`helm speed ${rate0} before, ${rate1} after`);
      // Watch a voyage at 4 days a second.
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.goto(SITE + "voyage.html?voyage=2020-04-15&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 3 * MIN });
      must(!(await page.evaluate(() => window.__replay.error)), "the replay didn't load");
      const bar = () => page.evaluate(() => ({ warp: window.__replay.warp, playing: window.__replay.playing, pressed: [...document.querySelectorAll("#strip [aria-pressed=true], #timebar [aria-pressed=true]")].map((b) => b.textContent.trim()).join("|"), all: [...document.querySelectorAll("#strip button, #timebar button")].map((b) => `${b.textContent.trim()}${b.getAttribute("aria-pressed") === "true" ? "*" : ""}`).join(" ") }));
      await page.evaluate(() => document.querySelector('#strip button[data-warp="96"]')?.click()); // 4 days a second
      await page.waitForTimeout(1500);
      const b0 = await bar();
      must(b0.warp >= 90, `the 4d button didn't set 4 days a second on Watch a voyage (warp ${b0.warp}; bar ${b0.all})`);
      // While filming a fast replay runs at a minute a second (Leo), so 12 s is well under an hour.
      out.push(await film("voyage", () => window.__replay.hour, () => !!window.__sound?.on, 1));
      await page.waitForTimeout(1000);
      const b1 = await bar();
      must(b1.warp === b0.warp, `leaving the film left the replay at ${b1.warp} hours a second, not the ${b0.warp} it had`);
      must(b1.all === b0.all, `the speed bar changed across the film: "${b0.all}" then "${b1.all}"`);
      out.push(`voyage back at 4d (${b1.warp} h/s), bar unchanged: ${b1.all}`);
      return out.join("; ");
    },
  },
  // #474: after playing fast, the big map's side panel must read the same moment as the strip
  // (wind, waves, battery), on a crossing, on helm.html?watch= and on ?race=.
  "helm-readings": {
    path: "helm.html?quality=low",
    run: async (page) => {
      const out = [];
      const bad = [];
      const one = async (name, start) => {
        await start();
        must(!(await page.evaluate(() => window.__helm.error)), `${name}: didn't start: ${await page.evaluate(() => window.__helm.error)}`);
        await page.waitForFunction(() => !document.body.classList.contains("goal"), null, { timeout: 40_000 }).catch(() => {});
        // A minute at a day a second, answering any call with its first choice.
        const fast = () => page.evaluate(() => { if (!window.__helm.status?.over && window.__helm.clock !== 24) document.querySelector('#timebar .rate[data-rate="24"]')?.click(); });
        const t0 = Date.now();
        while (Date.now() - t0 < 60_000) {
          if (await page.evaluate(() => !document.getElementById("decide").hidden && document.querySelectorAll("#decidebtns button").length)) await page.locator("#decidebtns button").first().click({ noWaitAfter: true, timeout: 10_000 }).catch(() => {});
          await fast();
          await page.waitForTimeout(2000);
        }
        await page.evaluate(() => { if (window.__helm.clock !== 0) document.getElementById("t-pause")?.click(); });
        await page.waitForFunction(() => window.__helm.clock === 0, null, { timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(4000); // the picture catches up with the clock
        await page.evaluate(() => { if (!document.getElementById("mapbox").classList.contains("big")) (document.getElementById("chart").offsetParent ? document.getElementById("chart") : document.getElementById("mapbtn")).click(); });
        await page.waitForFunction(() => document.getElementById("mapbox").classList.contains("big"), null, { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const t = await page.evaluate(() => { const g = (id) => document.getElementById(id)?.textContent.trim().replace(/\s+/g, " ") ?? ""; return { big: document.getElementById("mapbox").classList.contains("big"), day: window.__helm.status?.day, wind: g("c-windv"), bat: g("c-batv"), pBat: g("battext"), pWeather: g("weather"), when: g("when") }; });
        if (BROWSER === "chromium") {
          const path = `look-readings-${name}.jpg`;
          if (await jpeg(page, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); }
        }
        const num = (s, re) => { const m = s.match(re); return m ? Number(m[1]) : null; };
        const strip = { kn: num(t.wind, /(\d+(?:\.\d+)?)\s*kn/), hs: num(t.wind, /(\d+(?:\.\d+)?)\s*m\b/), bat: num(t.bat, /(\d+)\s*%/) };
        const panel = { kn: num(t.pWeather, /(\d+(?:\.\d+)?)\s*kn/), hs: num(t.pWeather, /(\d+(?:\.\d+)?)\s*m\b/), bat: num(t.pBat, /(\d+)\s*%/) };
        const diff = [];
        if (strip.kn != null && panel.kn != null && Math.abs(strip.kn - panel.kn) > 1) diff.push(`wind ${strip.kn} kn on the strip, ${panel.kn} kn on the panel`);
        if (strip.hs != null && panel.hs != null && Math.abs(strip.hs - panel.hs) > 0.11) diff.push(`waves ${strip.hs} m on the strip, ${panel.hs} m on the panel`);
        if (strip.bat != null && panel.bat != null && Math.abs(strip.bat - panel.bat) > 1) diff.push(`battery ${strip.bat}% on the strip, ${panel.bat}% on the panel`);
        const unread = Object.keys(strip).filter((k) => strip[k] == null || panel[k] == null);
        const line = `${name} at day ${t.day?.toFixed(1)}${t.big ? "" : " (the big map didn't open)"}: strip "${t.wind}", "${t.bat}"; panel "${t.pWeather}", "${t.pBat}"${unread.length ? `; couldn't compare ${unread.join(", ")}` : ""}`;
        out.push(line);
        if (diff.length) bad.push(`${name} at day ${t.day?.toFixed(1)}: ${diff.join("; ")} (strip "${t.wind}", "${t.bat}"; panel "${t.pWeather}", "${t.pBat}")`);
      };
      await one("crossing", async () => {
        await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
        await page.evaluate(() => document.getElementById("go").click());
        await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      });
      for (const [name, q] of [["watch", "watch=2020-04-15"], ["race", "race=kayak,revb"]]) {
        await one(name, async () => {
          await page.waitForLoadState("networkidle").catch(() => {});
          await page.goto(SITE + `helm.html?${q}&quality=low`, { waitUntil: "load", timeout: 2 * MIN });
          await page.waitForFunction(() => window.__helm && ((window.__helm.ready && !window.__helm.busy) || window.__helm.error), null, { timeout: 8 * MIN });
        });
      }
      must(!bad.length, `the map panel and the strip disagree: ${bad.join(" | ")}`);
      return out.join("; ");
    },
  },
  // #473 (Rosa's link): a race where your own boat is lost. The race stops and says so, offers
  // "Follow <the other boat> to the end" beside "Race again"; a lost boat isn't drawn sailing; after
  // Follow the strip shows the other boat and the lead cell goes; the second card has no Follow.
  "race-lost": {
    path: "helm.html?race=kayak,revb&launch=2&quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && ((window.__helm.ready && !window.__helm.busy) || window.__helm.error), null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), `the race didn't load: ${await page.evaluate(() => window.__helm.error)}`);
      const out = [];
      const start = await page.evaluate(() => ({ clock: window.__helm.clock, first: document.querySelector("#timebar .rate")?.textContent.trim() }));
      must(start.clock === 0, `the race didn't open paused (clock ${start.clock} h/s)`);
      must(start.first === "Real time", `Real time isn't first on the bar (${start.first})`);
      const card = () => page.evaluate(() => { const r = document.getElementById("result"); const vis = (e) => !!e && !e.hidden && e.offsetParent !== null; return { up: vis(r), head: document.getElementById("r-head")?.textContent.trim() ?? "", story: document.getElementById("r-story")?.textContent.trim().replace(/\s+/g, " ") ?? "", btns: [...document.querySelectorAll("#result .rc-btns > *")].filter(vis).map((b) => b.textContent.trim()), day: window.__helm.status?.day, bat: document.getElementById("c-batv")?.textContent.trim() ?? "" }; });
      const run = async (label, mins) => {
        const t0 = Date.now();
        while (Date.now() - t0 < mins * MIN) {
          if ((await card()).up) return;
          await page.evaluate(() => { if (window.__helm.clock === 0 && document.getElementById("result").hidden) document.querySelector('#timebar .rate[data-rate="96"]')?.click(); });
          await page.waitForTimeout(2000);
        }
        throw new CheckFail(`${label}: no results card after ${mins} min at 4 days a second (day ${(await card()).day?.toFixed(1)})`);
      };
      const frame = async (name) => {
        const path = `look-${name}.jpg`;
        if (BROWSER !== "chromium" || !(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
      };
      await run("the race", 10);
      await page.waitForTimeout(3000);
      const c1 = await card();
      await frame("race-lost-1-card");
      console.log(`RACELOST ${BROWSER} card 1: ${JSON.stringify(c1)}`);
      must(/lost/i.test(c1.head), `the first card doesn't say your boat was lost: "${c1.head}"`);
      must(/still sailing/i.test(c1.story), `the first card doesn't say the other boat is still sailing: "${c1.story}"`);
      const follow = c1.btns.find((b) => /^Follow .* to the end$/.test(b));
      must(follow, `no "Follow … to the end" beside Race again: ${c1.btns.join(" / ")}`);
      must(c1.btns.some((b) => /Race again/.test(b)), `no "Race again" on the card: ${c1.btns.join(" / ")}`);
      out.push(`card 1 at day ${c1.day?.toFixed(1)}: "${c1.head}" "${c1.story}" [${c1.btns.join(" / ")}], strip battery ${c1.bat}`);
      await page.evaluate(() => document.getElementById("r-follow").click());
      await page.waitForFunction(() => document.getElementById("result").hidden, null, { timeout: 20_000 }).catch(() => {
        throw new CheckFail(`"${follow}" didn't close the card`);
      });
      await page.waitForTimeout(4000);
      const f = await page.evaluate(() => { const vis = (e) => { if (!e) return false; const cs = getComputedStyle(e); return cs.display !== "none" && cs.visibility !== "hidden" && e.offsetParent !== null; }; return { followed: !!window.__helm.followed, lead: vis(document.getElementById("c-lead")), bat: document.getElementById("c-batv")?.textContent.trim() ?? "", clock: window.__helm.clock, day: window.__helm.status?.day }; });
      await frame("race-lost-2-following");
      must(f.followed, "after Follow the page doesn't say it is following the other boat");
      must(!f.lead, `after Follow the strip still shows the "vs" lead cell`);
      out.push(`following: lead cell gone, strip battery ${f.bat} (was ${c1.bat} for the lost kayak), clock ${f.clock} h/s`);
      await run("following the other boat", 12);
      await page.waitForTimeout(3000);
      const c2 = await card();
      await frame("race-lost-3-end");
      console.log(`RACELOST ${BROWSER} card 2: ${JSON.stringify(c2)}`);
      must(/lost/i.test(c2.head + " " + c2.story), `the second card no longer says your boat was lost: "${c2.head}" "${c2.story}"`);
      must(!c2.btns.some((b) => /^Follow/.test(b)), `the second card still offers Follow: ${c2.btns.join(" / ")}`);
      out.push(`card 2 at day ${c2.day?.toFixed(1)}: "${c2.head}" "${c2.story}" [${c2.btns.join(" / ")}]`);
      return out.join("; ");
    },
  },
  // #473 (Rosa's second link): your boat finishes and the other was lost: one card, no Follow.
  "race-won": {
    path: "helm.html?race=kayak,revc&launch=0&quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && ((window.__helm.ready && !window.__helm.busy) || window.__helm.error), null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), `the race didn't load: ${await page.evaluate(() => window.__helm.error)}`);
      const card = () => page.evaluate(() => { const r = document.getElementById("result"); const vis = (e) => !!e && !e.hidden && e.offsetParent !== null; return { up: vis(r), head: document.getElementById("r-head")?.textContent.trim() ?? "", story: document.getElementById("r-story")?.textContent.trim().replace(/\s+/g, " ") ?? "", btns: [...document.querySelectorAll("#result .rc-btns > *")].filter(vis).map((b) => b.textContent.trim()), links: [...document.querySelectorAll("#result #r-links > *")].filter(vis).map((b) => b.textContent.trim()), day: window.__helm.status?.day, when: document.getElementById("day")?.textContent.trim() + " " + (document.getElementById("c-date")?.textContent.trim() ?? "") }; });
      const t0 = Date.now();
      let c = await card();
      while (!c.up && Date.now() - t0 < 20 * MIN) {
        await page.evaluate(() => { if (window.__helm.clock === 0 && document.getElementById("result").hidden) document.querySelector('#timebar .rate[data-rate="96"]')?.click(); });
        await page.waitForTimeout(2500);
        c = await card();
      }
      must(c.up, `no results card after 20 min at 4 days a second (day ${c.day?.toFixed(1)})`);
      await page.waitForTimeout(3000);
      c = await card();
      console.log(`RACEWON ${BROWSER}: ${JSON.stringify(c)}`);
      if (BROWSER === "chromium") {
        const path = "look-race-won-card.jpg";
        if (await jpeg(page, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); }
      }
      must(/finished/i.test(c.head), `the card doesn't say your boat finished: "${c.head}"`);
      must(/lost/i.test(c.head + " " + c.story), `the card doesn't say the other boat was lost: "${c.head}" "${c.story}"`);
      must(!c.btns.some((b) => /^Follow/.test(b)), `the card offers Follow though your boat finished: ${c.btns.join(" / ")}`);
      must(c.btns.some((b) => /Race again/.test(b)), `no "Race again": ${c.btns.join(" / ")}`);
      return `one card at day ${c.day?.toFixed(1)} (${Math.round((Date.now() - t0) / 1000)} s): "${c.head}" "${c.story}" [${c.btns.join(" / ")}], links ${c.links.join(" / ")}; strip "${c.when}"`;
    },
  },
  // Standing check (found 13 Nov on 9736678: the day and date sat under the speed buttons at 1280):
  // while sailing, every piece of text on the helm strip is inside the strip and not covered.
  "helm-strip-fit": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await page.evaluate(() => document.getElementById("go").click());
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), "the crossing didn't start");
      await page.waitForFunction(() => !document.body.classList.contains("goal"), null, { timeout: 40_000 }).catch(() => {});
      const bad = [];
      const out = [];
      const sizes = async (mode) => {
      for (const [w, h] of [[1280, 720], [1100, 700], [1920, 1080], [1400, 900], [1024, 700], [390, 844]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(2000);
        const r = await page.evaluate(() => {
          const strip = document.getElementById("strip");
          const sr = strip.getBoundingClientRect();
          const out = [];
          let n = 0;
          for (const e of strip.querySelectorAll("*")) {
            const own = [...e.childNodes].filter((c) => c.nodeType === 3 && c.textContent.trim()).map((c) => c.textContent.trim()).join(" ");
            if (!own || !e.offsetParent) continue;
            const cs = getComputedStyle(e);
            if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
            const b = e.getBoundingClientRect();
            if (b.width < 1 || b.height < 1) continue;
            n++;
            const t = `"${own.slice(0, 28)}"`;
            if (b.top < sr.top - 2 || b.bottom > sr.bottom + 2 || b.left < sr.left - 2 || b.right > sr.right + 2) { out.push(`${t} runs outside the strip`); continue; }
            if (b.right > innerWidth + 1 || b.bottom > innerHeight + 1 || b.left < -1) { out.push(`${t} runs off the window`); continue; }
            // Covered: at the text's middle and near its two ends, something that isn't it, its parent or its child is on top.
            const pts = [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5]].map(([fx, fy]) => document.elementFromPoint(b.left + b.width * fx, b.top + b.height * fy));
            const over = pts.filter((p) => p && p !== e && !e.contains(p) && !p.contains(e));
            if (over.length) out.push(`${t} is covered by ${over[0].id ? "#" + over[0].id : over[0].className ? "." + String(over[0].className).split(" ")[0] : over[0].tagName.toLowerCase()} ("${(over[0].textContent || "").trim().slice(0, 16)}")`);
            if (cs.textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 1) out.push(`${t} is cut off`);
          }
          // No speed button wraps onto a second line (Maya).
          for (const bt of strip.querySelectorAll("#timebar .rate")) {
            if (!bt.offsetParent) continue;
            const range = document.createRange();
            range.selectNodeContents(bt);
            const lines = new Set([...range.getClientRects()].map((q) => Math.round(q.top))).size;
            if (lines > 1) out.push(`the "${bt.textContent.trim()}" button wraps onto ${lines} lines`);
          }
          const day = document.getElementById("day");
          return { n, out: [...new Set(out)].slice(0, 8), day: day?.textContent.trim() ?? "" };
        });
        out.push(`${mode} ${w}x${h}: ${r.n} texts${r.out.length ? `, ${r.out.length} wrong` : " all clear"}`);
        if (r.out.length) bad.push(`${mode} at ${w}x${h}: ${r.out.join("; ")}`);
        if (w === 1280 && BROWSER === "chromium") {
          const path = `look-strip-${mode}-1280.jpg`;
          if (await jpeg(page, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); }
        }
      }
      };
      await sizes("sailing");
      // The watching and racing strips too (Maya).
      for (const [mode, q] of [["watching", "watch=2020-04-15"], ["racing", "race=kayak,revb"]]) {
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.goto(SITE + `helm.html?${q}&quality=low`, { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__helm && ((window.__helm.ready && !window.__helm.busy) || window.__helm.error), null, { timeout: 8 * MIN });
        if (await page.evaluate(() => window.__helm.error)) { bad.push(`${mode}: didn't load: ${await page.evaluate(() => window.__helm.error)}`); continue; }
        await page.waitForFunction(() => !document.body.classList.contains("goal"), null, { timeout: 40_000 }).catch(() => {});
        await sizes(mode);
      }
      must(!bad.length, `the helm strip: ${bad.join(" | ")}`);
      return out.join("; ");
    },
  },
  // #482 (Sam): leave a crossing at speed without pausing, then Continue your voyage. It must come
  // back within 0.05 of the day that was on screen and say "right where you left off"; if earlier,
  // it must say "You left on day X, but the last save was on day Y" and never "right where you left off".
  "continue-at-speed": {
    path: "helm.html?quality=low",
    run: async (page) => {
      const out = [];
      const bad = [];
      const notes = () => page.evaluate(() => (document.getElementById("notes")?.innerText ?? "").replace(/\s+/g, " ").trim());
      for (const [label, rate] of [["6 h a second", "6"], ["4 days a second", "96"]]) {
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.goto(SITE + "helm.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
        await page.evaluate(() => { try { localStorage.removeItem("boatsim.voyage.v1"); } catch {} });
        await page.goto(SITE + "helm.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
        await page.evaluate(() => document.getElementById("go").click());
        await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
        must(!(await page.evaluate(() => window.__helm.error)), `${label}: the crossing didn't start`);
        // Run at this speed to about day 1.5, answering any call with its first choice.
        const t0 = Date.now();
        while (Date.now() - t0 < 5 * MIN) {
          if (await page.evaluate(() => window.__helm.hour >= 36 && window.__helm.clock > 0)) break;
          if (await page.evaluate(() => !document.getElementById("decide").hidden && document.querySelectorAll("#decidebtns button").length)) await page.locator("#decidebtns button").first().click({ noWaitAfter: true, timeout: 10_000 }).catch(() => {});
          await page.evaluate((r) => { if (window.__helm.clock !== Number(r)) document.querySelector(`#timebar .rate[data-rate="${r}"]`)?.click(); }, rate);
          await page.waitForTimeout(400);
        }
        // Leave without pausing: the day on screen at that moment, then straight to the title.
        const left = await page.evaluate(() => ({ day: window.__helm.hour / 24, sim: window.__helm.status?.day, shown: document.getElementById("day")?.textContent.trim(), clock: window.__helm.clock }));
        must(left.clock > 0, `${label}: the clock wasn't running when I left (day ${left.day.toFixed(2)}, a call may have stopped it)`);
        await page.goto(SITE + "?quality=low", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 5, null, { timeout: 3 * MIN });
        await page.waitForTimeout(1500);
        const offer = await page.evaluate(() => { const a = document.getElementById("t-continue"); return { shown: !!a && !a.hidden && a.offsetParent !== null, sub: document.getElementById("t-continue-sub")?.textContent.trim() ?? "" }; });
        must(offer.shown, `${label}: after leaving at day ${left.day.toFixed(2)} the title has no "Continue your voyage"`);
        await page.evaluate(() => document.getElementById("t-continue").click());
        await page.waitForURL(/helm\.html\?.*continue=1/, { timeout: 2 * MIN });
        await page.waitForFunction(() => window.__helm && ((window.__helm.ready && !window.__helm.busy) || window.__helm.error), null, { timeout: 10 * MIN });
        must(!(await page.evaluate(() => window.__helm.error)), `${label}: continuing failed: ${await page.evaluate(() => window.__helm.error)}`);
        await page.waitForFunction(() => /Welcome back/.test(document.getElementById("notes")?.innerText ?? ""), null, { timeout: 30_000 }).catch(() => {});
        const back = await page.evaluate(() => ({ day: window.__helm.status?.day, shown: document.getElementById("day")?.textContent.trim(), clock: window.__helm.clock }));
        const note = await notes();
        const welcome = note.match(/Welcome back\.[^.]*(?:\.[^.]*)?\./)?.[0] ?? note.slice(0, 160);
        const gap = back.day - left.day;
        console.log(`LEAVE ${BROWSER} ${label}: left ${JSON.stringify(left)}; offer "${offer.sub}"; back ${JSON.stringify(back)}; note "${note.slice(0, 220)}"`);
        const line = `${label}: left on day ${left.day.toFixed(2)} (strip "${left.shown}"), came back on day ${back.day.toFixed(2)} (${gap >= 0 ? "+" : ""}${gap.toFixed(2)}), note "${welcome}"`;
        out.push(line);
        if (Math.abs(gap) <= 0.05) {
          if (!/right where you left off/.test(note)) bad.push(`${line}: on the same day, but the note doesn't say "right where you left off"`);
        } else if (gap < 0) {
          if (/right where you left off/.test(note)) bad.push(`${line}: came back ${(-gap).toFixed(2)} days EARLIER yet says "right where you left off"`);
          else if (!/You left on day [\d.]+, but the last save was on day [\d.]+/.test(note)) bad.push(`${line}: came back earlier, and the note doesn't give the day left and the day saved`);
          else bad.push(`${line}: came back ${(-gap).toFixed(2)} days earlier than the screen showed (the note says so honestly)`);
        } else bad.push(`${line}: came back ${gap.toFixed(2)} days LATER than the screen showed`);
        must(back.clock === 0, `${label}: the continued voyage isn't paused`);
      }
      must(!bad.length, bad.join(" | "));
      return out.join("; ");
    },
  },
  // #479: the film at night (Watch a voyage, darkest hour of day 2): six frames through the sequence,
  // for the astern shot and the others.
  "look-night-film": {
    manual: true,
    path: "voyage.html?voyage=2020-04-15",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 3 * MIN });
      must(!(await page.evaluate(() => window.__replay.error)), "the replay didn't load");
      const at = await page.evaluate(() => {
        const r = window.__replay;
        r.pause?.();
        let best = 30, el = 90;
        for (let h = 24; h < 48; h += 0.25) { const e = r.sunAt?.(h) ?? 90; if (e < el) [best, el] = [h, e]; }
        r.setHour(best);
        return { hour: best, sun: el };
      });
      await page.waitForTimeout(5000);
      await page.keyboard.press("c");
      await page.waitForFunction(() => document.body.classList.contains("cinema"), null, { timeout: 15_000 }).catch(() => {
        throw new CheckFail("C didn't start the film");
      });
      const shots = [];
      for (let i = 1; i <= 6; i++) {
        await page.waitForTimeout(i === 1 ? 4000 : 7000);
        const path = `look-night-film-${i}.jpg`;
        if (!(await jpeg(page, path))) continue;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let j = 0; j < b64.length; j += 4000) console.log(b64.slice(j, j + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(i);
      }
      const h1 = await page.evaluate(() => window.__replay.hour);
      await page.keyboard.press("Escape");
      return `night film at hour ${at.hour} (sun ${at.sun.toFixed(0)}°): ${shots.length} frames over about 40 s; the clock moved ${((h1 - at.hour) * 60).toFixed(1)} min`;
    },
  },
  // #486: the Set sail card on phones: the boat whole in the band above the card, the card whole on the screen.
  "look-setsail-phone": {
    manual: true,
    path: "helm.html",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      const browser = page.context().browser();
      const out = [];
      const shots = [];
      for (const [w, h] of [[390, 844], [360, 740]]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
        const p = await ctx.newPage();
        await p.goto(SITE + "helm.html", { waitUntil: "load", timeout: 2 * MIN });
        await p.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 4 * MIN }).catch(() => {});
        await p.waitForLoadState("networkidle").catch(() => {});
        await p.waitForTimeout(6000);
        const m = await p.evaluate(() => { const c = document.getElementById("ss-card").getBoundingClientRect(); const g = document.getElementById("go").getBoundingClientRect(); const b = window.__helm.boatBox?.() ?? null; const k = (window.devicePixelRatio || 1); return { card: [c.left, c.top, c.right, c.bottom].map(Math.round), go: [Math.round(g.top), Math.round(g.bottom)], goOn: g.top >= 0 && g.bottom <= innerHeight, credits: (() => { const e = document.getElementById("credits"); if (!e || e.offsetParent === null) return "not shown"; const r = e.getBoundingClientRect(); const over = !(r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom); return over ? `OVER the card at [${Math.round(r.left)},${Math.round(r.top)}]` : "clear of the card"; })(), cardOn: c.left >= 0 && c.right <= innerWidth && c.bottom <= innerHeight + 1, boat: b ? { x: Math.round(b.x / k), y: Math.round(b.y / k), w: Math.round(b.w / k), h: Math.round(b.h / k) } : null, win: [innerWidth, innerHeight] }; });
        const path = `look-setsail-phone-${w}x${h}.jpg`;
        if (await jpeg(p, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); shots.push(`${w}x${h}`); }
        const boatAbove = m.boat ? m.boat.y + m.boat.h / 2 <= m.card[1] + 2 && m.boat.x - m.boat.w / 2 >= -2 && m.boat.x + m.boat.w / 2 <= m.win[0] + 2 : null;
        out.push(`${w}x${h}: card ${JSON.stringify(m.card)} ${m.cardOn ? "on screen" : "RUNS OFF the screen"}, Set sail ${m.goOn ? "whole on screen" : "NOT whole on screen"}, Credits ${m.credits}, boat ${m.boat ? `${JSON.stringify(m.boat)} ${boatAbove ? "whole above the card" : "NOT whole above the card"}` : "box not reported"}`);
        await ctx.close().catch(() => {});
      }
      return `${out.join("; ")}; frames ${shots.join(", ")}`;
    },
  },
  // #487: the race strip shows a wind at day 0, before the race is started (it used to show a dash).
  "race-wind-day0": {
    path: "helm.html?race=kayak,revb&quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && ((window.__helm.ready && !window.__helm.busy) || window.__helm.error), null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), `the race didn't load: ${await page.evaluate(() => window.__helm.error)}`);
      await page.waitForFunction(() => !document.body.classList.contains("goal"), null, { timeout: 40_000 }).catch(() => {});
      await page.waitForFunction(() => /\d/.test(document.getElementById("c-windv")?.textContent ?? ""), null, { timeout: 20_000 }).catch(() => {});
      const t = await page.evaluate(() => ({ wind: document.getElementById("c-windv")?.textContent.trim() ?? "", label: document.getElementById("c-wavel")?.textContent.trim() ?? "", day: document.getElementById("day")?.textContent.trim() ?? "", clock: window.__helm.clock }));
      must(/\d+\s*kn/.test(t.wind), `at ${t.day}, before the race starts, the strip's wind cell reads "${t.wind}"`);
      return `${t.day}, paused (clock ${t.clock}): wind cell "${t.wind}" over "${t.label}"`;
    },
  },
  // #489: Who steers and Race against are on the plain Set sail card for everyone (no ?who=). The card opens on
  // You with Set sail; the autopilot gives "Watch her go" (her voyage, in Real time); Another boat gives "Start
  // the race"; and a first crossing with You still starts. At 1280 and on two phones the whole card is usable.
  "setsail-who": {
    path: "helm.html?quality=low",
    run: async (page) => {
      const browser = page.context().browser();
      const out = [];
      const open = async (w, h, phone) => {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(phone && BROWSER === "chromium" ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), serviceWorkers: "block" });
        const p = await ctx.newPage();
        await p.goto(SITE + "helm.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
        await p.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 3 * MIN });
        const has = await p.waitForFunction(() => document.querySelector("#ss-who-opts .ss-pill") && document.getElementById("ss-who").offsetParent !== null, null, { timeout: MIN }).then(() => true, () => false);
        return { ctx, p, has };
      };
      const state = (p) => p.evaluate(() => {
        const vis = (e) => !!e && e.offsetParent !== null;
        const pills = (b) => [...document.querySelectorAll(`${b} .ss-pill`)].filter(vis).map((e) => ({ t: e.textContent.trim(), on: e.getAttribute("aria-pressed") === "true" }));
        return { who: pills("#ss-who-opts"), rival: vis(document.getElementById("ss-rival")) ? pills("#ss-rival-opts") : null, go: document.getElementById("go").textContent.trim(), rows: [...document.querySelectorAll("#ss-card .ss-row")].filter(vis).map((e) => e.querySelector(".ss-l")?.textContent.trim()) };
      });
      const pick = (p, box, re) => p.evaluate(([b, r]) => { const e = [...document.querySelectorAll(`${b} .ss-pill`)].find((x) => x.offsetParent !== null && new RegExp(r, "i").test(x.textContent)); if (!e) return null; e.click(); return e.textContent.trim(); }, [box, re]);
      // Every pill and the button can be brought on screen and is the thing under the finger there.
      const usable = (p) => p.evaluate(async () => {
        const bad = [];
        // Pills inside a closed "More options" are not offered until it opens: leave them out.
        const els = [...document.querySelectorAll("#ss-card .ss-pill, #ss-card #go, #go")].filter((e) => e.offsetParent !== null && !e.closest("details:not([open])"));
        for (const e of new Set(els)) {
          e.scrollIntoView({ block: "center" });
          await new Promise((r) => setTimeout(r, 60));
          const r = e.getBoundingClientRect();
          const inside = r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!inside) bad.push(`"${e.textContent.trim().slice(0, 24)}" can't be brought whole on screen`);
          else if (!(top === e || e.contains(top) || top?.contains(e))) bad.push(`"${e.textContent.trim().slice(0, 24)}" is covered by ${top?.id || top?.className || top?.tagName}`);
        }
        const card = document.getElementById("ss-card").getBoundingClientRect();
        if (card.left < -1 || card.right > innerWidth + 1) bad.push(`the card is wider than the screen (${Math.round(card.left)}..${Math.round(card.right)} of ${innerWidth})`);
        if (document.documentElement.scrollWidth > innerWidth + 2) bad.push(`the page scrolls sideways (${document.documentElement.scrollWidth} of ${innerWidth})`);
        return { n: new Set(els).size, bad };
      });
      const shot = async (p, name) => {
        if (BROWSER !== "chromium") return;
        const path = `look-who-${name}.jpg`;
        if (await jpeg(p, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); }
      };
      const problems = [];
      // 1. The plain card at three sizes: opens on You with Set sail, whole card usable, with each choice picked too.
      for (const [w, h, phone] of [[1280, 720, false], [390, 844, true], [360, 740, true]]) {
        const { ctx, p, has } = await open(w, h, phone);
        try {
          if (!has) { if (w === 1280) throw new SkipCheck('the plain card has no "Who steers" row (#489 not deployed)'); problems.push(`${w}x${h}: no Who steers row`); continue; }
          const a = await state(p);
          const you = a.who.find((x) => x.on)?.t;
          if (you !== "You" || a.go !== "Set sail") problems.push(`${w}x${h}: opened on "${you}" with "${a.go}"`);
          const u1 = await usable(p);
          await p.evaluate(() => scrollTo(0, 0));
          await shot(p, `you-${w}x${h}`);
          const auto = await pick(p, "#ss-who-opts", "autopilot");
          await p.waitForTimeout(600);
          const b = await state(p);
          const u2 = await usable(p);
          await p.evaluate(() => scrollTo(0, 0));
          await shot(p, `autopilot-${w}x${h}`);
          const other = b.rival ? await pick(p, "#ss-rival-opts", "another") : null;
          await p.waitForTimeout(600);
          const c = await state(p);
          const u3 = await usable(p);
          await p.evaluate(() => scrollTo(0, 0));
          await shot(p, `race-${w}x${h}`);
          for (const [k, u] of [["You", u1], ["autopilot", u2], ["another boat", u3]]) if (u.bad.length) problems.push(`${w}x${h} with ${k}: ${u.bad.join("; ")}`);
          const days = await p.evaluate(() => [...document.querySelectorAll("#ss-when-opts .ss-pill")].filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim().replace(/\s+/g, " ")));
          out.push(`${w}x${h}: opens on "${you}" / "${a.go}", who ${a.who.map((x) => x.t).join(" | ")}; "${auto}" gives "${b.go}", race against ${b.rival ? b.rival.map((x) => x.t).join(" | ") : "(no row)"}; "${other}" gives "${c.go}"; days after both picks ${days.join(" | ")}; ${u1.n}/${u2.n}/${u3.n} controls ${u1.bad.length + u2.bad.length + u3.bad.length ? "NOT all usable" : "all usable"}`);
        } finally { await ctx.close().catch(() => {}); }
      }
      // 2. The autopilot, then "Watch her go": her voyage, in Real time.
      {
        const { ctx, p } = await open(1280, 720, false);
        try {
          await pick(p, "#ss-who-opts", "autopilot");
          await p.waitForFunction(() => /watch her go/i.test(document.getElementById("go").textContent), null, { timeout: 20_000 }).catch(() => {});
          const go = await p.evaluate(() => document.getElementById("go").textContent.trim());
          if (!/watch her go/i.test(go)) problems.push(`with the autopilot the button says "${go}", not "Watch her go"`);
          await p.evaluate(() => document.getElementById("go").click());
          await p.waitForURL(/[?&]watch=/, { timeout: MIN }).catch(() => {});
          await p.waitForFunction(() => window.__helm && (window.__helm.watch || window.__helm.error), null, { timeout: 5 * MIN }).catch(() => {});
          const a = await p.evaluate(() => ({ url: location.search, err: window.__helm?.error ?? null, watch: !!window.__helm?.watch, view: window.__helm?.view, pressed: document.querySelector("#timebar .rate[aria-pressed=true]")?.dataset.rate ?? null, hour: window.__helm?.hour }));
          await p.waitForTimeout(8000);
          const h2 = await p.evaluate(() => window.__helm?.hour);
          if (!/watch=/.test(a.url) || !a.watch || a.err) problems.push(`"Watch her go" didn't open her voyage: ${JSON.stringify(a)}`);
          else if (a.pressed !== "rt") problems.push(`her voyage opened at "${a.pressed}", not Real time`);
          else if (!(h2 > a.hour && h2 - a.hour < 0.05)) problems.push(`her voyage in Real time went hour ${a.hour} to ${h2} in 8 s`);
          await shot(p, "watching");
          out.push(`"${go}" opened ${a.url} (view ${a.view}) at "${a.pressed}", ${(((h2 ?? 0) - (a.hour ?? 0)) * 3600).toFixed(0)} s of voyage in 8 s`);
        } finally { await ctx.close().catch(() => {}); }
      }
      // 3. Another boat, then "Start the race": the race page.
      {
        const { ctx, p } = await open(1280, 720, false);
        try {
          await pick(p, "#ss-who-opts", "autopilot");
          await p.waitForFunction(() => document.getElementById("ss-rival").offsetParent !== null && document.querySelector("#ss-rival-opts .ss-pill"), null, { timeout: 20_000 }).catch(() => {});
          const other = await pick(p, "#ss-rival-opts", "another");
          await p.waitForFunction(() => /start the race/i.test(document.getElementById("go").textContent), null, { timeout: 20_000 }).catch(() => {});
          const s = await state(p);
          const against = await p.evaluate(() => { const e = document.getElementById("ss-against"); return e && e.offsetParent !== null ? document.getElementById("ss-against-name").textContent.trim() : null; });
          if (!/start the race/i.test(s.go)) problems.push(`with "${other}" the button says "${s.go}", not "Start the race"`);
          await p.evaluate(() => document.getElementById("go").click());
          await p.waitForURL(/[?&]race=/, { timeout: MIN }).catch(() => {});
          await p.waitForFunction(() => window.__helm && ((window.__helm.ready && !window.__helm.busy) || window.__helm.error), null, { timeout: 8 * MIN }).catch(() => {});
          const a = await p.evaluate(() => ({ url: location.search, err: window.__helm?.error ?? null, ready: !!window.__helm?.ready, lead: document.getElementById("c-lead")?.textContent.trim() ?? null, day: document.getElementById("day")?.textContent.trim() ?? null }));
          if (!/race=/.test(a.url) || !a.ready || a.err) problems.push(`"Start the race" didn't open the race: ${JSON.stringify(a)}`);
          await shot(p, "racing");
          out.push(`"${other}" (against ${against}) "${s.go}" opened ${a.url}: ${a.day}, "${a.lead}"`);
        } finally { await ctx.close().catch(() => {}); }
      }
      // 4. A first crossing with You still starts as before.
      {
        const { ctx, p } = await open(1280, 720, false);
        try {
          const a = await state(p);
          await p.evaluate(() => document.getElementById("go").click());
          const started = await p.waitForFunction(() => window.__helm && ((window.__helm.ready && document.getElementById("start").offsetParent === null) || window.__helm.error) && !window.__helm.busy, null, { timeout: 8 * MIN }).then(() => true, () => false);
          const b = await p.evaluate(() => ({ url: location.search, err: window.__helm?.error ?? null, sailing: !!window.__helm?.ready && typeof window.__helm?.status?.day === "number", view: window.__helm?.view, card: (() => { const e = document.getElementById("start"); return !!e && !e.hidden && e.offsetParent !== null; })(), day: document.getElementById("day")?.textContent.trim() ?? null }));
          if (!started || b.err || !b.sailing || b.card || /watch=|race=/.test(b.url)) problems.push(`Set sail with You didn't start a crossing: ${JSON.stringify(b)}`);
          out.push(`You + "${a.go}": sailing ${b.sailing}, ${b.day}, view ${b.view}`);
        } finally { await ctx.close().catch(() => {}); }
      }
      console.log(`WHO ${BROWSER}: ${out.join(" || ")}`);
      must(!problems.length, `${problems.join(" | ")} [[ ${out.join(" || ")} ]]`);
      return out.join("; ");
    },
  },
  // #492 (title glare): the title on live at 1280x720 and a 390x844 phone, High and Low, for the before/after
  // picture John asked for. Frames live-after-<size>[-low].jpg.
  "look-title-glare": {
    manual: true,
    path: "",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      const browser = page.context().browser();
      const out = [];
      for (const [tag, vp, extra] of [["1280", { width: 1280, height: 720 }, {}], ["390", { width: 390, height: 844 }, { isMobile: true, hasTouch: true }]]) {
        for (const q of ["high", "low"]) {
          const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, ...extra, serviceWorkers: "block" });
          const p = await ctx.newPage();
          await p.goto(SITE + `?quality=${q}`, { waitUntil: "load", timeout: 2 * MIN });
          await p.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 30, null, { timeout: 3 * MIN }).catch(() => {});
          await p.waitForLoadState("networkidle").catch(() => {});
          await p.waitForTimeout(8000);
          const path = `live-after-${tag}${q === "low" ? "-low" : ""}.jpg`;
          if (await jpeg(p, path)) {
            const b64 = readFileSync(path).toString("base64");
            console.log(`LOOK-BEGIN ${path}`);
            for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
            console.log(`LOOK-END ${path}`);
            out.push(path);
          }
          await ctx.close().catch(() => {});
        }
      }
      return `frames ${out.join(", ")}`;
    },
  },
  // #492 like-for-like: pick the Pearson 31 as My boat on the title (Change, then Sail this boat), reload, and
  // shoot the title at 1280 on High; report what the My boat line and the top bar chip say.
  "look-title-pearson": {
    manual: true,
    path: "",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      const browser = page.context().browser();
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, serviceWorkers: "block" });
      const p = await ctx.newPage();
      const words = () => p.evaluate(() => ({ line: document.getElementById("t-boatname")?.textContent.trim() ?? null, chip: document.getElementById("topbar-boat")?.textContent.trim() ?? null, saved: localStorage.getItem("boatsim.myboat.v1") }));
      try {
        await p.goto(SITE + "?quality=high", { waitUntil: "load", timeout: 2 * MIN });
        await p.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 10, null, { timeout: 3 * MIN }).catch(() => {});
        await p.waitForFunction(() => document.getElementById("t-change"), null, { timeout: MIN });
        await p.evaluate(() => document.getElementById("t-change").click());
        await p.waitForFunction(() => document.querySelector('#boatpick input[value="stock_pearson31_2"]'), null, { timeout: MIN }).catch(() => { throw new CheckFail("the boat picker has no Pearson 31"); });
        const label = await p.evaluate(() => { const i = document.querySelector('#boatpick input[value="stock_pearson31_2"]'); i.click(); return i.closest("label")?.textContent.trim(); });
        await p.evaluate(() => document.querySelector("#boatpick .go").click());
        await p.waitForTimeout(1500);
        const before = await words();
        await p.waitForLoadState("networkidle").catch(() => {});
        await p.reload({ waitUntil: "load", timeout: 2 * MIN });
        await p.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 30, null, { timeout: 3 * MIN }).catch(() => {});
        await p.waitForLoadState("networkidle").catch(() => {});
        await p.waitForTimeout(10000);
        const after = await words();
        const path = "live-after-pearson-1280.jpg";
        if (await jpeg(p, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); }
        const r = `picker row "${label}"; right after picking: line "${before.line}", chip "${before.chip}"; after reload: line "${after.line}", chip "${after.chip}"; saved ${after.saved}`;
        console.log(`PEARSON ${r}`);
        must(!/stock_/.test(`${before.line} ${before.chip} ${after.line} ${after.chip}`), `a file name shows: ${r}`);
        return r;
      } finally { await ctx.close().catch(() => {}); }
    },
  },
  // #494: the default kayak lit on the title, fresh browser, 1280 High (frame live-after2-kayak-1280.jpg).
  "look-title-kayak2": {
    manual: true,
    path: "",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      const ctx = await page.context().browser().newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, serviceWorkers: "block" });
      const p = await ctx.newPage();
      try {
        await p.goto(SITE + "?quality=high", { waitUntil: "load", timeout: 2 * MIN });
        await p.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 30, null, { timeout: 3 * MIN }).catch(() => {});
        await p.waitForLoadState("networkidle").catch(() => {});
        await p.waitForTimeout(10000);
        const boat = await p.evaluate(() => document.getElementById("t-boatname")?.textContent.trim());
        const path = "live-after2-kayak-1280.jpg";
        must(await jpeg(p, path), "the frame wasn't taken");
        const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`);
        return `My boat "${boat}"; frame ${path}`;
      } finally { await ctx.close().catch(() => {}); }
    },
  },
  // #498: the title off Annapolis at sunset with the town's skyline. 1280 High, kayak and Pearson, in both
  // browsers (frames live-<browser>-<boat>-1280.jpg); the "© OpenStreetMap contributors" credit shows on the
  // title and goes after Set sail.
  "look-title-shore": {
    manual: true,
    path: "",
    run: async (page) => {
      const browser = page.context().browser();
      const out = [];
      const problems = [];
      const PEARSON = JSON.stringify({ v: 1, kind: "stock", base: "stock_pearson31_2", hash: "", name: "Pearson 31-2 (our model)", choices: { base: "stock_pearson31_2" }, saved: "2026-11-13T09:00:00.000Z" });
      const osm = (p) => p.evaluate(() => { const e = document.getElementById("osm"); const r = e?.getBoundingClientRect(); return { here: !!e, shown: !!e && !e.hidden && e.offsetParent !== null && r.width > 0 && r.bottom <= innerHeight + 1, text: e?.textContent.trim() ?? "" }; });
      for (const [boat, saved] of [["kayak", null], ["pearson", PEARSON]]) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, serviceWorkers: "block" });
        if (saved) await ctx.addInitScript((v) => { try { if (!localStorage.getItem("boatsim.myboat.v1")) localStorage.setItem("boatsim.myboat.v1", v); } catch {} }, saved);
        const p = await ctx.newPage();
        try {
          await p.goto(SITE + "?quality=high", { waitUntil: "load", timeout: 2 * MIN });
          await p.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 30, null, { timeout: 4 * MIN }).catch(() => {});
          await p.waitForLoadState("networkidle").catch(() => {});
          await p.waitForTimeout(12000);
          const name = await p.evaluate(() => document.getElementById("t-boatname")?.textContent.trim());
          const a = await osm(p);
          const path = `live-${BROWSER}-${boat}-1280.jpg`;
          if (await jpeg(p, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); }
          if (!a.shown) problems.push(`${boat}: the OpenStreetMap credit isn't showing on the title (${JSON.stringify(a)})`);
          // Set sail: the title goes; the credit with it.
          await p.evaluate(() => document.getElementById("t-setsail").click());
          await Promise.race([p.waitForURL(/helm\.html/, { timeout: MIN }), p.waitForFunction(() => document.getElementById("title")?.hidden, null, { timeout: MIN })]).catch(() => {});
          await p.waitForLoadState("load").catch(() => {});
          await p.waitForTimeout(6000);
          const url = new URL(p.url()).pathname.split("/").pop() || "index";
          const b = await osm(p).catch(() => ({ here: false, shown: false, text: "" }));
          if (b.shown) problems.push(`${boat}: after Set sail (${url}) the OpenStreetMap credit still shows: "${b.text}"`);
          out.push(`${boat}: My boat "${name}"; title credit ${a.shown ? `shown "${a.text}"` : "NOT shown"}; after Set sail on ${url}: credit ${b.shown ? "STILL shown" : "gone"}`);
        } finally { await ctx.close().catch(() => {}); }
      }
      console.log(`SHORE ${BROWSER}: ${out.join(" || ")}`);
      must(!problems.length, `${problems.join(" | ")} [[ ${out.join(" || ")} ]]`);
      return out.join("; ");
    },
  },
  // #500 (E3): one results card for every ending. Reach the practice card (hand back with Esc), a watched voyage's
  // finish and a race finish, and shoot each card at 1280x720 and again with the window at 390x844.
  "ending-cards": {
    manual: true,
    path: "helm.html?quality=low",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("frames are taken in Chromium only");
      const out = [];
      const problems = [];
      const card = () => page.evaluate(() => { const r = document.getElementById("result"); const vis = (e) => !!e && !e.hidden && e.offsetParent !== null; const box = r?.getBoundingClientRect(); return { up: vis(r), head: document.getElementById("r-head")?.textContent.trim() ?? "", story: (document.getElementById("r-story")?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160), btns: [...document.querySelectorAll("#result .rc-btns > *, #result button, #result a")].filter(vis).map((b) => b.textContent.trim().replace(/\s+/g, " ")).filter((t, i, a) => t && a.indexOf(t) === i).slice(0, 8), box: box ? [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)] : null, win: [innerWidth, innerHeight], boat: window.__helm?.boatBox?.() ?? null, what: (() => { const t = (r?.innerText ?? "").replace(/\s+/g, " "); const i = t.search(/what happened/i); return i < 0 ? "" : t.slice(i, i + 260); })() }; });
      const shoot = async (name) => {
        for (const [w, h] of [[1280, 720], [390, 844]]) {
          await page.setViewportSize({ width: w, height: h });
          await page.waitForTimeout(2500);
          const c = await card();
          const path = `look-end-${name}-${w}.jpg`;
          if (await jpeg(page, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); }
          const inside = c.box && c.box[0] >= -1 && c.box[2] <= c.win[0] + 1;
          if (!c.up) problems.push(`${name} at ${w}: the card is not up`);
          else if (!inside) problems.push(`${name} at ${w}: the card is wider than the window ${JSON.stringify(c.box)}`);
          out.push(`${name} ${w}x${h}: "${c.head}" "${c.story}"${c.what ? ` WHAT "${c.what}"` : " (no What happened)"} [${c.btns.join(" / ")}] card ${JSON.stringify(c.box)} boat ${JSON.stringify(c.boat)}`);
        }
        await page.setViewportSize({ width: 1280, height: 720 });
      };
      const toEnd = async (label, limitMin) => {
        const t0 = Date.now();
        let c = await card();
        while (!c.up && Date.now() - t0 < limitMin * MIN) {
          await page.evaluate(() => { if (window.__helm?.clock === 0 && document.getElementById("result").hidden) document.querySelector('#timebar .rate[data-rate="96"]')?.click(); });
          await page.waitForTimeout(2500);
          c = await card();
        }
        if (!c.up) problems.push(`${label}: no results card after ${limitMin} min at 4 days a second`);
        await page.waitForTimeout(3000);
        return c.up;
      };
      // 1. Practice: the triangle, then hand the wheel back (Esc).
      await page.goto(SITE + "helm.html?practice&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await practiceTriangle(page);
      await page.waitForTimeout(4000);
      await page.keyboard.press("Escape");
      const pr = await page.waitForFunction(() => { const r = document.getElementById("result"); return r && !r.hidden && r.offsetParent !== null; }, null, { timeout: MIN }).then(() => true, () => false);
      if (pr) await shoot("practice"); else problems.push("practice: no card after handing back");
      // 2. A watched voyage to her finish.
      await page.goto(SITE + "helm.html?watch=2020-04-15&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && (window.__helm.watch || window.__helm.error), null, { timeout: 5 * MIN }).catch(() => {});
      if (await toEnd("watch", 15)) await shoot("watch");
      // 3. A race to the finish (Rosa's link: our kayak against Rev C, 1 Apr).
      await page.goto(SITE + "helm.html?race=kayak,revc&launch=0&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && ((window.__helm.ready && !window.__helm.busy) || window.__helm.error), null, { timeout: 8 * MIN }).catch(() => {});
      if (await toEnd("race", 20)) await shoot("race");
      console.log(`ENDS ${BROWSER}: ${out.join(" || ")}`);
      must(!problems.length, `${problems.join(" | ")} [[ ${out.join(" || ")} ]]`);
      return out.join("; ");
    },
  },
  // M3 on live (Maya, after #503): practice, a watched voyage, a race and a weather challenge, each to its results
  // card. At 1280x720, 390x844 and 360x740 the headline, the award and the first button are on screen and not
  // covered; the buttons are the ways on in the agreed order (helm/ending.ts); the challenge's try shows on the
  // leaderboard's Weather challenges tab. Phones here are the window resized with the card up.
  "m3-ends": {
    manual: true,
    path: "helm.html?quality=low",
    run: async (page) => {
      const out = [];
      const verdict = {};
      const ONLY = globalThis.__M3_ONLY ?? (process.env.M3_ONLY ?? "").split(/\s+/).filter(Boolean);
      const want = (m) => !ONLY.length || ONLY.includes(m);
      const SIZES = [[1280, 720], [390, 844], [360, 740]];
      const EXPECT = {
        practice: [/^(Try again|Race your best run)$/, /^Another course$/],
        watch: [/^Watch again$/, /^Sail it yourself$/, /^Race it$/, /^Leaderboard$/],
        race: [/^Race again$/, /^Follow .* to the end$/, /^Change the boats$/, /^Leaderboard$/],
        challenge: [/^Try again$/, /^Change the boat$/, /^Leaderboard$/],
      };
      const AWARD = { practice: "#r-medal", watch: "#r-nums .n", race: "#r-nums .n", challenge: "#r-stars" };
      const look = (award) => page.evaluate((award) => {
        const vis = (e) => !!e && !e.hidden && e.offsetParent !== null;
        const where = (e) => {
          if (!vis(e)) return "not shown";
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return "empty";
          if (r.top < -1 || r.left < -1 || r.bottom > innerHeight + 1 || r.right > innerWidth + 1) return `off screen [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}] of ${innerWidth}x${innerHeight}`;
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12));
          if (!(top === e || e.contains(top) || top?.contains(e))) return `covered by ${top?.id || top?.className || top?.tagName}`;
          return "on screen";
        };
        const btns = [...document.querySelectorAll("#r-btns > *")].filter(vis);
        const aw = document.querySelector(award);
        return {
          up: vis(document.getElementById("result")),
          head: document.getElementById("r-head")?.textContent.trim() ?? "",
          headAt: where(document.getElementById("r-head")),
          award: aw ? (aw.innerText || aw.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90) : "",
          awardAt: where(aw),
          btns: btns.map((b) => b.textContent.trim().replace(/\s+/g, " ")),
          firstAt: where(btns[0]),
          links: [...document.querySelectorAll("#r-links > *")].filter(vis).map((b) => b.textContent.trim()),
          what: (() => { const t = (document.getElementById("r-calls")?.innerText ?? "").replace(/\s+/g, " ").trim(); return vis(document.getElementById("r-calls")) ? t.slice(0, 200) : ""; })(),
        };
      }, award);
      const judge = async (mode) => {
        const bad = [];
        for (const [w, h] of SIZES) {
          await page.setViewportSize({ width: w, height: h });
          await page.waitForTimeout(2500);
          const c = await look(AWARD[mode]);
          {
            const path = `look-m3-${BROWSER}-${mode}-${w}.jpg`;
            if (await jpeg(page, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); }
          }
          if (!c.up) { bad.push(`${w}: card not up`); continue; }
          if (c.headAt !== "on screen") bad.push(`${w}: headline ${c.headAt}`);
          if (mode !== "practice" || c.awardAt !== "not shown") if (c.awardAt !== "on screen") bad.push(`${w}: award (${AWARD[mode]}) ${c.awardAt}`);
          if (c.firstAt !== "on screen") bad.push(`${w}: first button "${c.btns[0]}" ${c.firstAt}`);
          // The ways on in order: each shown button matches the next expected one (optional ones may be left out).
          let k = 0;
          for (const b of c.btns) { while (k < EXPECT[mode].length && !EXPECT[mode][k].test(b)) k++; if (k >= EXPECT[mode].length) { bad.push(`${w}: buttons out of order or unexpected: ${c.btns.join(" / ")}`); break; } k++; }
          out.push(`${mode} ${w}x${h}: "${c.head}" [${c.headAt}]; award "${c.award}" [${c.awardAt}]; buttons ${c.btns.join(" / ")} [first ${c.firstAt}]; links ${c.links.join(" / ")}${c.what ? `; "${c.what}"` : ""}`);
        }
        await page.setViewportSize({ width: 1280, height: 720 });
        verdict[mode] = bad.length ? `FAIL (${bad.join("; ")})` : "PASS";
      };
      const toEnd = async (mode, limitMin) => {
        const t0 = Date.now();
        while (Date.now() - t0 < limitMin * MIN) {
          if (await page.evaluate(() => { const r = document.getElementById("result"); return !!r && !r.hidden && r.offsetParent !== null; })) { await page.waitForTimeout(3000); return true; }
          if (await page.evaluate(() => !document.getElementById("decide")?.hidden && document.querySelectorAll("#decidebtns button").length)) await page.evaluate(() => document.querySelector("#decidebtns button")?.click());
          await page.evaluate(() => { if (window.__helm?.clock === 0 && document.getElementById("result").hidden) document.querySelector('#timebar .rate[data-rate="96"]')?.click(); });
          await page.waitForTimeout(2500);
        }
        const st = await page.evaluate(() => { const vis = (e) => !!e && !e.hidden && e.offsetParent !== null; const h = window.__helm ?? {}; return { url: location.search, ready: h.ready, busy: h.busy, error: h.error, hour: h.hour, day: h.status?.day, over: h.status?.over, clock: h.clock, view: h.view, frames: h.frames, rate: document.querySelector("#timebar .rate[aria-pressed=true]")?.dataset.rate ?? null, strip: document.getElementById("day")?.textContent.trim(), shown: [...document.querySelectorAll(".overlay, [role=dialog], #decide, #start, #arrive, #nl, #busy")].filter(vis).map((e) => e.id || e.className), msg: (document.getElementById("busytext") ?? document.getElementById("msg"))?.textContent?.trim() ?? null }; }).catch((e) => ({ err: String(e) }));
        const path = `look-m3-${BROWSER}-${mode}-stuck.jpg`;
        if (await jpeg(page, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); }
        console.log(`STUCK ${BROWSER} ${mode}: ${JSON.stringify(st)}`);
        verdict[mode] = `FAIL (no results card after ${limitMin} min at 4 days a second; state ${JSON.stringify(st)})`;
        return false;
      };
      if (want("practice")) {
      // 1. Practice: the triangle, then hand the wheel back (Esc).
      await page.goto(SITE + "helm.html?practice&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await practiceTriangle(page);
      // Hand back only once the wheel is really ours (slow runners take a while to give it), and try again if needed.
      await page.waitForFunction(() => window.__wheel?.on, null, { timeout: 2 * MIN }).catch(() => {});
      await page.waitForTimeout(3000);
      let handed = false;
      for (let k = 0; k < 4 && !handed; k++) {
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.keyboard.press("Escape");
        handed = await page.waitForFunction(() => { const r = document.getElementById("result"); return r && !r.hidden && r.offsetParent !== null; }, null, { timeout: 30_000 }).then(() => true, () => false);
      }
      if (handed) await judge("practice");
      else verdict.practice = "FAIL (no card after handing back)";
      }
      if (want("watch")) {
      // 2. A watched voyage to her end: our kayak launched 1 May 2020, lost on day 3.9 (a short one).
      await page.goto(SITE + "helm.html?watch=2020-05-01&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && (window.__helm.watch || window.__helm.error), null, { timeout: 5 * MIN }).catch(() => {});
      if (await toEnd("watch", 10)) await judge("watch");
      }
      if (want("race")) {
      // 3. A race whose card comes early: our model of the Rev B (lost on day 13 of 1 Apr) against our kayak.
      await page.goto(SITE + "helm.html?race=revb,kayak&launch=0&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && ((window.__helm.ready && !window.__helm.busy) || window.__helm.error), null, { timeout: 8 * MIN }).catch(() => {});
      if (await toEnd("race", 12)) await judge("race");
      }
      if (want("challenge")) {
      // 4. A weather challenge (Sandy's shadow, nine days), then its row on the Weather challenges tab.
      await page.goto(SITE + "helm.html?quality=low&challenge=sandys-shadow", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await page.evaluate(() => document.getElementById("go").click());
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN }).catch(() => {});
      if (await toEnd("challenge", 15)) {
        await judge("challenge");
        const href = await page.evaluate(() => [...document.querySelectorAll("#r-btns a, #r-links a")].find((a) => /Leaderboard/.test(a.textContent))?.getAttribute("href") ?? null);
        await page.goto(new URL(href ?? "./leaderboard.html#challenges", SITE + "helm.html").href, { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => document.querySelectorAll("#crows tr").length, null, { timeout: MIN }).catch(() => {});
        const b = await page.evaluate(() => ({ tab: document.getElementById("tab-challenges")?.getAttribute("aria-selected"), rows: [...document.querySelectorAll("#crows tr")].map((r) => ({ tried: r.classList.contains("tried"), name: r.querySelector(".name")?.textContent.trim(), yours: r.querySelector(".yours")?.textContent.trim().replace(/\s+/g, " "), auto: r.querySelector(".auto")?.textContent.trim() })) }));
        const row = b.rows.find((r) => /sandy/i.test(r.name ?? ""));
        if (BROWSER === "chromium") { const path = "look-m3-board.jpg"; if (await jpeg(page, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); } }
        const ok = b.tab === "true" && row?.tried;
        verdict.board = ok ? "PASS" : `FAIL (tab selected ${b.tab}; Sandy row ${JSON.stringify(row)})`;
        out.push(`board: from "${href}", Weather challenges tab ${b.tab === "true" ? "open" : "NOT open"}; Sandy's row ${JSON.stringify(row)}`);
      } else verdict.board = "not reached";
      }
      const sum = Object.entries(verdict).map(([k, v]) => `${k} ${v}`).join(" | ");
      console.log(`M3 ${BROWSER}: ${sum} || ${out.join(" || ")}`);
      must(!/FAIL|not reached/.test(sum), `${sum} [[ ${out.join(" || ")} ]]`);
      return `${sum}; ${out.join("; ")}`;
    },
  },
  // #504: the top bar's boat chip shows the whole name at 360 and 390 (Our kayak, and the Pearson), and the
  // title's My boat line says the same.
  "look-chip": {
    path: "",
    run: async (page) => {
      const browser = page.context().browser();
      const out = [];
      const bad = [];
      const PEARSON = JSON.stringify({ v: 1, kind: "stock", base: "stock_pearson31_2", hash: "", name: "Pearson 31-2 (our model)", choices: { base: "stock_pearson31_2" }, saved: "2026-11-13T09:00:00.000Z" });
      for (const [boat, saved, want] of [["kayak", null, "Our kayak"], ["pearson", PEARSON, "Pearson 31-2 (our model)"]]) {
        for (const [w, h] of [[390, 844], [360, 740]]) {
          const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(BROWSER === "chromium" ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), serviceWorkers: "block" });
          if (saved) await ctx.addInitScript((v) => { try { if (!localStorage.getItem("boatsim.myboat.v1")) localStorage.setItem("boatsim.myboat.v1", v); } catch {} }, saved);
          const p = await ctx.newPage();
          try {
            await p.goto(SITE + "?quality=low", { waitUntil: "load", timeout: 2 * MIN });
            await p.waitForFunction(() => document.getElementById("topbar-boat") && document.getElementById("t-boatname"), null, { timeout: 2 * MIN }).catch(() => {});
            await p.waitForTimeout(3000);
            const m = await p.evaluate(() => {
              const chip = document.getElementById("topbar-boat");
              const r = chip?.getBoundingClientRect();
              const cut = chip ? [chip, ...chip.querySelectorAll("*")].some((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible") : null;
              return { chip: chip?.innerText.trim().replace(/\s+/g, " ") ?? null, box: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] : null, inside: !!r && r.left >= -1 && r.right <= innerWidth + 1, cut, line: document.getElementById("t-boatname")?.textContent.trim() ?? null, bar: [...document.querySelectorAll("#topbar a, #topbar summary, #topbar button")].filter((e) => e.offsetParent !== null).map((e) => e.innerText.trim().replace(/\s+/g, " ")).filter(Boolean) };
            });
            if (BROWSER === "chromium") { const path = `look-chip-${boat}-${w}.jpg`; if (await jpeg(p, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); } }
            if (!m.chip || !m.chip.includes(want) || /…|\.\.\./.test(m.chip) || m.cut) bad.push(`${boat} at ${w}: chip "${m.chip}"${m.cut ? " (cut off)" : ""}`);
            if (!m.inside) bad.push(`${boat} at ${w}: chip runs off the screen ${JSON.stringify(m.box)}`);
            if (m.line !== want) bad.push(`${boat} at ${w}: title line "${m.line}"`);
            out.push(`${boat} ${w}x${h}: chip "${m.chip}" ${JSON.stringify(m.box)}${m.cut ? " CUT" : ""}; title line "${m.line}"; bar ${m.bar.join(" / ")}`);
          } finally { await ctx.close().catch(() => {}); }
        }
      }
      console.log(`CHIP ${BROWSER}: ${out.join(" || ")}`);
      must(!bad.length, `${bad.join(" | ")} [[ ${out.join(" || ")} ]]`);
      return out.join("; ");
    },
  },
  // L5 (Rosa): leaderboard.html#challenges opens the Weather challenges tab; the board's "Race it" opens the Set
  // sail card ready on "Start the race". (Known and parked: the phone's "Against our kayak" column runs off.)
  "board-raceit": {
    path: "leaderboard.html#challenges",
    run: async (page) => {
      await page.waitForFunction(() => window.__leaderboard?.ready, null, { timeout: 2 * MIN }).catch(() => {});
      await page.waitForTimeout(2000);
      const a = await page.evaluate(() => ({ tab: document.getElementById("tab-challenges")?.getAttribute("aria-selected"), panel: !document.getElementById("p-challenges")?.hidden, rows: document.querySelectorAll("#crows tr").length, race: [...document.querySelectorAll("a")].filter((e) => e.offsetParent !== null && /race it/i.test(e.textContent)).map((e) => ({ t: e.textContent.trim(), href: e.getAttribute("href") })) }));
      must(a.tab === "true" && a.panel, `#challenges didn't open the Weather challenges tab (${JSON.stringify(a)})`);
      // Race it may sit on the Boats tab.
      let links = a.race;
      if (!links.length) {
        await page.evaluate(() => document.getElementById("tab-designs")?.click());
        await page.waitForTimeout(1500);
        links = await page.evaluate(() => [...document.querySelectorAll("a")].filter((e) => e.offsetParent !== null && /race it/i.test(e.textContent)).map((e) => ({ t: e.textContent.trim(), href: e.getAttribute("href") })));
      }
      must(links.length, "no Race it link on either tab");
      console.log(`BOARD ${BROWSER}: tab ${a.tab}, ${a.rows} rows; Race it links ${JSON.stringify(links)}`);
      await page.goto(new URL(links[0].href, SITE + "leaderboard.html").href, { waitUntil: "load", timeout: 2 * MIN });
      const landed = await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 3 * MIN }).then(() => true, () => false);
      if (!landed) throw new CheckFail(`Race it (${links[0].href}) went to ${page.url()}, which never started a helm screen; it shows "${await page.evaluate(() => document.body.innerText.slice(0, 200).replace(/\s+/g, " ")).catch(() => "?")}"`);
      await page.waitForFunction(() => /start the race/i.test(document.getElementById("go")?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
      const b = await page.evaluate(() => ({ url: location.search, go: document.getElementById("go")?.textContent.trim(), card: !document.getElementById("start")?.hidden, against: document.getElementById("ss-against-name")?.textContent.trim() ?? null }));
      if (BROWSER === "chromium") { const path = "look-board-raceit.jpg"; if (await jpeg(page, path)) { const b64 = readFileSync(path).toString("base64"); console.log(`LOOK-BEGIN ${path}`); for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000)); console.log(`LOOK-END ${path}`); } }
      must(b.card && /start the race/i.test(b.go ?? ""), `Race it (${links[0].href}) opened ${b.url} with "${b.go}" (card ${b.card})`);
      return `#challenges opens the Weather challenges tab (${a.rows} rows); "${links[0].t}" ${links[0].href} opened the card on "${b.go}" against ${b.against}`;
    },
  },
  // m3-ends for the watched voyage and the race only (they time out on slow runners: frames and state when stuck).
  "m3-watch-race": {
    manual: true,
    path: "helm.html?quality=low",
    run: async (page) => { globalThis.__M3_ONLY = ["watch", "race"]; try { return await CHECKS["m3-ends"].run(page); } finally { globalThis.__M3_ONLY = undefined; } },
  },
  "look-marks": {
    manual: true,
    path: "helm.html?practice",
    run: async (page) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      const look = BROWSER === "chromium";
      const shots = [];
      const shot = async (name) => {
        if (!look) return;
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 3 * MIN });
      if (!(await page.evaluate(() => !!window.__buoys))) throw new SkipCheck("this build has no floating marks (#384 not deployed)");
      await practiceTriangle(page);
      await page.click(".w-gskip", { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(5000);
      // Sample the marks for 12 s: height above the water's mean, tilt, and whether each is shown.
      const sample = () =>
        page.evaluate(async () => {
          const ms = window.__buoys.group.children;
          const rows = ms.map(() => ({ y: [], tilt: [], vis: [] }));
          for (let k = 0; k < 48; k++) {
            ms.forEach((m, i) => {
              rows[i].y.push(m.position.y);
              rows[i].tilt.push(Math.hypot(m.rotation.x, m.rotation.z) * 57.3);
              rows[i].vis.push(m.visible);
            });
            await new Promise((r) => setTimeout(r, 250));
          }
          return rows;
        });
      const rows = await sample();
      must(rows.length >= 2, `only ${rows.length} marks on the triangle`);
      const out = [];
      rows.forEach((r, i) => {
        const lo = Math.min(...r.y), hi = Math.max(...r.y);
        const flips = r.vis.slice(1).filter((v, k) => v !== r.vis[k]).length;
        must(flips === 0, `mark ${i + 1} blinked in and out (${flips} changes in 12 s)`);
        if (!r.vis[0]) return;
        // y is the body's bottom: about -0.35 m (its draft) plus the wave under it.
        must(lo > -4 && hi < 3.5, `mark ${i + 1} is off the water: its bottom went from ${lo.toFixed(2)} to ${hi.toFixed(2)} m`);
        must(hi - lo > 0.02, `mark ${i + 1} doesn't move with the sea (height range ${(hi - lo).toFixed(3)} m in 12 s)`);
        out.push(`mark ${i + 1}: bottom ${lo.toFixed(2)}..${hi.toFixed(2)} m, tilt ${Math.min(...r.tilt).toFixed(1)}-${Math.max(...r.tilt).toFixed(1)}°`);
      });
      must(out.length, "no mark was showing");
      await shot("marks-course");
      // Up close: move the first shown mark to about 35 m off the boat, somewhere in view.
      if (look) {
        const placed = await page.evaluate(async () => {
          const b = window.__buoys;
          const i = b.group.children.findIndex((m) => m.visible);
          const mk = b.marks[i];
          for (const deg of [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
            const p = b.group.children[i].position;
            const a = (deg * Math.PI) / 180;
            // Scene x east, z south; the chase camera looks along the boat, roughly toward the mark.
            const dir = Math.atan2(p.x, -p.z) + a;
            const want = { x: 35 * Math.sin(dir), z: -35 * Math.cos(dir) };
            mk.x += want.x - p.x;
            mk.y -= want.z - p.z;
            await new Promise((r) => setTimeout(r, 600));
            const tag = document.getElementById("markptr");
            if (tag && tag.dataset.edge === "") return deg;
          }
          return null;
        });
        await page.waitForTimeout(3000);
        await shot("marks-close");
        out.push(placed == null ? "couldn't put a mark in view up close" : `close frame with the mark ${placed}° off the line to it`);
      }
      // The Annapolis page the player reaches from Watch a voyage.
      if (look) {
        await page.goto(SITE + "voyage.html?place=annapolis", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN }).catch(() => {});
        await page.waitForTimeout(8000);
        await shot("marks-voyage-annapolis");
      }
      return `${out.join("; ")}${shots.length ? `; frames ${shots.join(", ")}` : ""}`;
    },
  },
  "my-boat": {
    path: "boatyard.html?quality=low",
    run: async (page) => {
      // 20 characters at most: the Boatyard caps a name at 20 so it fits on the stern (#414).
      const NAME = "<b>Nina</b> Rev C";
      await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.$("#mb-save"))) throw new SkipCheck("the deployed Boatyard has no \"my boat\" button yet");
      await page.click('#bases button[data-base="revc"]', { noWaitAfter: true });
      await page.fill("#mb-name", NAME);
      await page.click("#mb-save", { noWaitAfter: true });
      await page.waitForFunction(() => !!window.__yard.mine, null, { timeout: 10_000 }).catch(() => {
        throw new CheckFail("clicking Save as my boat didn't save it (window.__yard.mine is empty)");
      });
      const yard = await page.evaluate(() => ({
        line: document.querySelector("#mb-line")?.textContent ?? "",
        btn: document.querySelector("#mb-save")?.textContent ?? "",
        stored: localStorage.getItem("boatsim.myboat.v1"),
      }));
      must(yard.stored, "nothing was stored under boatsim.myboat.v1");
      must(/your boat/i.test(yard.line), `the Boatyard line doesn't say it's my boat: "${yard.line}"`);
      const seen = [`Boatyard: "${yard.line.trim()}" / button "${yard.btn.trim()}"`];

      // Helm: the "mine" row is on top and ticked, and starting sails the Rev C.
      await page.goto(SITE + "helm.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      const helm = await page.evaluate(() => {
        const r = document.querySelector('input[name="boat"][value="mine"]');
        const label = r?.closest("label")?.textContent ?? "";
        return { has: !!r, checked: !!r?.checked, label };
      });
      must(helm.has, "the helm's boat list has no row for my boat");
      must(helm.checked, "my boat isn't ticked at the helm");
      must(helm.label.includes(NAME), `the helm's row doesn't show the name as typed: ${JSON.stringify(helm.label.trim())} (stored ${JSON.stringify(await page.evaluate(() => localStorage.getItem("boatsim.myboat.v1")?.slice(0, 160)))})`);
      await helmStart(page);
      const sailing = await page.evaluate(() => window.__helm.sailing);
      must(sailing?.base === "revc", `the helm sailed ${JSON.stringify(sailing)}, not my Rev C`);
      const st = await hop(page, "#s6");
      seen.push(`helm: sailing ${sailing.base}/${sailing.spec}, day ${st.day}`);

      // Race: my boat is the first, selected choice for boat A.
      await page.goto(SITE + "race.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => !!window.__race, null, { timeout: MIN });
      const race = await page.evaluate(() => {
        const sel = document.querySelector("#baseA");
        const first = sel?.options[0];
        return { value: sel?.value, first: first?.value, text: first?.textContent ?? "" };
      });
      must(race.first === "mine" && race.value === "mine", `the race doesn't pick my boat first: ${JSON.stringify(race)}`);
      must(race.text.includes(NAME), `the race option doesn't show the name as typed: "${race.text}"`);
      seen.push(`race: "${race.text}"`);

      // Voyage: with no ?voyage= it opens a replay of my boat's kind.
      await page.goto(SITE + "voyage.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN });
      const rep = await page.evaluate(() => ({ err: window.__replay.error, search: location.search }));
      must(!rep.err, `the voyage page didn't load my boat's replay: ${rep.err}`);
      seen.push("voyage: a replay loaded");
      return seen.join("; ");
    },
  },
  leaderboard: {
    path: "leaderboard.html",
    run: async (page) => {
      await page.waitForFunction(() => window.__leaderboard?.ready, null, { timeout: MIN });
      const lb = await page.evaluate(() => window.__leaderboard);
      must(!lb.error, `the board didn't load: ${lb.error}`);
      return `${lb.rows} rows`;
    },
  },
};

/** First line of a Playwright error plus the last steps of its call log (why a click waited: hidden, disabled, covered, off screen). */
function whyStuck(e) {
  const lines = String(e).split("\n");
  const log = lines.filter((l) => /^\s+-\s/.test(l)).slice(-3).map((l) => l.trim().replace(/^-\s*/, ""));
  return lines[0] + (log.length ? ` [${log.join(" / ")}]` : "");
}

async function runCheck(browser, name) {
  const t0 = Date.now();
  let o;
  let result = "";
  let failure = "";
  try {
    o = await open(browser, CHECKS[name].path);
    result = await CHECKS[name].run(o.page);
  } catch (e) {
    if (e instanceof SkipCheck) {
      await o?.ctx.close().catch(() => {});
      return { name, ok: true, skip: true, detail: [`skipped: ${e.message}`], notes: [], secs: Math.round((Date.now() - t0) / 1000) };
    }
    failure = e instanceof CheckFail ? e.message : `stuck or crashed: ${whyStuck(e)}`;
  }
  let notices = [];
  if (o) {
    notices = await visibleNotices(o.page).catch(() => []);
    await o.page.screenshot({ path: `play-${BROWSER}-${name}.png` }).catch(() => {});
  }
  const problems = [...(failure ? [failure] : []), ...(o?.errors ?? []), ...notices.map((n) => `notice: "${n}"`)];
  await o?.ctx.close().catch(() => {});
  return { name, ok: !problems.length, detail: problems.length ? problems : [result], notes: o?.notes ?? [], secs: Math.round((Date.now() - t0) / 1000) };
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHECKS).filter((n) => !CHECKS[n].manual);
for (const n of names) if (!CHECKS[n]) throw new Error(`unknown check ${n}; known: ${Object.keys(CHECKS).join(" ")}`);
// Headless Firefox on a runner has no WebGL ("WebGL creation failed"); run it
// headed under xvfb (HEADED=1, see the workflows) on Mesa's software GL, with WebGL forced on.
const LAUNCH = {
  headless: !process.env.HEADED,
  ...((process.env.BROWSER ?? "chromium") === "firefox"
    ? { firefoxUserPrefs: { "webgl.force-enabled": true, "webgl.disabled": false, "webgl.enable-webgl2": true } }
    : {}),
};
const browser = await pw[BROWSER].launch(LAUNCH);
const results = [];
for (const n of names) {
  const r = await runCheck(browser, n);
  results.push(r);
  console.log(`${r.skip ? "SKIP" : r.ok ? "PASS" : "FAIL"} ${BROWSER} ${n} (${r.secs} s):${r.detail.map((d) => `\n    - ${d}`).join("")}`);
  for (const x of r.notes.slice(0, 10)) console.log(`    (${x})`);
}
await browser.close();
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `| ${BROWSER} | Result |\n|---|---|\n${results.map((r) => `| ${r.skip ? "➖" : r.ok ? "✅" : "❌"} ${r.name} | ${r.detail.join("<br>").replace(/\|/g, "\\|")} |`).join("\n")}\n`,
  );
process.exit(results.some((r) => !r.ok) ? 1 : 0);
