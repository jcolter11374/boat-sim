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

function slowLink(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !!c && (c.saveData === true || /2g/.test(c.effectiveType ?? ""));
}

let started = false;

/** Start warming the helm's files once the page is idle. Safe to call more than once. */
export function prefetchHelm(sandboxBase: string): void {
  if (started || typeof window === "undefined" || slowLink()) return;
  started = true;
  const go = async () => {
    for (const f of ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip"]) await drain(await warmOne(PYODIDE_DIR + f));
    const lockR = await warmOne(`${PYODIDE_DIR}pyodide-lock.json`);
    const lock = lockR ? ((await lockR.json().catch(() => null)) as Lock | null) : null;
    for (const f of lock ? wheelFiles(lock, HELM_PACKAGES) : []) await drain(await warmOne(PYODIDE_DIR + f));
    if (!(await sandboxThere(sandboxBase))) return;
    for (const f of ["boatsim.zip", "forcing_2020.npz"]) await drain(await warmOne(new URL(f, sandboxBase).href));
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const kick = () => void go();
  // After the sea's first frames: wait for load, then an idle moment (or 3 s at most).
  const later = () => (idle ? idle(kick, { timeout: 3000 }) : setTimeout(kick, 1500));
  if (document.readyState === "complete") later();
  else addEventListener("load", later, { once: true });
}
