// The wind sea's short waves: an FFT ocean (Tessendorf, "Simulating Ocean
// Water", SIGGRAPH course notes 2001), display only.
//
// The big waves (waves.ts, 0.6-3.5 x the peak frequency) move the boats and
// are drawn by the sea shader. Everything shorter is here: the rest of the same
// JONSWAP wind sea, out to waves a few tens of centimetres long, spread wider
// round the wind the shorter they are. It is computed on the CPU, two square
// patches ("cascades") of different, unrelated sizes, so their repeats never
// line up into a visible tile, and handed to the shader as float textures:
//
//   tex A: sideways x, height, sideways z (m), foam (0..1)
//   tex B: slope d/dx, slope d/dz, Jacobian (below ~0.3 the crest is breaking)
//
// The CPU keeps the same grids, so heightAt() here is the drawn height (Maya:
// the hull's waterline must match the picture). These waves are short against
// any hull we sail, so they don't move the boats; their height is small
// (checked in tests/seafft.test.ts: well under a fifth of Hs).
//
// Foam lives where a crest folds over (the Jacobian of the sideways motion
// drops below a threshold, Tessendorf 2001 sec. 4.4), and decays over a few
// seconds where it isn't topped up, so it breaks up as it fades.

import { G, JONSWAP_GAMMA, jonswapShape } from "./waves";
import { whiteCrests } from "./storm";

