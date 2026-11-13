// Watch a voyage on the helm's sailing screen (M2 "One sailing screen", piece R1; Rosa).
//
// The helm draws from the rows the simulator hands it (HelmGame: boat, ghost, status). A
// watched voyage is the same screen fed a recorded voyage (a replay file) instead: this
// module stands in for the simulator's worker and answers the same messages from the
// recorded rows. No Python to load, nothing to steer, and no second boat.
//
// "run" hands out the rows up to the clock's hour and no further, so the chart, the notes
// and the strip never show what's ahead, exactly as when you sail it yourself.
//
// Pure: no DOM and no fetch here (the page passes in how to load the file).

import { angleAt, distanceKm, lastHour, planAt, positionAt, valueAt, type IndexEntry, type Replay } from "../replay/data";
import { stockKeyOf } from "../boats/specs";
import type { BoatNow, Card, Status, Stop } from "./game";

/** The voyage Watch a voyage opens on (unchanged since 9 Nov; an open item on John's list, so not ours to move). */
export const WATCH_DEFAULT_DAY = "2020-06-01";

/** The helm's boat key for a recorded voyage's boat name: "" our kayak, "revb"/"revc" our model of the Randolph boat, or a stock id. */
export function watchBase(boat: string): string {
  return stockKeyOf(boat) ?? (!/randolph/i.test(boat) ? "" : /rev[\s_-]*c\b/i.test(boat) ? "revc" : "revb");
}

/** The boat's name for a player. A Randolph boat is always "(our model)" (John, B2). */
export function watchName(boat: string): string {
  const base = watchBase(boat);
  if (base === "revc") return "Randolph Rev C (our model)";
  if (base === "revb") return "Randolph Rev B (our model)";
  if (base === "stock_pearson31_2") return "Randolph's Pearson 31-2 (our model)";
  if (base === "") return "Our kayak";
  return boat.replace(/^./, (c) => c.toUpperCase());
}

/**
 * The recorded voyage a link asks for. `asked` is ?watch=: empty (the default voyage), a
 * launch day ("2020-05-01", our kayak's voyage that day), or a file named in the index
 * ("voyage_31-ft-cruiser_2020-04-01.json"). Anything else falls back to the default, then
 * to the first voyage there is. Null when the index is empty.
 */
export function pickVoyage(asked: string, index: IndexEntry[]): IndexEntry | null {
  const ours = (day: string) => index.find((v) => v.start.slice(0, 10) === day && watchBase(v.boat) === "");
  return index.find((v) => v.file === asked) ?? (/^\d{4}-\d\d-\d\d$/.test(asked) ? ours(asked) : undefined) ?? ours(WATCH_DEFAULT_DAY) ?? index[0] ?? null;
}

/** A replay's times are UTC, written without a zone ("2020-06-01T12:00"). */
const utc = (t: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/i.test(t) ? t : `${t}Z`);

/** The voyage as far as `hour`: its rows and events up to then, and no ending until it's over. */
export function cutAt(rep: Replay, hour: number): Replay {
  const end = lastHour(rep);
  if (hour >= end) return rep;
  let n = 1;
  while (n < rep.h.length && rep.h[n] <= hour + 1e-9) n++;
  const cut = <T>(col: T[] | undefined): T[] | undefined => col?.slice(0, n);
  const now = utc(rep.start) + hour * 3600e3;
  const passed = (t: string | null) => (t && utc(t) <= now ? t : null);
  return {
    ...rep,
    end: null,
    outcome: "at_sea",
    days: hour / 24,
    t_start_line: passed(rep.t_start_line),
    t_finish_line: null,
    h: rep.h.slice(0, n),
    lat: rep.lat.slice(0, n),
    lon: rep.lon.slice(0, n),
    heading: rep.heading.slice(0, n),
    stw: rep.stw.slice(0, n),
    soc: rep.soc.slice(0, n),
    wind_u: rep.wind_u.slice(0, n),
    wind_v: rep.wind_v.slice(0, n),
    hs: rep.hs.slice(0, n),
    tp: rep.tp.slice(0, n),
    wave_dir: rep.wave_dir.slice(0, n),
    current_u: rep.current_u.slice(0, n),
    current_v: rep.current_v.slice(0, n),
    ghi: rep.ghi.slice(0, n),
    ...(rep.rain ? { rain: cut(rep.rain) } : {}),
    ...(rep.iridium_ok ? { iridium_ok: cut(rep.iridium_ok) } : {}),
    ...(rep.beacon_ok ? { beacon_ok: cut(rep.beacon_ok) } : {}),
    ...(rep.heel ? { heel: cut(rep.heel) } : {}),
    ...(rep.sail_plan ? { sail_plan: cut(rep.sail_plan) } : {}),
    ...(rep.engine ? { engine: cut(rep.engine) } : {}),
    events: rep.events.filter((e) => e.h <= hour + 1e-9),
  };
}

const iso = (rep: Replay, hour: number): string => new Date(utc(rep.start) + hour * 3600e3).toISOString().slice(0, 19);

