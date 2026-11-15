// ?perf on any page: a frame recorder for finding freezes on a computer we can't run (John, 15 Nov:
// on his graphics card the title "seizes and then snaps back into another frame"). Off without
// ?perf, and then it does nothing at all.
//
// It records every frame's gap, and for each freeze (a frame over 50 ms) what happened in it:
//   - the graphics work the page did on this thread: shader programs built, and the waits for a
//     shader's answer; textures and buffers uploaded (bytes and ms); reads that wait for the
//     graphics card (readPixels, getError and the like),
//   - the browser's own account of the long frame (Chrome's long-animation-frame entries: which
//     scripts ran and for how long, and how much of the frame was spent outside scripts),
//   - files that finished downloading just before it.
// A small box in the corner counts the freezes; "Copy report" puts the whole report on the
// clipboard (and in a text box, if the clipboard is refused), to paste into the chat.

type Gl = { programs: number; linkMs: number; waits: number; waitMs: number; upBytes: number; upMs: number; ups: number; syncs: number; syncMs: number };
const zero = (): Gl => ({ programs: 0, linkMs: 0, waits: 0, waitMs: 0, upBytes: 0, upMs: 0, ups: 0, syncs: 0, syncMs: 0 });

interface Stall {
  /** When the freeze ended, ms since the page started. */
  at: number;
  /** The frame's gap (ms). */
  ms: number;
  gl: Gl;
  /** Chrome's long-animation-frame entries overlapping it: scripts and the rest. */
  loaf: { ms: number; blockingMs: number; scriptsMs: number; renderMs: number; scripts: string[] }[];
  /** Downloads finished in the second before it. */
  loaded: string[];
}

const on = typeof location !== "undefined" && new URLSearchParams(location.search).has("perf");

const round = (x: number) => Math.round(x * 10) / 10;
const short = (u: string) => {
  try {
    const p = new URL(u, location.href);
    return p.origin === location.origin ? p.pathname.split("/").slice(-2).join("/") : `${p.host}/…/${p.pathname.split("/").pop()}`;
  } catch {
    return u.slice(0, 80);
  }
};

