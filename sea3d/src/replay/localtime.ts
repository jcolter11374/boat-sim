/**
 * The boat's local time, for the clocks under the UTC time (John, Nov 11).
 * Near land we use the real time zone there (with summer time); out at sea, the
 * "nautical" zone ships use: one hour per 15 degrees of longitude, no summer time.
 */

/** Coastal boxes where the shore's own clock applies: [zone, south, north, west, east, winter, summer]. */
const SHORES: [string, number, number, number, number, string, string][] = [
  ["Atlantic/Bermuda", 31.9, 32.7, -65.2, -64.3, "AST", "ADT"],
  ["Atlantic/Azores", 36.6, 40.0, -31.6, -24.6, "AZOT", "AZOST"],
  ["Atlantic/Madeira", 32.2, 33.3, -17.6, -16.1, "WET", "WEST"],
  ["Europe/Lisbon", 36.8, 42.2, -10.2, -6.0, "WET", "WEST"],
  ["Europe/Madrid", 42.2, 44.2, -10.0, -1.5, "CET", "CEST"],
  ["America/New_York", 24.5, 45.0, -84.0, -75.2, "EST", "EDT"],
];

/** Hours ahead of UTC (negative to the west) for a zone at a moment. */
function offsetHours(zone: string, ms: number): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).format(new Date(ms));
  const m = /GMT([+-])(\d\d):?(\d\d)?/.exec(s);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) + Number(m[3] ?? 0) / 60) : 0;
}

export interface Local {
  /** Hours ahead of UTC. */
  offset: number;
  /** "EDT", or "sea zone" out at sea. */
  name: string;
  /** The shore zone's IANA name, or null at sea. */
  zone: string | null;
}

export function zoneAt(lat: number, lon: number, ms: number): Local {
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    for (const [zone, s, n, w, e, winter, summer] of SHORES) {
      if (lat < s || lat > n || lon < w || lon > e) continue;
      try {
        const off = offsetHours(zone, ms);
        const jan = offsetHours(zone, Date.UTC(new Date(ms).getUTCFullYear(), 0, 15));
        return { offset: off, name: off > jan ? summer : winter, zone };
      } catch {
        break; // no time zone data in this browser: fall back to the sea zone
      }
    }
  }
  const off = Number.isFinite(lon) ? Math.round(lon / 15) : 0;
  return { offset: off === 0 ? 0 : off, name: "sea zone", zone: null };
}

const sign = (h: number) => (h < 0 ? "−" : "+") + Math.abs(h);

/** "8:01 AM local (UTC−4, EDT)" for the boat at lat, lon at the UTC moment ms. */
export function localTime(ms: number, lat: number, lon: number, seconds = false): string {
  const z = zoneAt(lat, lon, ms);
  const d = new Date(ms + z.offset * 3600e3);
  let h = d.getUTCHours();
  const ampm = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = seconds ? ":" + String(d.getUTCSeconds()).padStart(2, "0") : "";
  return `${h}:${mm}${ss} ${ampm} local (UTC${z.offset === 0 ? "" : sign(z.offset)}, ${z.name})`;
}