/** In-place radix-2 complex FFT of length n (power of two), stride `s` from `off`. sign +1 = inverse (no 1/n). */
function fft1(re: Float32Array, im: Float32Array, n: number, off: number, s: number, sign: number, rev: Uint32Array, tw: Float32Array): void {
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const a = off + i * s;
      const b = off + j * s;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = tw[2 * k * step];
        const wi = sign * tw[2 * k * step + 1];
        const a = off + (start + k) * s;
        const b = a + half * s;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** 2D inverse FFT on an n x n grid (row-major), in place. */
export class FFT2 {
  readonly n: number;
  private rev: Uint32Array;
  private tw: Float32Array;
  constructor(n: number) {
    if (n & (n - 1)) throw new Error("FFT size must be a power of two");
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.tw = new Float32Array(n); // cos, sin of 2 pi k / n for k < n/2
    for (let k = 0; k < n / 2; k++) {
      this.tw[2 * k] = Math.cos((2 * Math.PI * k) / n);
      this.tw[2 * k + 1] = Math.sin((2 * Math.PI * k) / n);
    }
  }
  inverse(re: Float32Array, im: Float32Array): void {
    const n = this.n;
    for (let r = 0; r < n; r++) fft1(re, im, n, r * n, 1, 1, this.rev, this.tw);
    for (let c = 0; c < n; c++) fft1(re, im, n, c, n, 1, this.rev, this.tw);
  }
}

/** Small deterministic random numbers (same sea every run). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The wind sea the short waves continue: its Hs (m), peak period (s) and direction of travel (rad, from +x toward +z). */
export interface WindSea {
  hs: number;
  tp: number;
  direction: number;
}

/** Where the big waves (waves.ts WIND_SEA) stop, as a multiple of the peak frequency. */
export const BIG_WAVES_UP_TO = 3.5;
/** Fold-over threshold for foam when the wind doesn't say otherwise: Jacobian below this is a breaking crest. */
export const FOAM_J = 0.55;
/**
 * Fresh foam is laid on this share of the most-folded water, so the whitecap
 * cover follows the wind (storm.ts whiteCrests(), from Monahan's fit): the decay over
 * FOAM_HALF_LIFE spreads each patch out, so fresh foam is set to about a third
 * of the cover (measured: the cover then lands within ~10 % of whiteCrests()). GUESS display tuning.
 */
export const FRESH_SHARE = 0.3;
/** Foam half-life on the water (s). GUESS: patches last a few seconds (Callaghan et al. 2012 measured 2-10 s). */
export const FOAM_HALF_LIFE = 4;
/** Sideways (choppy) scale: sharper crests, flatter troughs. 1 = Tessendorf's lambda of 1; less keeps it from folding everywhere. */
export const CHOP = 1.15; // peakier crests, rounder troughs (Ines F8 #2); folds feed the foam

/**
 * Directional spreading of the short waves: cos^2s about the wind, with s
 * falling from 10 near the big waves to 2 for waves several times shorter,
 * so short chop runs at all angles and crosses (Mitsuyasu et al. 1975 give s
 * peaking at fp and falling as (f/fp)^-2.5 above it).
 */
export function spreadS(fOverFp: number): number {
  return Math.max(2, 10 * Math.pow(Math.max(fOverFp, 1), -2.5) * Math.pow(BIG_WAVES_UP_TO, 2.5) / 10 * 1.2);
}

/** cos^2s(theta/2) normalised over the circle. */
function spreading(theta: number, s: number): number {
  // normaliser: Gamma(s+1)^2 / (2 pi Gamma(2s+1)) * 2^(2s) ; use a numeric table instead
  return Math.pow(Math.abs(Math.cos(theta / 2)), 2 * s);
}
const spreadNorm = new Map<number, number>();
function spreadingNorm(s: number): number {
  const key = Math.round(s * 100) / 100;
  let v = spreadNorm.get(key);
  if (v === undefined) {
    let sum = 0;
    const m = 720;
    for (let i = 0; i < m; i++) sum += spreading(-Math.PI + ((i + 0.5) * 2 * Math.PI) / m, key);
    v = 1 / ((sum * 2 * Math.PI) / m);
    spreadNorm.set(key, v);
  }
  return v;
}

/** JONSWAP variance density per unit frequency (m^2/Hz) for Hs and Tp: shape normalised so that integral = Hs^2 / 16. */
const shapeIntegral = (() => {
  let s = 0;
  const d = 1e-3;
  for (let r = d / 2; r < 10; r += d) s += jonswapShape(r) * d;
  return s;
})();
export function jonswap(f: number, hs: number, tp: number): number {
  const fp = 1 / tp;
  return ((hs * hs) / 16) * (jonswapShape(f / fp, JONSWAP_GAMMA) / (shapeIntegral * fp));
}

/** One square patch of short waves, size L (m), n x n points. */
export class Cascade {
  readonly n: number;
  readonly size: number;
  /** Wavenumbers this patch carries (rad/m): [kLo, kHi). */
  kLo: number;
  kHi: number;
  private fft: FFT2;
  private h0r: Float32Array;
  private h0i: Float32Array;
  private omega: Float32Array;
  private kx: Float32Array;
  private kz: Float32Array;
  private kk: Float32Array;
  private ra: Float32Array[];
  private ia: Float32Array[];
  /** Output grids (n x n, row = z, column = x). */
  readonly dx: Float32Array;
  readonly h: Float32Array;
  readonly dz: Float32Array;
  readonly sx: Float32Array;
  readonly sz: Float32Array;
  readonly jac: Float32Array;
  readonly foam: Float32Array;
  private noise: { gr: Float32Array; gi: Float32Array };
  private sea: WindSea | null = null;
  private tFoam = -1;

  constructor(n: number, size: number, kLo: number, kHi: number, seed: number) {
    this.n = n;
    this.size = size;
    this.kLo = kLo;
    this.kHi = kHi;
    this.fft = new FFT2(n);
    const nn = n * n;
    this.h0r = new Float32Array(nn);
    this.h0i = new Float32Array(nn);
    this.omega = new Float32Array(nn);
    this.kx = new Float32Array(nn);
    this.kz = new Float32Array(nn);
    this.kk = new Float32Array(nn);
    this.ra = Array.from({ length: 4 }, () => new Float32Array(nn));
    this.ia = Array.from({ length: 4 }, () => new Float32Array(nn));
    this.dx = new Float32Array(nn);
    this.h = new Float32Array(nn);
    this.dz = new Float32Array(nn);
    this.sx = new Float32Array(nn);
    this.sz = new Float32Array(nn);
    this.jac = new Float32Array(nn).fill(1);
    this.foam = new Float32Array(nn);
    // Fixed Gaussian noise per wavevector, so a change of wind reshapes the
    // same sea rather than making a new one.
    const rand = mulberry32(seed);
    const gauss = () => {
      const u = Math.max(rand(), 1e-9);
      const v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    this.noise = { gr: new Float32Array(nn), gi: new Float32Array(nn) };
    for (let i = 0; i < nn; i++) {
      this.noise.gr[i] = gauss();
      this.noise.gi[i] = gauss();
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const kx = (2 * Math.PI * (i < n / 2 ? i : i - n)) / size;
        const kz = (2 * Math.PI * (j < n / 2 ? j : j - n)) / size;
        this.kx[idx] = kx;
        this.kz[idx] = kz;
        this.kk[idx] = Math.hypot(kx, kz);
        this.omega[idx] = Math.sqrt(G * this.kk[idx]);
      }
    }
  }

  /** Set the wind sea this patch continues; only rebuilds the spectrum when it changes noticeably. */
  setSea(sea: WindSea, kCut: number): void {
    const s = this.sea;
    if (s && Math.abs(s.hs - sea.hs) < 0.01 * Math.max(sea.hs, 0.05) && Math.abs(s.tp - sea.tp) < 0.01 * sea.tp && Math.abs(Math.atan2(Math.sin(s.direction - sea.direction), Math.cos(s.direction - sea.direction))) < 0.005)
      return;
    this.sea = { ...sea };
    const n = this.n;
    const dk = (2 * Math.PI) / this.size;
    const fp = 1 / sea.tp;
    for (let idx = 0; idx < n * n; idx++) {
      const k = this.kk[idx];
      // Only this patch's band, and only waves shorter than the big ones (a soft
      // edge at kCut, so the two never double up or leave a gap).
      let w = 0;
      if (k >= this.kLo && k < this.kHi && k > 0) {
        const omega = this.omega[idx];
        const f = omega / (2 * Math.PI);
        const edge = Math.min(1, Math.max(0, (k / kCut - 1) / 0.3)); // 0 below kCut (the big waves have it), 1 above 1.3 kCut
        if (edge > 0) {
          const Sf = jonswap(f, sea.hs, sea.tp); // m^2/Hz
          // S(f) df -> F(k) k dk dtheta: df/dk = g / (4 pi omega); per unit k: S(f) df/dk; per area: / k
          const Fk = (Sf * (G / (4 * Math.PI * omega))) / k;
          const th = Math.atan2(this.kz[idx], this.kx[idx]) - sea.direction;
          const sp = spreadS(f / fp);
          const D = spreading(th, sp) * spreadingNorm(sp);
          const variance = edge * Fk * D * dk * dk; // m^2 in this cell
          w = Math.sqrt(variance / 2);
        }
      }
      this.h0r[idx] = w * this.noise.gr[idx];
      this.h0i[idx] = w * this.noise.gi[idx];
    }
  }

  /** The surface at time t (s); fresh foam where the Jacobian is under `foamJ`. */
  update(t: number, foamJ = FOAM_J): void {
    const n = this.n;
    const nn = n * n;
    const [r0, r1, r2, r3] = this.ra;
    const [i0, i1, i2, i3] = this.ia;
    for (let j = 0; j < n; j++) {
      const jm = (n - j) % n;
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const im = jm * n + ((n - i) % n);
        const wt = this.omega[idx] * t;
        const c = Math.cos(wt);
        const s = Math.sin(wt);
        // h(k,t) = h0(k) e^{i w t} + conj(h0(-k)) e^{-i w t}
        const ar = this.h0r[idx];
        const ai = this.h0i[idx];
        const br = this.h0r[im];
        const bi = -this.h0i[im];
        const hr = (ar + br) * c - (ai - bi) * s;
        const hi = (ar - br) * s + (ai + bi) * c;
        const kx = this.kx[idx];
        const kz = this.kz[idx];
        const k = this.kk[idx];
        const ux = k > 0 ? kx / k : 0;
        const uz = k > 0 ? kz / k : 0;
        // Pack two real fields per complex transform: A + iB.
        // dx = -i ux h ; dz = -i uz h ; sx = i kx h ; sz = i kz h
        // Jxx = ux kx h ; Jzz = uz kz h ; Jxz = ux kz h  (d dx/dx etc., all real-symmetric)
        const dxr = ux * hi, dxi = -ux * hr;
        const dzr = uz * hi, dzi = -uz * hr;
        const sxr = -kx * hi, sxi = kx * hr;
        const szr = -kz * hi, szi = kz * hr;
        const jxxr = ux * kx * hr, jxxi = ux * kx * hi;
        const jzzr = uz * kz * hr, jzzi = uz * kz * hi;
        const jxzr = ux * kz * hr, jxzi = ux * kz * hi;
        // r0 = h + i dx
        r0[idx] = hr - dxi;
        i0[idx] = hi + dxr;
        // r1 = dz + i sx
        r1[idx] = dzr - sxi;
        i1[idx] = dzi + sxr;
        // r2 = sz + i Jxx
        r2[idx] = szr - jxxi;
        i2[idx] = szi + jxxr;
        // r3 = Jzz + i Jxz
        r3[idx] = jzzr - jxzi;
        i3[idx] = jzzi + jxzr;
      }
    }
    for (let q = 0; q < 4; q++) this.fft.inverse(this.ra[q], this.ia[q]);
    const dt = this.tFoam < 0 ? 0 : Math.max(0, t - this.tFoam);
    this.tFoam = t;
    const decay = Math.pow(0.5, dt / FOAM_HALF_LIFE);
    for (let idx = 0; idx < nn; idx++) {
      // the grid's sign pattern: index (i, j) of the inverse transform of a
      // centred spectrum needs no shift here (k laid out in FFT order)
      this.h[idx] = r0[idx];
      this.dx[idx] = CHOP * i0[idx];
      this.dz[idx] = CHOP * r1[idx];
      this.sx[idx] = i1[idx];
      this.sz[idx] = r2[idx];
      const jxx = CHOP * i2[idx];
      const jzz = CHOP * r3[idx];
      const jxz = CHOP * i3[idx];
      const J = (1 + jxx) * (1 + jzz) - jxz * jxz;
      this.jac[idx] = J;
      const fresh = J < foamJ ? Math.min(1, 0.4 + (foamJ - J) / 0.15) : 0;
      this.foam[idx] = Math.max(this.foam[idx] * decay, fresh);
    }
  }

  /** The Jacobian below which a share q of this patch lies (0 when q is 0: no foam). */
  jacobianQuantile(q: number): number {
    if (q <= 0) return -Infinity;
    const step = Math.max(1, Math.floor(this.jac.length / 2048));
    const xs: number[] = [];
    for (let i = 0; i < this.jac.length; i += step) xs.push(this.jac[i]);
    xs.sort((a, b) => a - b);
    return xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  }

  /** Bilinear sample of a grid at world (x, z) (m); the patch repeats. */
  sample(grid: Float32Array, x: number, z: number): number {
    const n = this.n;
    const u = (x / this.size) * n;
    const v = (z / this.size) * n;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const fu = u - i0;
    const fv = v - j0;
    const w = (i: number, j: number) => grid[(((j % n) + n) % n) * n + (((i % n) + n) % n)];
    return (w(i0, j0) * (1 - fu) + w(i0 + 1, j0) * fu) * (1 - fv) + (w(i0, j0 + 1) * (1 - fu) + w(i0 + 1, j0 + 1) * fu) * fv;
  }

  /** Root-mean-square height of the patch now (m). */
  rms(): number {
    let s = 0;
    for (const v of this.h) s += v * v;
    return Math.sqrt(s / this.h.length);
  }
}

