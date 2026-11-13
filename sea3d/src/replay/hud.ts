// Watch a voyage on the helm's system (Leo's delta, approved by Elena, 12 Nov): the replay drawer,
// the corner map that opens big with the log, the keys list, H for the bare world, the top bar
// that slides away, toasts at top centre, and the equipment as small icons.
// The page (voyage.ts) owns the replay; this owns what opens and closes.

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export interface VoyageHudHooks {
  /** The map changed size: the chart redraws at the new size. */
  mapResized(): void;
  /** L: look up at the sky. */
  lookUp(): void;
}

/** Toasts: at most two on screen; a warning stays longer than news. */
const MAX_TOASTS = 2;
const TOAST_MS = 6000;
const WARN_MS = 10000;
/** The drawer, open on first load, slides shut after this long of play (or at the first press of play). */
export const DRAWER_MS = 10000;

export class VoyageHud {
  private drawerTimer = 0;
  private bareTimer = 0;
  private peekTimer = 0;
  private pinned = false;

  constructor(private readonly hooks: VoyageHudHooks) {
    document.body.classList.add("no-bar-anim", "immersive", "drawer-open");
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("no-bar-anim")));
    $("replay-tab").addEventListener("click", () => {
      this.pin();
      this.drawer(true);
    });
    $("top-x").addEventListener("click", () => this.drawer(false));
    // Reaching into the drawer means you're using it: the timer mustn't slide it away under you.
    $("top").addEventListener("pointerenter", () => this.pin());
    $("top").addEventListener("focusin", () => this.pin());
    $("chart").addEventListener("click", () => {
      if (!this.isBig()) this.map(true);
    });
    $("map-x").addEventListener("click", () => this.map(false));
    $("mapbtn").addEventListener("click", () => this.map(true));
    $("hidebtn").addEventListener("click", (e) => {
      (e.currentTarget as HTMLElement).blur();
      this.bare(true);
    });
    $("keysbtn").addEventListener("click", () => this.keys());
    $("credbtn").addEventListener("click", () => {
      const t = $("credtext");
      t.hidden = !t.hidden;
      $("credbtn").setAttribute("aria-expanded", String(!t.hidden));
    });
    // A click on the sea closes the drawer, the keys and bare mode; a drag to turn the camera doesn't.
    let down: [number, number] | null = null;
    const app = $("app");
    app.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
    app.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) {
        if (this.isDrawerOpen()) this.drawer(false);
        if (!$("keylist").hidden) this.keys(false);
        if (document.body.classList.contains("bare")) this.bare(false);
      }
      down = null;
    });
    // The site's bar slides away; the mouse at the very top brings it back.
    addEventListener("pointermove", (e) => {
      const top = $("topbar");
      const near = e.clientY < 8 || (!!top && document.body.classList.contains("peek") && top.contains(e.target as Node));
      if (near) {
        clearTimeout(this.peekTimer);
        document.body.classList.add("peek");
      } else if (document.body.classList.contains("peek") && e.clientY > 60) {
        clearTimeout(this.peekTimer);
        this.peekTimer = window.setTimeout(() => document.body.classList.remove("peek"), 400);
      }
    });
  }

  isDrawerOpen(): boolean {
    return $("top").classList.contains("open");
  }

  drawer(open = !this.isDrawerOpen()): void {
    $("top").classList.toggle("open", open);
    document.body.classList.toggle("drawer-open", open);
    $("replay-tab").setAttribute("aria-expanded", String(open));
    clearTimeout(this.drawerTimer);
    if (!open) this.pinned = false;
  }

  /** Opened or used by hand: it stays until closed. */
  private pin(): void {
    this.pinned = true;
    clearTimeout(this.drawerTimer);
  }

  /** Play has started: the drawer slides shut after DRAWER_MS unless someone is using it. `now` shuts it at once (a press of play). */
  played(now: boolean): void {
    if (!this.isDrawerOpen() || this.pinned) return;
    if (now) {
      if (!$("top").matches(":hover, :focus-within")) this.drawer(false);
      return;
    }
    clearTimeout(this.drawerTimer);
    this.drawerTimer = window.setTimeout(() => {
      if (!this.pinned && !$("top").matches(":hover, :focus-within")) this.drawer(false);
    }, DRAWER_MS);
  }

  isBig(): boolean {
    return $("mapbox").classList.contains("big");
  }

  map(big = !this.isBig()): void {
    $("mapbox").classList.toggle("big", big);
    document.body.classList.toggle("map-big", big);
    this.hooks.mapResized();
  }

  keys(open = $("keylist").hidden): void {
    $("keylist").hidden = !open;
    $("keysbtn").setAttribute("aria-expanded", String(open));
  }

  bare(on = !document.body.classList.contains("bare")): void {
    document.body.classList.toggle("bare", on);
    const tip = $("baretip");
    clearTimeout(this.bareTimer);
    tip.hidden = !on;
    tip.classList.remove("gone");
    if (on) this.bareTimer = window.setTimeout(() => tip.classList.add("gone"), 2000);
  }

  /** Esc: close the most recent thing that's open. True when it closed something. */
  escape(): boolean {
    if (document.body.classList.contains("bare")) this.bare(false);
    else if (!$("keylist").hidden) this.keys(false);
    else if (this.isBig()) this.map(false);
    else if (this.isDrawerOpen()) this.drawer(false);
    else return false;
    return true;
  }

  /** The page's keys; true when handled. */
  key(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") && e.key !== "Escape") return false;
    switch (e.code) {
      case "KeyR":
        if (!this.isDrawerOpen()) this.pin();
        this.drawer();
        return true;
      case "KeyM":
        this.map();
        return true;
      case "KeyH":
        this.bare();
        return true;
      case "KeyL":
        this.hooks.lookUp();
        return true;
      case "Escape":
        return this.escape();
    }
    if (e.key === "?") {
      this.keys();
      return true;
    }
    return false;
  }

  /** A toast at top centre: `when` above the words, a coloured edge. */
  toast(text: string, when: string, colour: string, warn = false): void {
    const box = $("toasts");
    const t = document.createElement("div");
    t.className = "toast";
    t.style.setProperty("--c", colour);
    const b = document.createElement("b");
    b.textContent = when;
    t.append(b, document.createTextNode(text));
    box.prepend(t);
    while (box.children.length > MAX_TOASTS) box.lastChild!.remove();
    window.setTimeout(() => {
      t.classList.add("out");
      window.setTimeout(() => t.remove(), 700);
    }, warn ? WARN_MS : TOAST_MS);
  }
}

