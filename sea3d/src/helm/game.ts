// The page's side of a Take the helm game: talks to the worker (worker.ts),
// one request at a time, and keeps both boats' voyages as replays so the 3D
// view and the chart can read them the way the voyage page does.

import type { Replay } from "../replay/data";

export type Heading = number | "finish" | "route" | "auto";
export type Mode = "hands_on" | "base";
export interface Report {
  t: string;
  lat: number;
  lon: number;
  soc?: number;
  hdg?: number;
  /** Where it came from: the daily Iridium report, or a 6-hourly backup-beacon fix while Iridium is down. The drop has none. */
  source?: "iridium" | "beacon";
}
/** What happened to an order: in base mode it can be refused (one a day) or be on its way. */
export interface OrderResult {
  accepted: boolean;
  /** Refused because orders can't reach the boat any more: "main_box" or "comms_silent". */
  no_link?: string;
  next_allowed?: string;
  arrives?: string | null;
  from_report?: string;
  /** A wheel spell's trim as the simulator took it (clamped), and until when it holds. */
  trim?: number;
  trim_until?: string;
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
  /** Why orders can no longer reach the boat ("main_box", "comms_silent"), or null/absent while they can. */
  no_link?: string | null;
  boat: BoatNow;
  ghost: BoatNow;
  lead_km: number;
  order: { heading: Heading; power: number; sails?: string | null; engine?: boolean | null };
  /** True for a boat with sails (#242): it also takes sail and engine orders. */
  sailboat?: boolean;
  /** A sailboat's state and what may be ordered (#242). */
  sailing?: {
    plans: string[];
    has_engine: boolean;
    plan: string | null;
    heel_deg: number | null;
    engine_on: boolean | null;
    fuel_l: number | null;
    tactic: "beat" | "run" | "reach" | null;
    tacks: number;
  };
  power_w: number;
  /** "hands_on" or "base" (older simulators leave it out: hands on). */
  mode?: Mode;
  /** Real base station: the last report base has, and orders still on their way. */
  base?: {
    last_report: Report;
    waiting: { due: string; power: number }[];
    /** Every report that reached base, the drop first (#214). */
    reports?: Report[];
    /** Base's dead-reckoned guess at where the boat is now (#214). */
    estimate?: { lat: number; lon: number; from_report: string; age_h: number };
  };
  /** How long the boat has gone unheard, against the race's limits (older simulators leave it out). */
  silence?: { days_in_a_row: number; days_total: number; limit_in_a_row: number; limit_total: number };
  /** False in base mode: the page shows what base knows, not the true boat (#214). */
  show_true_position?: boolean;
  /** A hand-trimmed watch running now (Take the wheel, phase 2): null when none; older simulators leave it out. */
  trim?: { share: number; until: string; factor: number; gain_km?: number } | null;
  /** What every wheel watch so far has gained (km through the water vs the autopilot's trim). */
  trim_gain_km?: number;
  weather?: { wind_u: number; wind_v: number; hs: number; tp: number; wave_dir: number; current_u: number; current_v: number; ghi: number; rain: number };
}
/** An order's next day, sailed by a copy of the boat (sandbox/helm.py Game.preview, #330). */
export interface Preview {
  hours: number;
  /** Mean speed through the water, m/s. */
  stw: number;
  /** Battery change, 0-1 of full. */
  soc: number;
  /** km made towards the finish (negative: further away). */
  km: number;
  outcome: string;
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
/** How a voyage ended, in the boat's own words (sandbox/endings.py, #234). */
export interface Ending {
  headline: string;
  words: string;
  where: string | null;
  day: number | null;
  boat: string | null;
}
/** The satellite airtime counter (older simulators leave it out). */
export interface Airtime {
  up: { messages: number; bytes: number };
  down: { messages: number; bytes: number };
  lost: number;
  months: number;
  bytes_billed: number;
  usd: { monthly_fees: number; extra_bytes: number; empty_mailbox_checks: number; activation: number; total: number };
  plan: string;
  beacon_pings: number;
}

/** Plain words for the airtime counter: messages each way, bytes, and the bill. */
export function airtimeText(a: Airtime | null | undefined): string {
  if (!a) return "not counted";
  const bytes = a.up.bytes + a.down.bytes;
  return `${a.up.messages} sent, ${a.down.messages} from base, ${bytes.toLocaleString("en-US")} bytes: $${a.usd.total.toFixed(2)}`;
}

export interface Card {
  build: string;
  launch: string;
  seed: number;
  breakdowns_on: boolean;
  boat: { outcome: string; days: number; battery_low: number; breakdowns: string[]; ending?: Ending; airtime?: Airtime | null };
  ghost: { outcome: string; days: number; battery_low: number; breakdowns: string[]; ending?: Ending; airtime?: Airtime | null };
  margin_days: number | null;
  verdict: "won" | "lost" | "draw" | "neither_finished";
  breakdowns_differ: boolean;
  orders: { t: string; heading: Heading; power: number }[];
  /** Take the wheel spells (phase 2): watches a spell set, and what they were worth through the water vs the autopilot's trim (km). */
  trim_watches?: number;
  trim_gain_km?: number;
}
export type Stop = "time" | "battery" | "wind" | "land" | "breakdown" | "silence" | "ghost_passed" | "passed_ghost" | "over" | "order_arrived";
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
  /** The boat being sailed: "" for our kayak, "revc"/"revb" for a design on our model of the Randolph boat,
   *  else a ready-made boat's id ("stock_cruiser31"). */
  boatBase = "";
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

