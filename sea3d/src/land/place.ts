/**
 * Places with real land to sail past (?place=pico on the replay page). The boat
 * sits at the spot; the land is built around it from the land-data release
 * (Priya's landdata bake, copied into public/land by the Pages build).
 */
export interface Place {
  key: string;
  name: string;
  /** Where the boat sits. */
  lat: number;
  lon: number;
  /** Which way the camera looks at first (compass degrees), towards the land. */
  look: number;
  /** Credit line for the page. */
  credit: string;
  /** The land files' name (<land>_meta.json and so on) when another place's files cover it. */
  land?: string;
  /** A town's buildings and piers (<town>.json and <town>_height.bin) to stand on the land. */
  town?: string;
  /** "plain" for a shore without Pico's black basalt band (bulkheads, lawns, marsh). */
  shore?: "basalt" | "plain";
  /** Sea cliffs: steep faces are drawn as warm, darker rock (the photo stretched down a cliff is pale and flat). */
  cliffs?: boolean;
  /**
   * A sheltered harbour: the waves are the local wind's chop over this many metres
   * of open water (the fetch), not the ocean swell the replay logged offshore.
   */
  fetch?: number;
}

const CREDIT = "Land: AWS Terrain Tiles; contains modified Copernicus Sentinel data 2023-24";
const ODBL = "Buildings, piers and trees: © OpenStreetMap contributors and Overture Maps Foundation, ODbL";

export const PLACES: Record<string, Place> = {
  pico: {
    key: "pico",
    name: "Off Pico, Azores",
    // About 450 m off Pico's south-west shore, the mountain 7 km to the north-east.
    lat: 38.418,
    lon: -28.45,
    look: 37,
    credit: CREDIT,
  },
  horta: {
    key: "horta",
    name: "Off Horta, Faial",
    // In the channel between Faial and Pico, about 2 km east of Horta's harbour.
    lat: 38.53,
    lon: -28.6,
    look: 265,
    credit: CREDIT,
    land: "pico", // Faial is in the Pico files
  },
  baymouth: {
    key: "baymouth",
    name: "Chesapeake Bay mouth",
    // About 3 km north-east of Cape Henry, looking at the cape; Cape Charles is 20 km behind.
    lat: 36.95,
    lon: -75.985,
    look: 215,
    credit: CREDIT,
  },
  lisbon: {
    key: "lisbon",
    name: "Off Cascais, near Lisbon",
    // About 3 km south of Cascais, Cabo da Roca and the Sintra hills to the north-west.
    lat: 38.668,
    lon: -9.42,
    look: 340,
    credit: CREDIT,
    cliffs: true, // Cabo da Roca's 140 m face, in the finish scene
  },
  annapolis: {
    key: "annapolis",
    name: "Annapolis harbour",
    // In the harbour mouth, about 800 m east-south-east of the State House, looking at the town.
    lat: 38.97556,
    lon: -76.48283,
    look: 297,
    credit: `${CREDIT} · ${ODBL}`,
    land: "annapolisbay",
    town: "annapolis",
    shore: "plain",
    fetch: 3000, // out past the harbour mouth to the Bay
  },
};

/**
 * Wind chop on a short stretch of open water (JONSWAP fetch-limited growth):
 * Hs = 0.0016 U sqrt(F / g) and g Tp / U = 0.286 (g F / U^2)^(1/3), for wind U (m/s) over F metres.
 * Capped at a fully developed sea (Pierson-Moskowitz: Hs = 0.21 U^2 / g, Tp = 0.73 U).
 */
export function fetchSea(wind: number, fetch: number): { hs: number; tp: number } {
  const g = 9.81;
  const u = Math.max(wind, 1);
  const hs = Math.min(0.0016 * u * Math.sqrt(fetch / g), 0.0214 * u * u);
  const tp = Math.min(0.286 * (u / g) * Math.cbrt((g * fetch) / (u * u)), 0.73 * u);
  return { hs: Math.max(hs, 0.03), tp: Math.max(tp, 1) };
}

/** The place in the page's address, if any; &spot=lat,lon moves the boat (for pictures and tests). */
export const PLACE: Place | null = (() => {
  if (typeof location === "undefined") return null;
  const q = new URLSearchParams(location.search);
  const p = PLACES[q.get("place") ?? ""];
  if (!p) return null;
  const spot = (q.get("spot") ?? "").split(",").map(Number);
  return spot.length === 2 && spot.every(Number.isFinite) ? { ...p, lat: spot[0], lon: spot[1] } : p;
})();
