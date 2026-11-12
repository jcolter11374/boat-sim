// The helm's sailing screen (Leo's layout plan, approved by Elena, 12 Nov 2026; Jonas).
// The world gets the screen. What's on it: one instrument strip at the bottom, the orders
// in a drawer on the left, a corner map, toasts at the top. Everything else is a key away:
//   O orders · F forecast · M map · C cinematic · N sound · H hide everything · ? keys · Esc close
// The same key never means two things: at the wheel (Rosa's keys: arrows/WASD, R, T, V, Esc)
// none of these letters is taken.
// This file only shows and hides things; the game (src/helm.ts) says what's in them.

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** How long a toast stays, ms: an event 6 s, a breakdown or a warning 10 s (Leo's plan, item 6). */
export const TOAST_MS = { info: 6000, warn: 10000 };
/** At most this many toasts at once; older ones leave early. */
export const MAX_TOASTS = 2;
/** The coach line in the open drawer for the first seconds after Set sail. */
export const COACH_MS = 10000;

export interface HudHooks {
  /** The map changed size: redraw it. */
  mapResized(): void;
  /** The forecast band opened: draw it (a hidden canvas has no size). */
  forecastOpened(): void;
  /** Keys can't be used just now (start card, results, a busy simulator). */
  keysOff(): boolean;
}

export class Hud {
  private toastTimers = new Map<HTMLElement, number>();
  private fcAuto = false;
  private coachTimer = 0;
  private bareTimer = 0;
  private peekTimer = 0;

  constructor(private readonly hooks: HudHooks) {
    $("c-order").addEventListener("click", () => {
      this.keep();
      this.orders();
    });
    $("orders-tab").addEventListener("click", () => {
      this.keep();
      this.orders(true);
    });
    $("orders-x").addEventListener("click", () => this.orders(false));
    // Reaching into the drawer means you're using it: the tip's or a peek's timer mustn't
    // slide it away under your pointer (a click at second 9.9 used to miss).
    $("orders").addEventListener("pointerenter", () => this.keep());
    $("orders").addEventListener("focusin", () => this.keep());
    $("c-wind").addEventListener("click", () => this.forecast());
    $("chart").addEventListener("click", () => {
      if (!$("mapbox").classList.contains("big")) this.map(true);
    });
    $("map-x").addEventListener("click", () => this.map(false));
    $("mapbtn").addEventListener("click", () => this.map(true));
    $("hidebtn").addEventListener("click", (e) => {
      (e.currentTarget as HTMLElement).blur();
      this.bare(true);
    });
    $("keysbtn").addEventListener("click", () => this.keys());
    // A click on the sea closes the drawer (Leo's plan, item 4); a drag to turn the camera doesn't.
    let down: [number, number] | null = null;
    const app = $("app");
    app.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
    app.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) {
        if (this.isOpen("orders")) this.orders(false);
        if (!$("keylist").hidden) this.keys(false);
        if (document.body.classList.contains("bare")) this.bare(false);
      }
      down = null;
    });
    // The site's bar slides away while sailing; the mouse at the very top brings it back.
    addEventListener("pointermove", (e) => {
      if (!document.body.classList.contains("immersive")) return;
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

  /** Once you set sail: the bar slides away and the drawer shows itself with the coach line. */
  sailing(coach: string | null): void {
    // The bar goes at once, so the drawer and the map never start under it (Leo).
    document.body.classList.add("no-bar-anim", "immersive");
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("no-bar-anim")));
    if (coach) {
      $("coach").textContent = coach;
      $("coach").hidden = false;
      this.orders(true);
      clearTimeout(this.coachTimer);
      this.coachTimer = window.setTimeout(() => {
        $("coach").hidden = true;
        // Only slide it shut if the player isn't using it.
        if (!$("orders").matches(":hover, :focus-within")) this.orders(false);
      }, COACH_MS);
    }
  }

  isOpen(which: "orders" | "forecast" | "map"): boolean {
    if (which === "orders") return $("orders").classList.contains("open");
    if (which === "forecast") return $("fcbox").classList.contains("open");
    return $("mapbox").classList.contains("big");
  }

  orders(open = !this.isOpen("orders")): void {
    $("orders").classList.toggle("open", open);
    document.body.classList.toggle("orders-open", open);
    for (const id of ["c-order", "orders-tab"]) $(id).setAttribute("aria-expanded", String(open));
    if (!open) $("coach").hidden = true;
  }

  /** The arrow keys work with the drawer shut: it peeks open for 2 s to show the dial moving. */
  peekOrders(): void {
    if (this.isOpen("orders")) {
      if (!$("orders").dataset.peek) return;
    }
    $("orders").dataset.peek = "1";
    this.orders(true);
    clearTimeout(this.coachTimer);
    this.coachTimer = window.setTimeout(() => {
      delete $("orders").dataset.peek;
      if (!$("orders").matches(":hover, :focus-within")) this.orders(false);
    }, 2000);
  }

  /** Opening it yourself keeps it open; a peek doesn't. */
  private keep(): void {
    delete $("orders").dataset.peek;
    clearTimeout(this.coachTimer);
  }

  forecast(open = !this.isOpen("forecast"), auto = false): void {
    $("fcbox").classList.toggle("open", open);
    $("c-wind").setAttribute("aria-expanded", String(open));
    this.fcAuto = open && auto;
    if (open) this.hooks.forecastOpened();
  }

  /** The clock runs again: a forecast that opened itself for a decision closes itself. */
  clockRuns(): void {
    if (this.fcAuto) this.forecast(false);
  }

  map(big = !this.isOpen("map")): void {
    $("mapbox").classList.toggle("big", big);
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
    if (on) {
      tip.hidden = false;
      tip.classList.remove("gone");
      this.bareTimer = window.setTimeout(() => {
        tip.classList.add("gone");
        this.bareTimer = window.setTimeout(() => (tip.hidden = true), 900);
      }, 2000);
    } else tip.hidden = true;
  }

  /** Esc: close the topmost thing that's open. Returns false if nothing was. */
  escape(): boolean {
    if (document.body.classList.contains("bare")) this.bare(false);
    else if (!$("keylist").hidden) this.keys(false);
    else if (this.isOpen("map")) this.map(false);
    else if (this.isOpen("orders")) this.orders(false);
    else if (this.isOpen("forecast")) this.forecast(false);
    else if (document.body.classList.contains("immersive") && !document.body.classList.contains("peek")) document.body.classList.add("peek");
    else return false;
    return true;
  }

  /** The HUD's own keys, off the wheel. Returns true if it took the key. */
  key(e: KeyboardEvent): boolean {
    if (e.repeat || this.hooks.keysOff()) return false;
    switch (e.code) {
      case "KeyO":
        this.keep();
        this.orders();
        return true;
      case "KeyF":
        this.forecast();
        return true;
      case "KeyM":
        this.map();
        return true;
      case "KeyH":
        this.bare();
        return true;
      case "Escape":
        return this.escape();
    }
    return false;
  }

  /** A toast at the top. `sticky` ones (the reason the clock stopped) stay until it runs again.
   * Every toast also goes into the log in the big map. Returns the toast. */
  toast(text: string, when: string, colour: string, opts: { warn?: boolean; sticky?: boolean } = {}): HTMLElement {
    const el = document.createElement("div");
    el.className = "note";
    el.style.borderLeftColor = colour;
    const w = document.createElement("div");
    w.className = "when";
    w.textContent = when;
    const t = document.createElement("div");
    t.className = "txt";
    t.textContent = text;
    el.append(w, t);
    if (opts.sticky) el.dataset.sticky = "1";
    const box = $("notes");
    box.prepend(el);
    const live = Array.from(box.querySelectorAll<HTMLElement>(".note:not(.out)"));
    for (const old of live.slice(MAX_TOASTS)) this.dropToast(old);
    if (!opts.sticky) this.toastTimers.set(el, window.setTimeout(() => this.dropToast(el), opts.warn ? TOAST_MS.warn : TOAST_MS.info));
    const li = document.createElement("li");
    li.style.borderLeftColor = colour;
    const lw = document.createElement("span");
    lw.className = "when";
    lw.textContent = when;
    li.append(lw, document.createTextNode(text));
    const log = $("log");
    log.prepend(li);
    while (log.children.length > 200) log.lastElementChild?.remove();
    return el;
  }

  /** The clock runs again: the "Paused: ..." toasts have said their piece. */
  unstick(): void {
    for (const el of Array.from($("notes").querySelectorAll<HTMLElement>('.note[data-sticky="1"]'))) this.dropToast(el);
  }

  dropToast(el: HTMLElement): void {
    clearTimeout(this.toastTimers.get(el));
    this.toastTimers.delete(el);
    if (el.classList.contains("out")) return;
    el.classList.add("out");
    window.setTimeout(() => el.remove(), 700);
  }
}