  private take(v: { status?: Status; boat?: Replay; ghost?: Replay; base?: string }): void {
    if (v.status) this.status = v.status;
    if (v.base !== undefined) this.boatBase = v.base;
    if (v.boat) this.boat = v.boat;
    if (v.ghost) this.ghost = v.ghost;
  }

  /** Load Python, the simulator and the 2020 weather now, so Set sail starts at once. Errors are left for start() to report. */
  warm(): Promise<void> {
    return this.ask<null>({ type: "warm" }).then(
      () => undefined,
      () => undefined,
    );
  }

  /** A new game. With a challenge, `launch` is ignored and `bundle` is the URL of
   *  its weather (left out when it's the 2020 bundle). `boat` names a ready-made
   *  boat (e.g. "stock_cruiser31"), or is a Boatyard design's simulator choices
   *  ("my boat"); left out, it's our kayak. `startPort`: a port id
   *  from ports.json to start from instead of the usual drop. `launch` is an index into
   *  the six odds launches, or an April to June day ("2020-04-23", noon UTC). */
  async start(launch: number | string, safe: boolean, breakdowns: boolean, mode: Mode = "hands_on", challenge?: { id: string; bundle?: string }, boat?: string | Record<string, string | number>, startPort?: string): Promise<Status> {
    const v = await this.ask<{ launches: string[]; status: Status; boat: Replay; ghost: Replay }>({
      type: "new",
      ...(typeof launch === "string" ? { day: launch, launch: 0 } : { launch }),
      safe,
      breakdowns,
      mode,
      challenge: challenge?.id,
      bundle: challenge?.bundle,
      choices: typeof boat === "string" ? { base: boat } : boat && Object.keys(boat).length ? boat : undefined,
      start_port: startPort || undefined,
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

  /** sails and engine: sailboats only; null or left out lets the boat decide.
   * trim: a "Take the wheel" spell's share of the best speed (sailboats only): the
   * simulator sails at it for the next watch instead of the autopilot's own trim. */
  async order(heading: Heading, power: number, sails?: string | null, engine?: boolean | null, trim?: number | null): Promise<OrderResult> {
    const extra: Record<string, unknown> = sails != null || engine != null ? { sails: sails ?? null, engine: engine ?? null } : {};
    if (trim != null) extra.trim = trim;
    const v = await this.ask<{ order: OrderResult; status: Status }>({ type: "order", heading, power, ...extra });
    this.status = v.status;
    return v.order;
  }

  async run(o: RunOptions): Promise<Stop> {
    const v = await this.ask<{ stopped: Stop; status: Status; boat: Replay; ghost: Replay }>({ type: "run", ...o });
    this.take(v);
    return v.stopped;
  }

  /** What an order would do over the next `hours` (a copy of the boat sails it; the game is untouched), or null where the simulator can't say (#330). */
  preview(heading: Heading, power: number, sails?: string | null, engine?: boolean | null, hours = 24): Promise<Preview | null> {
    const extra = sails != null || engine != null ? { sails: sails ?? null, engine: engine ?? null } : {};
    return this.ask<Preview | null>({ type: "preview", heading, power, hours, ...extra });
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
      return "Land is getting close.";
    case "silence": {
      const q = st?.silence;
      return q
        ? `Nothing has heard from the boat for ${q.days_in_a_row.toFixed(1)} days (${q.days_total} silent days in all). The race disqualifies a boat silent more than ${q.limit_in_a_row} days in a row or ${q.limit_total} in total.`
        : "The boat has gone quiet; the race disqualifies a boat that stays silent too long.";
    }
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
