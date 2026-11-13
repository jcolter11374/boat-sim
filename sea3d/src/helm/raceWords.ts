// A race on the sailing screen (M2 piece S4): how the two boats are named on the strip, the chart and
// the tag over the far boat. Pure: no DOM here.
//
// A Randolph boat is our model of it, not their boat, and says so wherever its name stands (decision B2).

/** A name short enough for the strip and a button: "Randolph Rev C5 (our model)" is "Rev C5 (our model)". */
export function shortRacer(name: string): string {
  return name.replace(/^Randolph\s+/i, "");
}

export interface LeadCell {
  /** The big figure: "59" or "level". */
  value: string;
  /** Small type after it: " km ahead", or nothing when level. */
  unit: string;
  /** Under it: who is ahead, or both boats when level. */
  label: string;
  /** 0 or 1: which boat leads; null when level. */
  leader: 0 | 1 | null;
}

/** The strip's lead cell in a race. `leadKm` is boat A's lead over boat B (+ ahead), as the helm's status gives it. */
export function raceLead(leadKm: number, names: [string, string]): LeadCell {
  const km = Math.round(Math.abs(leadKm));
  if (!Number.isFinite(leadKm) || km < 1) return { value: "level", unit: "", label: "the two boats", leader: null };
  const leader = leadKm > 0 ? 0 : 1;
  return { value: km.toLocaleString("en-US"), unit: " km ahead", label: shortRacer(names[leader]), leader };
}

/** The tag over the boat you aren't following: its name and how far off it is. */
export function farBoatTag(name: string, km: number): string {
  return `${shortRacer(name)} · ${km < 1 ? "alongside" : `${km.toFixed(0)} km`}`;
}

/**
 * A name for the big map's side panel, under its key: "Rev C5". The key right above carries the full name once,
 * "Randolph Rev C5 (our model)" (B2); repeating it on every line made the panel hard to read. Only for the panel:
 * the strip and the tag over the far boat stand alone, so they keep "(our model)".
 */
export function bareRacer(name: string): string {
  return shortRacer(name).replace(/\s*\(our model\)$/i, "");
}

/** The big map's line: which boat is ahead of which, in the panel's short names. */
export function raceLine(leadKm: number, names: [string, string]): string {
  const c = raceLead(leadKm, names);
  const [a, b] = [bareRacer(names[0]), bareRacer(names[1])];
  return c.leader === null ? `${a} and ${b} are level` : `${[a, b][c.leader]} is ${c.value} km ahead of ${[a, b][1 - c.leader]}`;
}