// ---------- equipment icons ----------
/** Small line icons (24 px grid, drawn with the cell's colour). Constant markup only. */
const ICON: Record<string, string> = {
  motor: '<circle cx="12" cy="12" r="2.2"/><path d="M12 9.8C11 6 12 3 14.5 3S17 7 13.6 10.4M14 13.4c3.6 1.4 6 3.4 4.8 5.6s-5-.6-6.2-4.6M10 13c-2.8 2.4-5.6 3.6-6.8 1.4S5.6 10.4 9.8 11"/>',
  rudder: '<path d="M12 2.5v6.5"/><path d="M8.5 9h7l-1.6 11.5h-3.8z"/>',
  computer: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/><path d="M10 3v3.5M14 3v3.5M10 17.5V21M14 17.5V21M3 10h3.5M3 14h3.5M17.5 10H21M17.5 14H21"/>',
  backup: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/><path d="M10 3v3.5M14 3v3.5M10 17.5V21M14 17.5V21M3 10h3.5M3 14h3.5M17.5 10H21M17.5 14H21M12 9.5v5M9.5 12h5"/>',
  radio: '<path d="M4.5 19.5a8.5 8.5 0 0 1 0-12l12 12a8.5 8.5 0 0 1-12 0z"/><path d="M10.5 13.5l4-4M15 4.5a4.5 4.5 0 0 1 4.5 4.5M15 1.5a7.5 7.5 0 0 1 7.5 7.5"/>',
  beacon: '<path d="M12 21s-5.5-5.6-5.5-9.5a5.5 5.5 0 0 1 11 0C17.5 15.4 12 21 12 21z"/><circle cx="12" cy="11.5" r="2"/>',
  hull: '<path d="M2.5 11.5h19l-3.2 7H5.7z"/><path d="M12 3c-1.6 2.2-2.2 3.3-2.2 4.3a2.2 2.2 0 0 0 4.4 0c0-1-.6-2.1-2.2-4.3z"/>',
  snag: '<path d="M3 15c3-5 6 3 9-2s6-6 9-2"/><path d="M5 9c3-5 6 3 9-2"/><circle cx="17.5" cy="16.5" r="2.5"/>',
  sail: '<path d="M11 2.5v16M11 4l7.5 13H11"/><path d="M3.5 20.5h17l-1.5-2.5H5z"/>',
};
/** Which icon each part of the replay (and of the live tracker) shows. */
export const PART_ICON: Record<string, string> = {
  thruster_port: "motor",
  thruster_starboard: "motor",
  rudder: "rudder",
  electronics_main: "computer",
  electronics_safe: "backup",
  comms: "radio",
  beacon: "beacon",
  leak: "hull",
  entangled: "snag",
  sail: "sail",
};

