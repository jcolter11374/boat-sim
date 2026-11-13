// The short-wave layer on the page: runs the FFT (seaFFT.ts) in a worker,
// hands the results to every sea-reading shader as textures (seaSurface.ts
// seaUniforms), and keeps the same grids for heightAt() on the CPU.
//
// Half-float textures: WebGL2 can always filter them, and nothing renders into
// them, so no float render targets are needed (Maya). Without WebGL2 or
// workers, the layer stays off and the sea shader keeps its old ripples.

import * as THREE from "three";
import { DETAIL, PATCH, ShortWaves, fromHalf, packCascade, type Packed, type SeaDetail, type WindSea } from "./seaFFT";
import { seaUniforms } from "./seaSurface";

export type Detail = SeaDetail | "off";

function makeTexture(n: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint16Array(n * n * 4), n, n, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export class ShortWaveLayer {
  readonly detail: Detail;
  private worker: Worker | null = null;
  private local: ShortWaves | null = null; // no worker (tests): on this thread
  private busy = false;
  private sea: WindSea = { hs: 0, tp: 4, direction: 0 };
  private wind = 0;
  private latest: Packed[] | null = null;
  private recycle: ArrayBuffer[] = [];
  private readonly tex: { a: THREE.DataTexture; b: THREE.DataTexture }[] = [];
  /** How far the water has gone by, per patch, wrapped to the patch (m). */
  private off = [new THREE.Vector2(), new THREE.Vector2()];
  private readonly sizes: number[];
  private readonly n: number;

  constructor(detail: Detail, opts: { worker?: boolean } = {}) {
    this.detail = detail;
    const u = seaUniforms;
    if (detail === "off") {
      this.sizes = [];
      this.n = 0;
      u.uSeaDetN.value = 0;
      return;
    }
    const d = DETAIL[detail];
    this.n = d.n;
    this.sizes = d.cascades === 1 ? [PATCH[0]] : [PATCH[1], PATCH[0]];
    for (let i = 0; i < d.cascades; i++) this.tex.push({ a: makeTexture(d.n), b: makeTexture(d.n) });
    u.uSeaDetN.value = d.cascades;
    u.uSeaDetRes.value = d.n;
    u.uSeaDetMove.value = d.moves ? 1 : 0;
    u.uSeaDetSize.value.set(this.sizes[0], this.sizes[1] ?? 1);
    u.uSeaDetA0.value = this.tex[0].a;
    u.uSeaDetB0.value = this.tex[0].b;
    u.uSeaDetA1.value = (this.tex[1] ?? this.tex[0]).a;
    u.uSeaDetB1.value = (this.tex[1] ?? this.tex[0]).b;
    u.uSeaDetOff0.value = this.off[0];
    u.uSeaDetOff1.value = this.off[1];
    const useWorker = opts.worker ?? typeof Worker !== "undefined";
    if (useWorker) {
      try {
        this.worker = new Worker(new URL("./seaFFT.worker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (e: MessageEvent) => this.arrive(e.data.cascades as Packed[]);
        this.worker.onerror = () => this.fallBack();
        this.worker.postMessage({ type: "init", detail });
      } catch {
        this.fallBack();
      }
    } else this.local = new ShortWaves(detail);
  }

  private fallBack(): void {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    if (this.detail !== "off") this.local = new ShortWaves(this.detail);
  }

  /** The wind sea and wind speed (m/s) now. */
  setSea(sea: WindSea, windMs: number): void {
    this.sea = sea;
    this.wind = windMs;
  }

  /** The boat moved (dx, dz) m through the water: the short waves flow past too. */
  flow(dx: number, dz: number): void {
    for (let i = 0; i < this.sizes.length; i++) {
      const L = this.sizes[i];
      const o = this.off[i];
      o.set((((o.x + dx) % L) + L) % L, (((o.y + dz) % L) + L) % L);
    }
  }

  /** Move on to time t (s): ask for the next frame, show the newest one that's arrived. */
  update(t: number): void {
    if (this.detail === "off") return;
    if (this.local) {
      this.local.setSea(this.sea, this.wind);
      this.local.update(t);
      this.arrive(this.local.cascades.map((c) => packCascade(c, true, this.recycle)));
      return;
    }
    if (this.worker && !this.busy) {
      this.busy = true;
      const recycle = this.recycle.splice(0);
      this.worker.postMessage({ type: "step", t, sea: this.sea, wind: this.wind, half: true, recycle }, recycle);
    }
  }

  private arrive(packed: Packed[]): void {
    this.busy = false;
    packed.forEach((p, i) => {
      const t = this.tex[i];
      if (!t) return;
      for (const [tex, data] of [[t.a, p.a], [t.b, p.b]] as const) {
        const img = tex.image as unknown as { data: Uint16Array };
        const old = img.data;
        if (old && old.buffer !== data.buffer && old.byteLength === data.byteLength) this.recycle.push(old.buffer as ArrayBuffer);
        img.data = data as Uint16Array;
        tex.needsUpdate = true;
      }
    });
    // keep a copy of the heights for the CPU (the textures' arrays are recycled)
    this.latest = packed.map((p) => ({ a: (p.a as Uint16Array).slice(), b: p.b }));
  }

  /** Height of the short waves at scene (x, z) (m), as drawn (0 before the first frame or when off). */
  heightAt(x: number, z: number): number {
    if (!this.latest || !this.n) return 0;
    const n = this.n;
    const field = (ci: number, ch: number, px: number, pz: number) => {
      const a = this.latest![ci].a as Uint16Array;
      const L = this.sizes[ci];
      const u = ((px + this.off[ci].x) / L) * n;
      const v = ((pz + this.off[ci].y) / L) * n;
      const i0 = Math.floor(u);
      const j0 = Math.floor(v);
      const fu = u - i0;
      const fv = v - j0;
      const w = (i: number, j: number) => fromHalf(a[4 * ((((j % n) + n) % n) * n + (((i % n) + n) % n)) + ch]);
      return (w(i0, j0) * (1 - fu) + w(i0 + 1, j0) * fu) * (1 - fv) + (w(i0, j0 + 1) * (1 - fu) + w(i0 + 1, j0 + 1) * fu) * fv;
    };
    let px = x;
    let pz = z;
    for (let it = 0; it < 2; it++) {
      let dx = 0;
      let dz = 0;
      for (let c = 0; c < this.latest.length; c++) {
        dx += field(c, 0, px, pz);
        dz += field(c, 2, px, pz);
      }
      px = x - dx;
      pz = z - dz;
    }
    let h = 0;
    for (let c = 0; c < this.latest.length; c++) h += field(c, 1, px, pz);
    return h;
  }

  dispose(): void {
    this.worker?.terminate();
    for (const t of this.tex) {
      t.a.dispose();
      t.b.dispose();
    }
    if (seaUniforms.uSeaDetA0.value === this.tex[0]?.a) seaUniforms.uSeaDetN.value = 0;
  }
}

/**
 * The wind sea for the short waves when a page knows only the total Hs and
 * the wind: the Pierson-Moskowitz sea for that wind (Hs = 0.0246 U^2, Tp about
 * 0.73 U), no bigger than the whole sea, and its period no longer than such a
 * sea's (Tp ~ 4.8 sqrt(Hs), a GUESS fit to young wind seas). Travels with the wind.
 */
export function windSeaFrom(hsTotal: number, windMs: number, towards: THREE.Vector2): WindSea {
  const hs = Math.min(0.0246 * windMs * windMs, Math.max(hsTotal, 0));
  const tp = Math.max(1.2, Math.min(0.73 * windMs, 4.8 * Math.sqrt(Math.max(hs, 0.01))));
  return { hs, tp, direction: Math.atan2(towards.y, towards.x) };
}

/**
 * Short-wave detail for a page's look: Ultra draws High, High draws Medium, Low
 * keeps the old ripples (Maya's frame budget: Low within 15% of before, for
 * laptops). three r170 needs WebGL2, which can always filter half floats.
 */
export function detailFor(look: "low" | "high" | "ultra"): Detail {
  return look === "ultra" ? "high" : look === "high" ? "medium" : "off";
}