/** Quality ladder for the short waves. */
export type SeaDetail = "low" | "medium" | "high";
export const DETAIL: Record<SeaDetail, { n: number; cascades: number; moves: boolean }> = {
  low: { n: 64, cascades: 1, moves: false }, // shading only
  medium: { n: 64, cascades: 2, moves: true },
  high: { n: 128, cascades: 2, moves: true },
};
/** Patch sizes (m): unrelated lengths so the repeats never line up (ratio ~ 5.6, not a simple fraction). */
export const PATCH = [31.7, 177.3];

/**
 * The short-wave sea: one or two cascades over the wind sea's tail, split at a
 * wavenumber so each wave length lives in exactly one patch.
 */
export class ShortWaves {
  readonly detail: SeaDetail;
  readonly cascades: Cascade[];
  private kCut = 1;

  constructor(detail: SeaDetail) {
    this.detail = detail;
    const d = DETAIL[detail];
    if (d.cascades === 1) {
      // One patch carries everything from ~20 m down to its Nyquist.
      this.cascades = [new Cascade(d.n, PATCH[0], (2 * Math.PI) / PATCH[0], Infinity, 11)];
    } else {
      // Large patch: 177 m down to ~ 4 texels of the small one; small patch: the rest.
      const kSplit = (2 * Math.PI) / (PATCH[0] / 4);
      this.cascades = [
        new Cascade(d.n, PATCH[1], (2 * Math.PI) / PATCH[1], kSplit, 12),
        new Cascade(d.n, PATCH[0], kSplit, Infinity, 11),
      ];
    }
  }