export interface Part {
  key: string;
  name: string;
  bad: boolean;
}

let shownKey = "";
const wasBad = new Set<string>();

/**
 * Draw the equipment icons. Returns the parts that have just broken (were working at the last call),
 * so the page can make a moment of it; `quiet` (a jump in time, a new voyage) breaks nothing new.
 * `opensLog`: the cell is a button that opens the log (Watch a voyage), so its hint says so.
 */
export function equipmentIcons(parts: Part[], quiet = false, note = "", opensLog = true): Part[] {
  const box = $("eq");
  const key = parts.map((p) => `${p.key}:${p.name}:${p.bad ? 1 : 0}`).join("|") + note;
  const fresh = quiet ? [] : parts.filter((p) => p.bad && !wasBad.has(p.key));
  wasBad.clear();
  for (const p of parts) if (p.bad) wasBad.add(p.key);
  if (key === shownKey) return fresh;
  shownKey = key;
  box.replaceChildren(
    ...parts.map((p) => {
      const s = document.createElement("span");
      s.className = `part${p.bad ? " bad" : ""}`;
      s.dataset.part = p.key;
      s.title = p.bad ? `${p.name}: not working` : p.name;
      s.setAttribute("role", "img");
      s.setAttribute("aria-label", s.title);
      s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[PART_ICON[p.key] ?? "computer"]}</svg>`; // constant markup only
      return s;
    }),
  );
  for (const p of fresh) box.querySelector(`[data-part="${p.key}"]`)?.classList.add("pulse");
  // A red dot with the count of broken parts on the cell, so one red glyph among nine isn't missed (Elena).
  const bad = parts.filter((p) => p.bad);
  const cell = box.parentElement;
  const lab = box.nextElementSibling as HTMLElement | null;
  if (lab) {
    if (bad.length) lab.dataset.bad = String(bad.length);
    else delete lab.dataset.bad;
  }
  if (cell) {
    // The helm's cell opens nothing (opensLog false): its breakdowns are in the notes.
    cell.title = bad.length ? `Not working: ${bad.map((p) => p.name).join(", ")}.${opensLog ? " Click for the log." : ""}` : `Equipment: hover an icon for its name${opensLog ? ", click for the log" : ""}`;
  }
  const l = box.nextElementSibling;
  if (l) l.textContent = note || "equipment";
  return fresh;
}