/** What the helm's panels show at `hour` of a recorded voyage: the same Status the simulator gives, from the rows. */
export function statusAt(rep: Replay, hour: number): Status {
  const end = lastHour(rep);
  const h = Math.min(Math.max(hour, 0), end);
  const over = h >= end;
  const [lat, lon] = positionAt(rep, h);
  const v = (col: (number | null)[] | undefined) => (col ? valueAt(rep, col, h) : null) ?? 0;
  const radius = rep.course.target_radius_m / 1000;
  const toGo = over && rep.outcome === "arrived" ? 0 : Math.max(distanceKm([lat, lon], rep.course.target) - radius, 0);
  const boat: BoatNow = { t: iso(rep, h), lat, lon, heading: angleAt(rep, rep.heading, h) ?? 0, stw: v(rep.stw), soc: v(rep.soc), km_to_finish: toGo, outcome: over ? rep.outcome : "at_sea" };
  const st: Status = {
    day: h / 24,
    over,
    no_link: null,
    boat,
    // The Status shape has a second boat; a watched voyage has none, and the page shows none (page.view = "watch").
    ghost: boat,
    lead_km: 0,
    order: { heading: "auto", power: 0 },
    power_w: 0,
    mode: "hands_on",
    show_true_position: true,
    weather: { wind_u: v(rep.wind_u), wind_v: v(rep.wind_v), hs: v(rep.hs), tp: v(rep.tp), wave_dir: v(rep.wave_dir), current_u: v(rep.current_u), current_v: v(rep.current_v), ghi: v(rep.ghi), rain: v(rep.rain) },
  };
  if (rep.sail_plan) {
    st.sailboat = true;
    st.sailing = { plans: [], has_engine: !!rep.engine, plan: planAt(rep, h), heel_deg: rep.heel ? valueAt(rep, rep.heel, h) : null, engine_on: rep.engine ? v(rep.engine) > 0.5 : null, fuel_l: null, tactic: null, tacks: 0 };
  }
  return st;
}

/** What the page needs to know about the whole voyage (for the scrub bar and the ending), which the rows so far don't say. */
export interface WatchInfo {
  /** The voyage's length, hours. */
  hours: number;
  start: string;
  boat: string;
  name: string;
  outcome: string;
  days: number;
}

/** A recorded voyage, played through the helm's game messages. */
export class WatchSource {
  /** The hour handed out so far. */
  hour = 0;
  constructor(readonly rep: Replay) {}

  get info(): WatchInfo {
    return { hours: lastHour(this.rep), start: this.rep.start, boat: this.rep.boat, name: watchName(this.rep.boat), outcome: this.rep.outcome, days: this.rep.days };
  }

  private now(): { status: Status; boat: Replay } {
    return { status: statusAt(this.rep, this.hour), boat: cutAt(this.rep, this.hour) };
  }

  start(): { launches: string[]; status: Status; boat: Replay; base: string } {
    this.hour = 0;
    return { launches: [this.rep.start.slice(0, 10)], base: watchBase(this.rep.boat), ...this.now() };
  }

  /** Sail on `hours` (to the end at most). It only ever stops for time or the end: nobody is steering, so nothing waits for a call. */
  run(hours: number): { stopped: Stop; status: Status; boat: Replay } {
    this.hour = Math.min(lastHour(this.rep), this.hour + Math.max(0, hours));
    const v = this.now();
    return { stopped: v.status.over ? "over" : "time", ...v };
  }

  /** Jump to an hour of the voyage (the scrub bar). */
  seek(hour: number): { status: Status; boat: Replay } {
    this.hour = Math.min(lastHour(this.rep), Math.max(0, hour));
    return this.now();
  }

  /** The ending, in the results card's shape. There was no race: both sides are the one boat. */
  card(): Card {
    const r = this.rep;
    const lows = r.soc.filter((x): x is number => x != null);
    const side = { outcome: r.outcome, days: r.days, battery_low: lows.length ? Math.min(...lows) : 0, breakdowns: [] as string[] };
    return { build: "", launch: r.start, seed: r.seed, breakdowns_on: true, boat: side, ghost: side, margin_days: null, verdict: "neither_finished", breakdowns_differ: false, orders: [] };
  }
}

type Ask = { id: number; type: string; hours?: number; hour?: number };

/**
 * A stand-in for the simulator's worker (HelmGame's `make`): the same messages, answered
 * from a recorded voyage. `load` fetches the file, once, on the first message.
 */
export function watchWorker(load: () => Promise<Replay>, loaded: (info: WatchInfo) => void = () => {}): Worker {
  let src: Promise<WatchSource> | null = null;
  const ready = () =>
    (src ??= load().then((rep) => {
      const s = new WatchSource(rep);
      loaded(s.info);
      return s;
    }));
  const w = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    onerror: null as ((ev: ErrorEvent) => void) | null,
    postMessage(m: Ask): void {
      const reply = (r: Record<string, unknown>) => queueMicrotask(() => w.onmessage?.({ data: { id: m.id, ...r } } as MessageEvent));
      ready().then(
        (s) => {
          switch (m.type) {
            case "warm":
              return reply({ ok: true, value: null });
            case "new":
              return reply({ ok: true, value: s.start() });
            case "run":
              return reply({ ok: true, value: s.run(m.hours ?? 24) });
            case "seek":
              return reply({ ok: true, value: s.seek(m.hour ?? 0) });
            case "order":
              return reply({ ok: true, value: { order: { accepted: false }, status: statusAt(s.rep, s.hour) } });
            case "preview":
              return reply({ ok: true, value: null });
            case "forecast":
              return reply({ ok: true, value: [] });
            case "result":
              return reply({ ok: true, value: { card: s.card(), boat: s.rep } });
            default:
              return reply({ ok: false, error: `a recorded voyage can't ${m.type}` });
          }
        },
        (e) => {
          src = null; // a failed download can be tried again
          reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
        },
      );
    },
    terminate(): void {},
  };
  return w as unknown as Worker;
}