  private wind = 0;
  /** The wind sea now, and the wind (m/s); the short tail starts where the big waves stop. */
  setSea(sea: WindSea, windMs = Math.sqrt(sea.hs / 0.0246)): void {
    this.wind = windMs;
    const fCut = BIG_WAVES_UP_TO / Math.max(sea.tp, 0.5);
    const omega = 2 * Math.PI * fCut;
    this.kCut = (omega * omega) / G;
    for (const c of this.cascades) c.setSea(sea, this.kCut);
  }

  /**
   * Move on to time t (s). The patch moves with the water: `origin` is how far
   * the boat has gone through it (seaSurface.ts), so the waves flow past.
   */
  update(t: number): void {
    const q = FRESH_SHARE * whiteCrests(this.wind);
    // The threshold is last frame's quantile: the sea changes little in a frame.
    for (const c of this.cascades) c.update(t, q > 1e-4 ? Math.min(FOAM_J + 0.3, c.jacobianQuantile(q)) : -Infinity);
  }

  /** Share of the water under foam now (0..1), over all patches. */
  foamCover(): number {
    let s = 0;
    let n = 0;
    for (const c of this.cascades) for (const f of c.foam) { s += f > 0.5 ? 1 : 0; n++; }
    return n ? s / n : 0;
  }