function start(): void {
  const t0 = performance.now();
  const gaps: number[] = [];
  const stalls: Stall[] = [];
  const loafs: { start: number; end: number; v: Stall["loaf"][number] }[] = [];
  let gl = zero();
  const total = zero();

  // ---- graphics calls on this thread ----
  const wrap = (proto: object, name: string, count: (ms: number, args: unknown[]) => void): void => {
    const p = proto as Record<string, (...a: unknown[]) => unknown>;
    const orig = p[name];
    if (typeof orig !== "function") return;
    p[name] = function (this: unknown, ...a: unknown[]) {
      const s = performance.now();
      const r = orig.apply(this, a);
      count(performance.now() - s, a);
      return r;
    };
  };
  const bytesOf = (a: unknown[]): number => {
    for (const x of a) {
      if (ArrayBuffer.isView(x)) return x.byteLength;
      if (x && typeof x === "object" && "width" in x && "height" in x) return 4 * Number((x as { width: number }).width) * Number((x as { height: number }).height);
    }
    return 0;
  };
  for (const C of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) {
    if (!C) continue;
    const P = C.prototype;
    wrap(P, "linkProgram", (ms) => {
      gl.programs++;
      gl.linkMs += ms;
    });
    // three asks each new program whether it linked: without parallel compile that waits for the build.
    for (const n of ["getProgramParameter", "getShaderParameter", "getProgramInfoLog", "getShaderInfoLog"])
      wrap(P, n, (ms) => {
        if (ms < 1) return;
        gl.waits++;
        gl.waitMs += ms;
      });
    for (const n of ["texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D", "compressedTexImage2D", "texStorage2D", "bufferData", "bufferSubData"])
      wrap(P, n, (ms, a) => {
        gl.ups++;
        gl.upMs += ms;
        gl.upBytes += bytesOf(a);
      });
    for (const n of ["readPixels", "getError", "finish", "clientWaitSync", "getBufferSubData"])
      wrap(P, n, (ms) => {
        if (ms < 1) return;
        gl.syncs++;
        gl.syncMs += ms;
      });
  }

  // ---- the browser's account of long frames (Chrome 123 and up) ----
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as {
        startTime: number;
        duration: number;
        blockingDuration?: number;
        renderStart?: number;
        scripts?: { duration: number; sourceURL?: string; sourceFunctionName?: string; invoker?: string; invokerType?: string }[];
      }[]) {
        const scripts = (e.scripts ?? []).filter((s) => s.duration >= 5).sort((a, b) => b.duration - a.duration);
        const scriptsMs = scripts.reduce((a, s) => a + s.duration, 0);
        loafs.push({
          start: e.startTime,
          end: e.startTime + e.duration,
          v: {
            ms: round(e.duration),
            blockingMs: round(e.blockingDuration ?? 0),
            scriptsMs: round(scriptsMs),
            renderMs: e.renderStart ? round(e.startTime + e.duration - e.renderStart) : 0,
            scripts: scripts.slice(0, 5).map((s) => `${round(s.duration)} ms ${s.invokerType ?? ""} ${s.invoker ?? ""} ${s.sourceFunctionName ?? ""} ${short(s.sourceURL ?? "")}`.replace(/\s+/g, " ").trim()),
          },
        });
        if (loafs.length > 400) loafs.splice(0, 200);
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {
    /* not Chrome: the frame gaps and graphics counts still tell a lot */
  }

  // ---- frames ----
  let last = NaN;
  const tick = (now: number) => {
    if (Number.isFinite(last)) {
      const ms = now - last;
      gaps.push(ms);
      if (gaps.length > 20000) gaps.splice(0, 10000);
      for (const k of Object.keys(total) as (keyof Gl)[]) total[k] += gl[k];
      if (ms > 50 && !document.hidden) {
        const from = last - 5;
        const recent = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((r) => r.responseEnd > now - 1000 && r.responseEnd <= now);
        stalls.push({
          at: Math.round(now - t0),
          ms: round(ms),
          gl: Object.fromEntries(Object.entries(gl).map(([k, v]) => [k, round(v)])) as Gl,
          loaf: [],
          loaded: recent.slice(-6).map((r) => `${short(r.name)} (${Math.round(r.transferSize / 1024)} kB)`),
        });
        const s = stalls[stalls.length - 1];
        // The long-animation-frame entry arrives a little later: attach it then.
        setTimeout(() => (s.loaf = loafs.filter((l) => l.end > from && l.start < now + 5).map((l) => l.v)), 500);
        if (stalls.length > 300) stalls.splice(0, 100);
      }
    }
    last = now;
    gl = zero();
    box?.update();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // ---- the report ----
  const report = () => {
    const s = [...gaps].sort((a, b) => a - b);
    const q = (p: number) => round(s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? NaN);
    let gpu = "?";
    let parallel = false;
    try {
      const c = document.createElement("canvas").getContext("webgl2");
      const d = c?.getExtension("WEBGL_debug_renderer_info");
      gpu = d && c ? String(c.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "?";
      parallel = !!c?.getExtension("KHR_parallel_shader_compile");
      c?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      /* no WebGL2 */
    }
    const w = window as unknown as Record<string, { quality?: unknown; look?: unknown } | undefined>;
    return {
      page: location.pathname + location.search,
      secs: Math.round((performance.now() - t0) / 1000),
      browser: navigator.userAgent,
      gpu,
      parallelCompile: parallel,
      screen: `${innerWidth}x${innerHeight} @${devicePixelRatio}`,
      quality: w.__sea3d?.quality ?? w.__helm?.quality ?? w.__replay?.look ?? "?",
      frames: gaps.length,
      frameMs: { median: q(0.5), p90: q(0.9), p99: q(0.99), worst: round(s[s.length - 1] ?? NaN) },
      over50ms: gaps.filter((g) => g > 50).length,
      over100ms: gaps.filter((g) => g > 100).length,
      over250ms: gaps.filter((g) => g > 250).length,
      graphicsAll: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, round(v)])),
      worst: [...stalls].sort((a, b) => b.ms - a.ms).slice(0, 15),
      recent: stalls.slice(-15),
    };
  };
  (window as unknown as { __perf: unknown }).__perf = { report, stalls, gaps };

  // ---- the box ----
  let box: { update(): void } | null = null;
  const mount = () => {
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99999;font:12px/1.4 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.72);padding:6px 8px;border-radius:6px;max-width:320px";
    const line = document.createElement("div");
    const btn = document.createElement("button");
    btn.textContent = "Copy report";
    btn.style.cssText = "margin-top:4px;font:inherit;cursor:pointer";
    const out = document.createElement("textarea");
    out.style.cssText = "display:none;width:300px;height:120px;margin-top:4px;font:11px monospace";
    btn.onclick = async () => {
      const text = JSON.stringify(report(), null, 1);
      console.log("PERF REPORT", text);
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied: paste it in the chat";
      } catch {
        out.style.display = "block";
        out.value = text;
        out.select();
        btn.textContent = "Select all in the box and copy";
      }
    };
    el.append(line, btn, out);
    document.body.append(el);
    let shownAt = 0;
    box = {
      update() {
        const now = performance.now();
        if (now - shownAt < 500) return;
        shownAt = now;
        const recent = gaps.slice(-120).sort((a, b) => a - b);
        const med = recent[recent.length >> 1] ?? 0;
        const worst = stalls.reduce((a, s) => Math.max(a, s.ms), 0);
        line.textContent = `${med ? Math.round(1000 / med) : "?"} fps · freezes over 50 ms: ${stalls.length} · worst ${Math.round(worst)} ms`;
      },
    };
  };
  if (document.body) mount();
  else addEventListener("DOMContentLoaded", mount, { once: true });
}

if (on) start();

export {};
