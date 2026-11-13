// "Race it" on the helm's sailing screen (M2 "One sailing screen", piece R3; Rosa).
//
// Two boats, the same launch, the same weather and the same dice (Theo's
// boatsim.sandbox.race, in src/race/worker.ts). The helm draws from the rows the simulator
// hands it (HelmGame: boat, ghost, status), so a race is the same screen with boat A in the
// boat's place and boat B where the ghost goes. This module stands between HelmGame and the
// race worker: it passes the helm's messages on in the race's words, and turns the race's
// answers into the helm's shapes. Nobody steers a race, so orders are refused.
//
// Pure apart from the worker it is handed: no DOM and no fetch here.

import { lastHour, planAt, valueAt, type Replay } from "../replay/data";
import type { BoatNow, Card, Status, Stop } from "./game";

/** A boat in the race: Boatyard choices ({} is our kayak, {base: "revc"}, a whole design). */
export type RaceChoices = Record<string, string>;

export interface RacePick {
  a: RaceChoices;
  b: RaceChoices;
  /** Which of the six odds launches (0 = 1 April 2020). */
  launch: number;
  breakdowns: boolean;
}

/** The race worker's own shapes (src/race/worker.ts). */
export interface RaceBoat {
  name: string;
  build: string;
  t: string;
  lat: number;
  lon: number;
  heading?: number;
  stw: number;
  soc: number;
  km_to_finish: number;
  outcome: string;
  breakdowns: string[];
  weather?: { wind_u: number; wind_v: number; hs: number; tp?: number; wave_dir?: number; current_u?: number; current_v?: number; ghi?: number; rain?: number };
}
export interface RaceStatus {
  launch: string;
  day: number;
  over: boolean;
  boats: [RaceBoat, RaceBoat];
  /** Positive: A ahead. */
  lead_km: number;
  leader: number | null;
}
export interface RaceCardBoat {
  name: string;
  build?: string;
  outcome: string;
  days: number;
  battery_low: number;
  breakdowns: string[];
}
export interface RaceCard {
  launch: string;
  seed?: number;
  breakdowns_on?: boolean;
  boats: [RaceCardBoat, RaceCardBoat];
  verdict: string;
  winner: number | null;
  margin_days: number | null;
  words: string;
  breakdowns_differ: boolean;
}

/** What the page needs to name the race (for the strip, the chart and the ending). */
export interface RaceInfo {
  names: [string, string];
  /** The helm's boat keys, for the 3D models: "" our kayak, "revb"/"revc", or a stock id. */
  bases: [string, string];
  launch: string;
}

/** The helm's boat key for a design: "" our kayak, else its base ("revc", "stock_cruiser31"). */
export function raceBase(ch: RaceChoices): string {
  const b = ch.base ?? "";
  return b === "kayak" ? "" : b;
}

/** A Randolph boat is always "(our model)" (John, B2), and the Rev C is the C5 as the Boatyard names it. */
export function raceName(name: string): string {
  const n = name.replace(/\bRev C\b(?!\d)/g, "Rev C5");
  return /randolph/i.test(n) && !/our model/i.test(n) ? `${n} (our model)` : n;
}

const now = (b: RaceBoat): BoatNow => ({ t: b.t, lat: b.lat, lon: b.lon, heading: b.heading ?? 0, stw: b.stw, soc: b.soc, km_to_finish: b.km_to_finish, outcome: b.outcome });

/** The race's status as the helm's: boat A where your boat goes, boat B where the ghost goes. `a` is A's voyage so far (for a yacht's sails and lean). */
export function raceStatus(rs: RaceStatus, a: Replay | null): Status {
  const [A, B] = rs.boats;
  const w = A.weather;
  const st: Status = {
    day: rs.day,
    over: rs.over,
    no_link: null,
    boat: now(A),
    ghost: now(B),
    lead_km: rs.lead_km,
    order: { heading: "auto", power: 0 },
    power_w: 0,
    mode: "hands_on",
    show_true_position: true,
  };
  if (w) st.weather = { wind_u: w.wind_u, wind_v: w.wind_v, hs: w.hs, tp: w.tp ?? 0, wave_dir: w.wave_dir ?? 0, current_u: w.current_u ?? 0, current_v: w.current_v ?? 0, ghi: w.ghi ?? 0, rain: w.rain ?? 0 };
  if (a?.sail_plan) {
    const h = lastHour(a);
    st.sailboat = true;
    st.sailing = { plans: [], has_engine: !!a.engine, plan: planAt(a, h), heel_deg: a.heel ? valueAt(a, a.heel, h) : null, engine_on: a.engine ? (valueAt(a, a.engine, h) ?? 0) > 0.5 : null, fuel_l: null, tactic: null, tacks: 0 };
  }
  return st;
}

