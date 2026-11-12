// Review render for the sea sound (Felix, Sound, 12 Nov 2026). Nobody on the team can listen
// from a sandbox, so this plays src/sound.ts in headless Chromium through an
// OfflineAudioContext, with the same code the pages run, and writes one WAV per scenario
// plus levels.json (loudness every half second). tools/sound-report.py draws the charts.
//   node tools/sound-render.mjs <outdir> [seconds]
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Playwright from the project if installed, else a global install (cloud sandboxes).
const { chromium } = await import("playwright").catch(() => createRequire(import.meta.url)("playwright"));

const out = process.argv[2] ?? "sound-review";
const SECONDS = Number(process.argv[3] ?? 60);
const RATE = 44100;
mkdirSync(out, { recursive: true });

const bundle = await build({
  entryPoints: ["src/sound.ts"],
  bundle: true,
  format: "iife",
  globalName: "Sea",
  write: false,
  logLevel: "warning",
});
const code = bundle.outputFiles[0].text;

/** Typical weather at a force: mid-band wind and a matching open-sea wave height. */
const HS = [0, 0.1, 0.3, 0.7, 1.2, 2.2, 3.4, 4.8, 6.4, 8, 10];
const at = (force, o = {}) => ({ wind: 0.836 * force ** 1.5, hs: HS[force], tp: 3 + 2.5 * Math.sqrt(HS[force]), rain: 0, near: 7, ...o });
const SCENES = [
  ...[1, 3, 4, 5, 6, 7, 8].map((f) => ({ name: `force${f}-pearson`, rig: "shrouds", w: at(f, { stw: f < 2 ? 1 : 2.6 }), hello: f === 1 })),
  { name: "force6-kayak", rig: "small", w: at(6, { stw: 1.4 }) },
  { name: "force8-kayak", rig: "small", w: at(8, { stw: 1.2 }) },
  // Same force 5 at 3 m/s: close-hauled (apparent wind about 13 m/s) vs running (about 6).
  { name: "force5-beating", rig: "shrouds", w: at(5, { stw: 3, apparent: 13.2 }) },
  { name: "force5-running", rig: "shrouds", w: at(5, { stw: 3, apparent: 6.2 }) },
  { name: "force2-drifting-swell", rig: "shrouds", w: at(2, { stw: 0.2, hs: 1.2, tp: 9 }) },
  { name: "force5-rain", rig: "shrouds", w: at(5, { stw: 2.4, rain: 0.8 }) },
  // Cinematic: the camera cuts between close (5 m) and far (80 m) every 8 s, a fade on every second cut.
  { name: "force5-cinematic-cuts", rig: "shrouds", w: at(5, { stw: 2.4 }), cuts: true },
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");
await page.addScriptTag({ content: code });

const levels = {};
for (const s of SCENES) {
  const b64 = await page.evaluate(
    async ({ s, SECONDS, RATE }) => {
      const ctx = new OfflineAudioContext(1, SECONDS * RATE, RATE);
      const snd = new window.Sea.OceanSound();
      snd.rig = s.rig;
      snd.attach(ctx, s.seed);
      const dt = 1 / 30;
      for (let i = 1; i * dt < SECONDS - 0.05; i++) {
        const t = i * dt;
        void ctx.suspend(t).then(() => {
          let near = s.w.near;
          if (s.cuts) {
            const k = Math.floor(t / 8);
            near = k % 2 ? 80 : 5;
            if (k % 2 === 0 && t % 8 > 7.6 && t % 8 < 7.6 + dt) snd.duck(0.7);
          }
          if (s.hello && Math.abs(t - 0.5) < dt / 2) snd.hello();
          snd.update(dt, { ...s.w, near });
          void ctx.resume();
        });
      }
      const buf = await ctx.startRendering();
      const d = buf.getChannelData(0);
      const i16 = new Int16Array(d.length);
      for (let i = 0; i < d.length; i++) i16[i] = Math.max(-1, Math.min(1, d[i])) * 32767;
      let bin = "";
      const u8 = new Uint8Array(i16.buffer);
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    { s: { ...s, seed: Number(process.env.SEED ?? 12345) }, SECONDS, RATE },
  );
  const pcm = Buffer.from(b64, "base64");
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  writeFileSync(join(out, `${s.name}.wav`), Buffer.concat([head, pcm]));
  // Loudness every half second (RMS, dB full scale) and the peak.
  const n = pcm.length / 2;
  const win = RATE / 2;
  const rms = [];
  let peak = 0;
  for (let i = 0; i + win <= n; i += win) {
    let e = 0;
    for (let j = 0; j < win; j++) {
      const v = pcm.readInt16LE((i + j) * 2) / 32768;
      e += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    rms.push(+(10 * Math.log10(e / win + 1e-12)).toFixed(2));
  }
  levels[s.name] = { rms, peakDb: +(20 * Math.log10(peak + 1e-12)).toFixed(2) };
  const steady = rms.slice(4); // skip the first 2 s (the beds fading in, the hello lap), as the chart does
  const mean = 10 * Math.log10(steady.reduce((a, v) => a + 10 ** (v / 10), 0) / steady.length);
  console.log(`${s.name.padEnd(24)} mean ${mean.toFixed(1)} dBFS  peak ${levels[s.name].peakDb} dBFS`);
}
writeFileSync(join(out, "levels.json"), JSON.stringify(levels));
await browser.close();