  /** Height of the short waves at a fixed sea point (m), sideways motion undone by fixed-point steps. */
  heightAt(x: number, z: number): number {
    let px = x;
    let pz = z;
    for (let it = 0; it < 3; it++) {
      let dx = 0;
      let dz = 0;
      for (const c of this.cascades) {
        dx += c.sample(c.dx, px, pz);
        dz += c.sample(c.dz, px, pz);
      }
      px = x - dx;
      pz = z - dz;
    }
    let h = 0;
    for (const c of this.cascades) h += c.sample(c.h, px, pz);
    return h;
  }

  /** Significant height of the short waves alone (m): 4 x rms. */
  hs(): number {
    return 4 * Math.sqrt(this.cascades.reduce((s, c) => s + c.rms() ** 2, 0));
  }
}

/** Float to IEEE half (for float textures without linear filtering). */
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  const m = x & 0x7fffff;
  if (e <= 0) return sign; // tiny: zero
  if (e >= 31) return sign | 0x7bff; // clamp to the largest half
  return sign | (e << 10) | (m >>> 13);
}
export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** One patch packed for the shader: a = (dx, h, dz, foam), b = (slope x, slope z, Jacobian, 0), RGBA per point. */
export interface Packed {
  a: Float32Array | Uint16Array;
  b: Float32Array | Uint16Array;
}
export function packCascade(c: Cascade, half: boolean, spare: ArrayBuffer[] = []): Packed {
  const nn = c.n * c.n;
  const bytes = nn * 4 * (half ? 2 : 4);
  const take = () => {
    const i = spare.findIndex((b) => b.byteLength === bytes);
    const buf = i >= 0 ? spare.splice(i, 1)[0] : new ArrayBuffer(bytes);
    return half ? new Uint16Array(buf) : new Float32Array(buf);
  };
  const a = take();
  const b = take();
  const put = half ? toHalf : (v: number) => v;
  for (let i = 0; i < nn; i++) {
    a[4 * i] = put(c.dx[i]);
    a[4 * i + 1] = put(c.h[i]);
    a[4 * i + 2] = put(c.dz[i]);
    a[4 * i + 3] = put(c.foam[i]);
    b[4 * i] = put(c.sx[i]);
    b[4 * i + 1] = put(c.sz[i]);
    b[4 * i + 2] = put(c.jac[i]);
    b[4 * i + 3] = 0;
  }
  return { a, b };
}
