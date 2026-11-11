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

/** "Boston, launched 35 km out by water" (with the position when two share a name). */
export function portLabel(p: Port, all: Port[]): string {
  const twin = all.some((q) => q !== p && q.name === p.name);
  const where = twin ? ` (${Math.abs(p.lat).toFixed(0)}°${p.lat >= 0 ? "N" : "S"} ${Math.abs(p.lon).toFixed(0)}°${p.lon < 0 ? "W" : "E"})` : "";
  return `${p.name}${where}, launched ${Math.round(p.launch_km)} km out by water`;
}
