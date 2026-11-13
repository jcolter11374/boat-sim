// Review render for the title's sound (Hana, 13 Nov 2026), after tools/sound-render.mjs:
// nobody on the team can listen from a sandbox, so this plays src/titleSound.ts (over
// src/sound.ts) in headless Chromium through an OfflineAudioContext, with the same code the
// page runs, and writes one WAV per scene plus levels.json. tools/title-sound-report.py
// draws the charts.
//   node tools/title-sound-render.mjs <outdir> [seconds]
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { chromium } = await import("playwright").catch(() => createRequire(import.meta.url)("playwright"));

const out = process.argv[2] ?? "title-sound-review";
const SECONDS = Number(process.argv[3] ?? 60);
const RATE = 44100;
mkdirSync(out, { recursive: true });

const bundle = await build({
  stdin: { contents: 'export * from "./src/sound"; export * from "./src/titleSound"; export * from "./src/titleMusic";', resolveDir: ".", loader: "ts" },
  bundle: true,
  format: "iife",
  globalName: "T",
  write: false,
  logLevel: "warning",
});
const code = bundle.outputFiles[0].text;

const SCENES = [
  // The title as a visitor hears it for a minute: the sea, and whatever the timeline brings.
  { name: "title-as-heard-kayak", rig: "small", length: 3.05, timeline: true },
  { name: "title-as-heard-yacht", rig: "shrouds", length: 9.4, timeline: true, seed: 777 },
  // With the far gull allowed (?gulls=1): off on the live title until someone has heard it.
  { name: "title-as-heard-kayak-gulls", rig: "small", length: 3.05, timeline: true, gulls: true },
  // The whole title: the sea, its sounds and the air, once round (pad, the tune, then the sea alone).
  { name: "title-with-music-kayak", rig: "small", length: 3.05, timeline: true, music: true, seconds: 100 },
  // The air over the sea with nothing else, to measure it against the sea alone (same seed).
  { name: "title-music-and-sea", rig: "small", length: 3.05, music: true, seconds: 100 },
  { name: "title-sea-only-100s", rig: "small", length: 3.05, seconds: 100 },
  // The sea alone, for comparison (what the effects sit on).
  { name: "title-sea-only", rig: "small", length: 3.05 },
  // Each sound in turn over the sea, at known times (the chart labels them).
  {
    name: "title-each-sound",
    rig: "small",
    length: 3.05,
    seconds: 46,
    moments: [[3, "buoy"], [10, "lap"], [15, "creak"], [21, "buoy"], [27, "hover:0"], [27.5, "hover:1"], [28, "hover:2"], [28.5, "hover:3"], [29, "hover:4"], [32, "press:0"], [35, "press:2"], [38, "lap"], [41, "gull"]],
  },
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");
await page.addScriptTag({ content: code });

const levels = {};
for (const s of SCENES) {
  const seconds = s.seconds ?? SECONDS;
  const b64 = await page.evaluate(
    async ({ s, seconds, RATE }) => {
      const ctx = new OfflineAudioContext(1, seconds * RATE, RATE);
      const sea = new window.T.OceanSound();
      sea.rig = s.rig;
      sea.length = s.length;
      sea.attach(ctx, s.seed);
      const title = new window.T.TitleSound(sea, s.seed + 1);
      title.scene.sails = s.rig === "shrouds";
      title.scene.gulls = !!s.gulls;
      const music = s.music ? new window.T.TitleMusic(sea) : null;
      const dt = 1 / 30;
      for (let i = 1; i * dt < seconds - 0.05; i++) {
        const t = i * dt;
        void ctx.suspend(t).then(() => {
          if (s.timeline) title.update(dt);
          else sea.update(dt, window.T.TITLE_WEATHER);
          music?.update();
          for (const [at, what] of s.moments ?? []) {
            if (Math.abs(t - at) < dt / 2) {
              const [kind, arg] = what.split(":");
              if (kind === "hover" || kind === "press") title.chime(Number(arg), kind === "press");
              else title.play(kind);
            }
          }
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
      return { b64: btoa(bin), played: sea.played };
    },
    { s: { ...s, seed: s.seed ?? Number(process.env.SEED ?? 12345) }, seconds, RATE },
  );
  const pcm = Buffer.from(b64.b64, "base64");
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
  levels[s.name] = { rms, peakDb: +(20 * Math.log10(peak + 1e-12)).toFixed(2), played: b64.played, moments: s.moments ?? null };
  const steady = rms.slice(4);
  const mean = 10 * Math.log10(steady.reduce((a, v) => a + 10 ** (v / 10), 0) / steady.length);
  console.log(`${s.name.padEnd(24)} mean ${mean.toFixed(1)} dBFS  peak ${levels[s.name].peakDb} dBFS  played: ${b64.played.map((p) => `${p.name}@${p.t.toFixed(0)}`).join(" ")}`);
}
writeFileSync(join(out, "levels.json"), JSON.stringify(levels));
await browser.close();
