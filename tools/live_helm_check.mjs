// Load the LIVE helm page the way a first-time visitor would (fresh profile,
// no cache), press "Take the helm", and report what happens. Usage:
//   node tools/live_helm_check.mjs [url]
import { chromium, firefox } from "playwright";
const url = process.argv[2] ?? "https://jcolter11374.github.io/boat-sim/helm.html";
let bad = 0;
for (const [name, type] of [["chromium", chromium], ["firefox", firefox]]) {
  const b = await type.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  const log = [];
  p.on("console", (m) => log.push(`[${m.type()}] ${m.text()}`));
  p.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));
  p.on("requestfailed", (r) => log.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  p.on("response", (r) => { if (r.status() >= 400) log.push(`[http ${r.status()}] ${r.url()}`); });
  const t0 = Date.now();
  await p.goto(url, { waitUntil: "load", timeout: 60000 });
  await p.waitForTimeout(3000);
  const goVisible = await p.isVisible("#go");
  log.push(`go button visible: ${goVisible}`);
  if (goVisible) await p.click("#go");
  let state = "";
  for (let i = 0; i < 60; i++) {
    await p.waitForTimeout(5000);
    state = await p.evaluate(() => JSON.stringify({
      startHidden: document.getElementById("start")?.hidden,
      startmsg: document.getElementById("startmsg")?.textContent,
      busy: document.body.classList.contains("busy"),
      busyText: document.getElementById("busy")?.textContent,
      day: document.getElementById("day")?.textContent,
      ready: (window).page?.ready, error: (window).page?.error,
    }));
    const s = JSON.parse(state);
    if (s.ready || s.error || (s.startmsg && !s.startHidden)) break;
  }
  await p.screenshot({ path: `live-helm-${name}.png` });
  const s = JSON.parse(state);
  const ok = !!s.ready && !s.error;
  if (!ok) bad++;
  console.log(`\n=== ${name}: ${ok ? "STARTED" : "DID NOT START"} after ${((Date.now() - t0) / 1000).toFixed(0)} s\n${state}\n${log.slice(0, 60).join("\n")}`);
  await b.close();
}
process.exit(bad ? 1 : 0);
