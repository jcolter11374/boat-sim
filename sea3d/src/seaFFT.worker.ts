// The short-wave FFT off the main thread (seaFFT.ts): High is ~10 ms a frame.
//
// In:  {type: "init", detail} | {type: "step", t, sea, wind, half}
// Out: {t, cascades: [{a, b}]}: per patch two RGBA grids (see seaFFT.ts),
//      Float32Array, or Uint16Array half floats when `half` (no float filtering).
// The buffers are transferred; the page sends each back with its next step
// (`recycle`), so nothing is allocated per frame.

import { ShortWaves, packCascade, type SeaDetail, type WindSea } from "./seaFFT";

let waves: ShortWaves | null = null;
const spare: ArrayBuffer[] = [];

self.onmessage = (e: MessageEvent) => {
  const m = e.data as
    | { type: "init"; detail: SeaDetail }
    | { type: "step"; t: number; sea: WindSea; wind: number; half: boolean; recycle?: ArrayBuffer[] };
  if (m.type === "init") {
    waves = new ShortWaves(m.detail);
    return;
  }
  if (!waves) return;
  if (m.recycle) spare.push(...m.recycle);
  waves.setSea(m.sea, m.wind);
  waves.update(m.t);
  const out = waves.cascades.map((c) => packCascade(c, m.half, spare));
  const transfer = out.flatMap((o) => [o.a.buffer as ArrayBuffer, o.b.buffer as ArrayBuffer]);
  (self as unknown as Worker).postMessage({ t: m.t, cascades: out }, transfer);
};
