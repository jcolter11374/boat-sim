// The page's side of a Take the helm game: talks to the worker (worker.ts),
// one request at a time, and keeps both boats' voyages as replays so the 3D
// view and the chart can read them the way the voyage page does.

import type { Replay } from "../replay/data";

export type Heading = number | "finish" | "route";
export type Mode = "hands_on" | "base";
/** What happened to an order: in base mode it can be refused (one a day) or be on its way. */
export interface OrderResult {
  accepted: boolean;
  next_allowed?: string;
  arrives?: string | null;
  from_report?: string;
}
export interface BoatNow {
  t: string;
  lat: number;
  lon: number;
  heading: number;
  stw: number;
  soc: number;
  km_to_finish: number;
  outcome: string;
}
export interface Status {
  day: number;
  over: boolean;
  boat: BoatNow;
  ghost: BoatNow;
  lead_km: number;
  order: { heading: Heading; power: number };
  power_w: number;
  /** "hands_on" or "base" (older simulators leave it out: hands on). */
  mode?: Mode;
  /** Real base station: the last report base has, and orders still on their way. */
  base?: { last_report: { t: string; lat: number; lon: number; soc?: number }; waiting: { due: string; power: number }[] };
  weather?: { wind_u: number; wind_v: number; hs: number; tp: number; wave_dir: number; current_u: number; current_v: number; ghi: number; rain: number };
}
export interface ForecastRow {
  t: string;
  wind_u: number;
  wind_v: number;
  hs: number;
  current_u: number;
  current_v: number;
  ghi: number;
}
export interface Card {
  build: string;
  launch: string;
  seed: number;
  breakdowns_on: boolean;
  boat: { outcome: string; days: number; battery_low: number; breakdowns: string[] };
  ghost: { outcome: string; days: number; battery_low: number; breakdowns: string[] };
  margin_days: number | null;
  verdict: "won" | "lost" | "draw" | "neither_finished";
  breakdowns_differ: boolean;
  orders: { t: string; heading: Heading; power: number }[];
}
export type Stop = "time" | "battery" | "wind" | "land" | "breakdown" | "ghost_passed" | "passed_ghost" | "over" | "order_arrived";
export interface RunOptions {
  hours?: number;
  max_hours?: number;
  soc_below?: number;
  wind_above?: number;
  breakdown?: boolean;
}

type Reply = { id: number; ok: boolean; value?: unknown; error?: string } | { type: "progress"; text: string };

export class HelmGame {
  boat: Replay | null = null;
  ghost: Replay | null = null;
  status: Status | null = null;
  launches: string[] = [];
  onProgress: (text: string) => void = () => {};
  private worker: Worker;
  private next = 1;
  private waiting = new Map<number, { ok: (v: unknown) => void; bad: (e: Error) => void }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly base: string,
    make: () => Worker = () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  ) {
    this.worker = make();
    this.worker.onmessage = (ev: MessageEvent<Reply>) => {
      const r = ev.data;
      if ("type" in r) {
        this.onProgress(r.text);
        return;
      }
      const w = this.waiting.get(r.id);
      if (!w) return;
      this.waiting.delete(r.id);
      if (r.ok) w.ok(r.value);
      else w.bad(new Error(r.error));
    };
    this.worker.onerror = (e) => {
      for (const w of this.waiting.values()) w.bad(new Error(e.message || "the simulator stopped"));
      this.waiting.clear();
    };
  }

  /** One request at a time, in order. */
  private ask<T>(msg: Record<string, unknown>): Promise<T> {
    const p = this.queue.then(
      () =>
        new Promise<T>((ok, bad) => {
          const id = this.next++;
          this.waiting.set(id, { ok: ok as (v: unknown) => void, bad });
          this.worker.postMessage({ ...msg, id, base: this.base });
        }),
    );
    this.queue = p.catch(() => undefined);
    return p;
  }

  private take(v: { status?: Status; boat?: Replay; ghost?: Replay }): void {
    if (v.status) this.status = v.status;
    if (v.boat) this.boat = v.boat;
    if (v.ghost) this.ghost = v.ghost;
  }

  /** A new game. With a challenge, `launch` is ignored and `bundle` is the URL of
   *  its weather (left out when it's the 2020 bundle). */
  async start(launch: number, safe: boolean, breakdowns: boolean, mode: Mode = "hands_on", challenge?: { id: string; bundle?: string }): Promise<Status> {
    const v = await this.ask<{ launches: string[]; status: Status; boat: Replay; ghost: Replay }>({
      type: "new",
      launch,
      safe,
      breakdowns,
      mode,
      challenge: challenge?.id,
      bundle: challenge?.bundle,
    });
    this.launches = v.launches;
    this.take(v);
    return v.status;
  }

  /** A shared game, sailed back to where it was saved. */
  async load(code: string, bundle?: string): Promise<{ status: Status; orders: { heading: Heading; power: number }[]; launch: number }> {
    const v = await this.ask<{ launches: string[]; status: Status; orders: { heading: Heading; power: number }[]; launch: number; boat: Replay; ghost: Replay }>({ type: "load", code, bundle });
    this.launches = v.launches;
    this.take(v);
    return v;
  }

  /** A short code for a share link. */
  save(): Promise<string> {
    return this.ask<string>({ type: "save" });
  }

  async order(heading: Heading, power: number): Promise<OrderResult> {
    const v = await this.ask<{ order: OrderResult; status: Status }>({ type: "order", heading, power });
    this.status = v.status;
    return v.order;
  }

  async run(o: RunOptions): Promise<Stop> {
    const v = await this.ask<{ stopped: Stop; status: Status; boat: Replay; ghost: Replay }>({ type: "run", ...o });
    this.take(v);
    return v.stopped;
  }

  forecast(): Promise<ForecastRow[]> {
    return this.ask<ForecastRow[]>({ type: "forecast" });
  }

  async result(): Promise<Card> {
    const v = await this.ask<{ card: Card; boat: Replay; ghost: Replay }>({ type: "result" });
    this.take(v);
    return v.card;
  }

  dispose(): void {
    this.worker.terminate();
  }
}

/** Plain words for why the clock stopped. */
export function stopText(s: Stop, st: Status | null): string {
  const lead = st ? Math.abs(st.lead_km) : 0;
  switch (s) {
    case "time":
      return "Three days passed without anything worth stopping for.";
    case "battery":
      return `The battery is down to ${st ? Math.round(st.boat.soc * 100) : "?"}%.`;
    case "wind":
      return "The wind is getting up.";
    case "land":
      return "Land is within 50 km.";
    case "breakdown":
      return "Something went wrong on board (see the note on the right).";
    case "ghost_passed":
      return `The autopilot ghost has just passed you; it's ${lead.toFixed(0)} km closer to the finish now.`;
    case "passed_ghost":
      return `You've just passed the autopilot ghost; you're ${lead.toFixed(0)} km closer to the finish now.`;
    case "over":
      return "The voyage is over.";
    case "order_arrived":
      return "Your order has reached the boat.";
  }
}

/** Plain words for an outcome. */
export const OUTCOME: Record<string, string> = {
  arrived: "reached the finish",
  at_sea: "still at sea",
  timeout: "still at sea",
  aground: "ran aground",
  landfall: "made landfall (not a finish)",
  sunk: "sank",
  lost: "was lost",
  disqualified: "was disqualified (silent too long)",
  left_data_box: "sailed off the edge of our weather map",
};
