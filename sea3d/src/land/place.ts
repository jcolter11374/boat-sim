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
}

export const PLACES: Record<string, Place> = {
  pico: {
    key: "pico",
    name: "Off Pico, Azores",
    // About 450 m off Pico's south-west shore, the mountain 7 km to the north-east.
    lat: 38.418,
    lon: -28.45,
    look: 37,
    credit: "Land: AWS Terrain Tiles; contains modified Copernicus Sentinel data 2023-24",
  },
};

/** The place in the page's address, if any; &spot=lat,lon moves the boat (for pictures and tests). */
export const PLACE: Place | null = (() => {
  if (typeof location === "undefined") return null;
  const q = new URLSearchParams(location.search);
  const p = PLACES[q.get("place") ?? ""];
  if (!p) return null;
  const spot = (q.get("spot") ?? "").split(",").map(Number);
  return spot.length === 2 && spot.every(Number.isFinite) ? { ...p, lat: spot[0], lon: spot[1] } : p;
})();