/** The race's results as the helm's card: A is "boat", B is "ghost". The race's own words ride along, so the ending says who won in the boats' names. */
export function raceCard(c: RaceCard): Card & { race: RaceCard } {
  const [a, b] = c.boats;
  const side = (x: RaceCardBoat) => ({ outcome: x.outcome, days: x.days, battery_low: x.battery_low, breakdowns: x.breakdowns });
  const verdict: Card["verdict"] = c.winner === 0 ? "won" : c.winner === 1 ? "lost" : c.verdict === "draw" ? "draw" : "neither_finished";
  return { build: a.build ?? "", launch: c.launch, seed: c.seed ?? 0, breakdowns_on: c.breakdowns_on ?? true, boat: side(a), ghost: side(b), margin_days: c.margin_days, verdict, breakdowns_differ: c.breakdowns_differ, orders: [], race: c };
}

type Ask = { id: number; type: string; base?: string; hours?: number };
type Reply = { id?: number; ok?: boolean; value?: unknown; error?: string; type?: string; text?: string };
type RaceValue = { launches?: string[]; stopped?: string; status: RaceStatus; replays: [Replay, Replay] | null; card?: RaceCard };

/**
 * A stand-in for the helm's simulator worker (HelmGame's `make`) that runs a race: `real`
 * makes the race worker; `pick` is the two boats and the launch.
 */
export function raceWorker(real: () => Worker, pick: RacePick, loaded: (info: RaceInfo) => void = () => {}): Worker {
  const inner = real();
  /** Our message ids are the helm's, passed straight through: what each one asked. */
  const asked = new Map<number, string>();
  const w = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    onerror: null as ((ev: ErrorEvent) => void) | null,
    postMessage(m: Ask): void {
      const answer = (r: Reply) => queueMicrotask(() => w.onmessage?.({ data: { id: m.id, ...r } } as MessageEvent));
      switch (m.type) {
        case "new":
          asked.set(m.id, m.type);
          return inner.postMessage({ id: m.id, base: m.base, type: "new", a: pick.a, b: pick.b, launch: pick.launch, breakdowns: pick.breakdowns, drop: "same", replays: true });
        case "run":
          asked.set(m.id, m.type);
          // A fixed hop: nobody is steering, so nothing waits for a call.
          return inner.postMessage({ id: m.id, base: m.base, type: "run", hours: m.hours ?? 24, replays: true });
        case "result":
        case "warm":
          asked.set(m.id, m.type);
          return inner.postMessage({ id: m.id, base: m.base, type: m.type, replays: true });
        case "order":
          return answer({ ok: false, error: "nobody steers a race" });
        case "preview":
          return answer({ ok: true, value: null });
        case "forecast":
          return answer({ ok: true, value: [] });
        default:
          return answer({ ok: false, error: `a race can't ${m.type}` });
      }
    },
    terminate(): void {
      inner.terminate();
    },
  };
  inner.onmessage = (ev: MessageEvent<Reply>) => {
    const r = ev.data;
    if (r.type === "progress" || r.id === undefined) return w.onmessage?.(ev);
    const what = asked.get(r.id);
    asked.delete(r.id);
    if (!r.ok || what === "warm") return w.onmessage?.(ev);
    const v = r.value as RaceValue;
    if (!v.replays) return w.onmessage?.({ data: { id: r.id, ok: false, error: "NO_RACE" } } as MessageEvent);
    for (const [i, rep] of v.replays.entries()) rep.boat = raceName(v.status.boats[i].name);
    const both = { status: raceStatus(v.status, v.replays[0]), boat: v.replays[0], ghost: v.replays[1] };
    let value: unknown;
    if (what === "new") {
      loaded({ names: [raceName(v.status.boats[0].name), raceName(v.status.boats[1].name)], bases: [raceBase(pick.a), raceBase(pick.b)], launch: v.status.launch });
      value = { launches: v.launches ?? [], base: raceBase(pick.a), ...both };
    } else if (what === "run") value = { stopped: (v.status.over ? "over" : "time") as Stop, ...both };
    else value = { card: raceCard(v.card!), boat: both.boat, ghost: both.ghost };
    w.onmessage?.({ data: { id: r.id, ok: true, value } } as MessageEvent);
  };
  inner.onerror = (e) => w.onerror?.(e);
  return w as unknown as Worker;
}

/** The boat ids a race link may name (the race page's own picks, plus "mine"). */
export const RACE_BOATS = ["kayak", "revc", "revb", "mine"] as const;

/**
 * The race a link asks for: ?race=<a>,<b> (ids from RACE_BOATS; "mine" is the player's saved
 * boat) and ?launch=<0..5>. Anything else falls back: our kayak against our model of the
 * Randolph Rev C5, on the first launch. `mine` is the saved boat's choices, if there is one.
 */
export function racePick(race: string, launch: string | null, mine: RaceChoices | null): RacePick {
  const ok = (x: string | undefined) => (RACE_BOATS as readonly string[]).includes(x ?? "");
  const [ra, rb] = race.split(",");
  const choices = (id: string): RaceChoices => (id === "mine" ? (mine ?? {}) : id === "kayak" ? {} : { base: id });
  const a = ok(ra) ? ra : mine ? "mine" : "kayak";
  const b = ok(rb) ? rb : a === "revc" ? "kayak" : "revc";
  const n = Number(launch);
  return { a: choices(a), b: choices(b), launch: launch !== null && Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0, breakdowns: true };
}
