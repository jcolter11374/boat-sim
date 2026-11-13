// "Your build" shows its odds (docs/glossary.md) as you swap parts (#315 item 12,
// Nina's first-time pass): the precomputed grid's odds when the design is one
// of the tested builds, else "not tested yet". Never the nearest build's odds
// under this design's name: a near miss can be far off (one motor vs two is
// 24 points). Text only; the page puts it in with textContent.

import type { GridBuild } from "./launch";

export interface Chance {
  /** True when the grid has this exact build's odds. */
  tested: boolean;
  /** The big figure, e.g. "78%", or "not tested yet". */
  value: string;
  /** One line under it. */
  note: string;
  /** Which launches it was tested on, for the "i" (Milo M4). */
  about?: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The chance of finishing for the nearest grid build (null: no grid), with the grid's launch years and months. */
export function chanceFor(
  n: { build: GridBuild; exact: boolean } | null,
  source: { years?: [number, number]; months?: number[] } | null,
  testLabel = "Test it",
): Chance {
  const o = n?.exact ? n.build.odds : null;
  if (!n || !o || !o.voyages) return { tested: false, value: "not tested yet", note: `Press "${testLabel}" to sail it.` };
  const yrs = source?.years ? `, ${source.years[0]} to ${source.years[1]}` : "";
  const ms = source?.months?.filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b) ?? [];
  const when = ms.length ? `, ${MONTH[ms[0] - 1]} to ${MONTH[ms[ms.length - 1] - 1]}${yrs}` : yrs;
  return {
    tested: true,
    value: pct(o.odds),
    note: `Likely range ${pct(o.low95)} to ${pct(o.high95)}.`,
    about: `Tested on ${o.voyages} launches${when}.`,
  };
}