/** The strip's numbers. A field left out keeps what the strip shows: the picture's own
 * numbers (heading, speed, battery or heel, wind, waves) come every few frames from the hour
 * on screen, and the race against the ghost comes with each status. */
export interface StripData {
  order?: string;
  heading?: number | null;
  speedKn?: number | null;
  /** Battery (kayak) 0-100, or null for "no report". */
  battery?: number | null;
  /** Heel, degrees (sailboats): shown instead of the battery. */
  heel?: number | null;
  windKn?: number | null;
  windTo?: number | null;
  waves?: number | null;
  lead?: number;
  /** "About" in front: base's guess, not the truth. */
  guess?: boolean;
}

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const point = (deg: number): string => POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
/** Arrows for where the wind blows TO, as on the forecast. */
const ARROWS = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];
const arrow = (deg: number): string => ARROWS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

export function showStrip(d: StripData): void {
  if (d.order !== undefined) $("c-orderv").textContent = d.order;
  if (d.heading !== undefined)
    {
      // "050°" first, the compass letters after in small type, so a narrow cell loses the letters, not the number (Milo).
      const e = $("c-headv");
      if (d.heading == null) e.textContent = "–";
      else {
        e.textContent = `${String(Math.round(((d.heading % 360) + 360) % 360) % 360).padStart(3, "0")}°`;
        const sub = document.createElement("span");
        sub.className = "sub";
        sub.textContent = point(d.heading);
        e.append(sub);
      }
    }
  if (d.speedKn !== undefined) $("c-speedv").textContent = d.speedKn == null ? "–" : `${d.speedKn.toFixed(1)} kn`;
  const bar = $("c-batbar");
  if (d.heel !== undefined) {
    $("c-batl").textContent = "heel";
    $("c-batv").textContent = d.heel == null ? "–" : `${Math.abs(d.heel).toFixed(0)}°`;
    bar.parentElement!.hidden = true;
  } else if (d.battery !== undefined) {
    $("c-batl").textContent = d.guess ? "battery, last report" : "battery";
    $("c-batv").textContent = d.battery == null ? "–" : `${Math.round(d.battery)}%`;
    bar.parentElement!.hidden = false;
    const b = d.battery ?? 0;
    bar.style.width = `${b}%`;
    bar.style.background = b < 15 ? "var(--bad)" : b < 35 ? "var(--warn)" : "var(--good)";
  }
  if (d.windKn !== undefined) $("c-windv").textContent = d.windKn == null ? "–" : `${d.windKn.toFixed(0)} kn ${d.windTo == null ? "" : arrow(d.windTo)}`;
  if (d.waves !== undefined) $("c-wavel").textContent = d.waves == null ? "wind" : `waves ${d.waves.toFixed(1)} m`;
  if (d.lead !== undefined) {
    const lead = $("c-lead");
    const km = Math.round(Math.abs(d.lead));
    $("c-leadv").textContent = km < 1 ? "level" : `${d.guess ? "~" : ""}${d.lead > 0 ? "+" : "−"}${km.toLocaleString()} km`;
    lead.classList.toggle("ahead", km >= 1 && d.lead > 0);
    lead.classList.toggle("behind", km >= 1 && d.lead < 0);
  }
}
