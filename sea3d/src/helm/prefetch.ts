// Fetch the helm's simulator into the browser cache while the title screen shows
// (Leo's first-five-minutes audit, F2): Python (Pyodide and the two packages the
// simulator needs), boatsim.zip and the 2020 weather. helm.html's worker then finds
// them all cached, so Set sail is a few seconds, not a long download. Idle priority,
// one file at a time, and skipped on Save-Data or a 2G link; a failure here costs
// nothing, because the helm fetches whatever is missing as before.

import { sandboxThere } from "../sandbox";

export const PYODIDE_DIR = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
/** The Python packages the helm's worker loads (helm/worker.ts). */
export const HELM_PACKAGES = ["numpy", "pyyaml"];

type Lock = { packages?: Record<string, { file_name?: string; depends?: string[] }> };

/** The wheel files for `names` and everything they depend on, from pyodide-lock.json. */
export function wheelFiles(lock: Lock, names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (n: string) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const p = lock.packages?.[key];
    if (!p) return;
    for (const d of p.depends ?? []) add(d);
    if (p.file_name) out.push(p.file_name);
  };
  names.forEach(add);
  return out;
}

/** Read a file to the end at low priority so it lands in the HTTP cache; the bytes are dropped. */
async function warmOne(url: string): Promise<Response | null> {
  try {
    const r = await fetch(url, { priority: "low" } as RequestInit);
    if (!r.ok) return null;
    return r;
  } catch {
    return null;
  }
}

async function drain(r: Response | null): Promise<void> {
  const reader = r?.body?.getReader();
  if (!reader) return;
  try {
    for (;;) if ((await reader.read()).done) return;
  } catch {
    /* a cut-off download: the helm fetches it again */
  }
}

/** What the browser says about the link (Chrome and Android only; Safari and Firefox say nothing). */
export type Link = { saveData?: boolean; effectiveType?: string; type?: string } | undefined;

/** Whether this link may be spent on a download the visitor hasn't asked for: not with
 *  Save-Data on, not on a 2G or 3G link, not on mobile data. An unknown link may. */
export function mayPrefetch(c: Link): boolean {
  if (!c) return true;
  return !(c.saveData === true || /(^|-)2g|3g/.test(c.effectiveType ?? "") || c.type === "cellular");
}

function slowLink(): boolean {
  return !mayPrefetch((navigator as Navigator & { connection?: Link }).connection);
}

/** The months of the 2020 weather a game reads first: the usual launch is 23 April, and a
 *  call asks for the week after its last step (sandbox/helm.py COVER_AHEAD), which reaches May. */
export const FIRST_WEATHER = ["2020-04", "2020-05"];

/** The weather files to warm: of a split season (forcing_2020_parts.json), the static file and
 *  the first months; without the list, the whole season. */
export function weatherFiles(list: { static: string; parts: { key: string; file: string }[] } | null): string[] {
  if (!list?.static || !Array.isArray(list.parts)) return ["forcing_2020.npz"];
  return [list.static, ...list.parts.filter((p) => FIRST_WEATHER.includes(p.key)).map((p) => p.file)];
}

let started = false;
let kicked = false;

/** Start warming the helm's files once the page is idle, or at once with `now` (the visitor
 *  has shown they mean to sail; that also cuts short a wait for idle already begun). Safe to
 *  call more than once. */
export function prefetchHelm(sandboxBase: string, now = false): void {
  if (typeof window === "undefined" || slowLink()) return;
  const go = async () => {
    for (const f of ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip"]) await drain(await warmOne(PYODIDE_DIR + f));
    const lockR = await warmOne(`${PYODIDE_DIR}pyodide-lock.json`);
    const lock = lockR ? ((await lockR.json().catch(() => null)) as Lock | null) : null;
    for (const f of lock ? wheelFiles(lock, HELM_PACKAGES) : []) await drain(await warmOne(PYODIDE_DIR + f));
    if (!(await sandboxThere(sandboxBase))) return;
    await drain(await warmOne(new URL("boatsim.zip", sandboxBase).href));
    // The weather: split by month, the list, the static file and the months the usual launch
    // reads first; on a site without the split files, the whole season as before.
    const listR = await warmOne(new URL("forcing_2020_parts.json", sandboxBase).href);
    const list = listR?.ok ? ((await listR.json().catch(() => null)) as { static: string; parts: { key: string; file: string }[] } | null) : null;
    for (const f of weatherFiles(list)) await drain(await warmOne(new URL(f, sandboxBase).href));
  };
  const kick = () => {
    if (kicked) return;
    kicked = true;
    void go();
  };
  if (now) return kick();
  if (started) return;
  started = true;
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  // After the sea's first frames: wait for load, then an idle moment (or 3 s at most).
  const later = () => (idle ? idle(kick, { timeout: 3000 }) : setTimeout(kick, 1500));
  if (document.readyState === "complete") later();
  else addEventListener("load", later, { once: true });
}

/** How long a desktop visitor may sit on the title before the simulator is fetched anyway (ms). */
export const IDLE_PREFETCH_MS = 8000;

/** The title's way of warming the helm (Omar's speed baseline, 14 Nov: fetched on every title
 *  visit it was 31 MB whether or not the visitor ever sailed). It starts at the first sign the
 *  visitor means to sail: the pointer or the keyboard's focus on Set sail or Continue, a touch
 *  or click anywhere on the title's card, or, on a desktop (a mouse, not a touch screen), eight
 *  seconds on the title. Never on Save-Data, a 2G or 3G link, or mobile data (prefetchHelm).
 *  `sure` are the links that go sailing; `card` is the whole title card. */
export function prefetchHelmOnIntent(sandboxBase: string, sure: (Element | null)[], card: Element | null, desktop = matchMedia("(hover: hover) and (pointer: fine)").matches): void {
  if (typeof window === "undefined" || slowLink()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const go = (e?: Event) => {
    if (timer !== undefined) clearTimeout(timer);
    prefetchHelm(sandboxBase, !!e); // a sign of intent: at once; the idle timer: when the page is idle
  };
  const once = { once: true, passive: true } as const;
  for (const el of sure) for (const ev of ["pointerenter", "focus"]) el?.addEventListener(ev, go, once);
  for (const ev of ["pointerdown", "keydown"]) card?.addEventListener(ev, go, once);
  if (desktop) timer = setTimeout(() => go(), IDLE_PREFETCH_MS);
}
