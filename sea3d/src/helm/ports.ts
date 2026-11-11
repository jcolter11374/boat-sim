// Ports to sail from in Take the helm (Priya's src/boatsim/oceandata/ports.py
// writes public/ports.json). Each port has a launch point at sea, where a
// support boat drops the kayak; the simulator starts both boats there
// (Game(start_port=...)). The picker lists the ports whose voyage crosses the
// race start line and whose launch point the browser's weather covers.

export interface Port {
  id: string;
  name: string;
  lat: number;
  lon: number;
  launch_lat: number;
  launch_lon: number;
  launch_km: number;
  in_corridor: boolean;
  crosses_start: boolean;
}

export async function loadPorts(url: string, get: (u: string) => Promise<Response> = (u) => fetch(u)): Promise<Port[]> {
  try {
    const r = await get(url);
    if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return [];
    const j = (await r.json()) as { ports?: Port[] };
    return (j.ports ?? [])
      .filter((p) => p && p.in_corridor && p.crosses_start && typeof p.id === "string")
      .sort((a, b) => a.name.localeCompare(b.name) || a.lat - b.lat);
  } catch {
    return [];
  }
}

const deg = (v: number, pos: string, neg: string, dp: number) => `${Math.abs(v).toFixed(dp)}°${v >= 0 ? pos : neg}`;

/** "Boston, launched 35 km out by water at 42.2°N 70.6°W" (with the port's
 *  position when two share a name, and "same start as ..." when the support boat
 *  drops several ports' boats at one point, as up a long bay or strait). */
/** The port's name for the picker: just the name, with where it is only when two share a name. */
export function portName(p: Port, all: Port[]): string {
  const twin = all.some((q) => q !== p && q.name === p.name);
  return twin ? `${p.name} (${deg(p.lat, "N", "S", 0)} ${deg(p.lon, "E", "W", 0)})` : p.name;
}

/** The details, shown under the picker once a port is picked (Nina's review: names in the list, the rest after). */
export function portHint(p: Port, all: Port[]): string {
  const at = `${deg(p.launch_lat, "N", "S", 1)} ${deg(p.launch_lon, "E", "W", 1)}`;
  const same = all.filter((q) => q !== p && q.launch_lat === p.launch_lat && q.launch_lon === p.launch_lon).map((q) => q.name);
  const shared = same.length ? `, the same start as ${[...new Set(same)].join(", ")}` : "";
  return `The boat is put in the water ${Math.round(p.launch_km)} km out from ${p.name} by water, at ${at}${shared}.`;
}

/** Name and details on one line (older pages and tests). */
export function portLabel(p: Port, all: Port[]): string {
  const twin = all.some((q) => q !== p && q.name === p.name);
  const where = twin ? ` (${deg(p.lat, "N", "S", 0)} ${deg(p.lon, "E", "W", 0)})` : "";
  const at = `${deg(p.launch_lat, "N", "S", 1)} ${deg(p.launch_lon, "E", "W", 1)}`;
  const same = all.filter((q) => q !== p && q.launch_lat === p.launch_lat && q.launch_lon === p.launch_lon).map((q) => q.name);
  const shared = same.length ? `, same start as ${[...new Set(same)].join(", ")}` : "";
  return `${p.name}${where}, launched ${Math.round(p.launch_km)} km out by water at ${at}${shared}`;
}
