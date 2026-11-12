"""Channel buoys and beacons near Annapolis for the 3D practice view (backlog item 1, Sam).

A sailor coming into the Severn steers by real marks: green "cans" (flat-topped,
odd numbers) left to port and red "nuns" (cone-topped, even numbers) to starboard,
"red right returning" (US waters are IALA region B). The 3D page draws them where
they really are, in their real shape, colour, number and light rhythm, so they are
never made up.

Source: OpenStreetMap seamarks (``seamark:*`` tags, the OpenSeaMap scheme),
fetched with the Overpass API. In US waters these were largely imported from the
USCG Light List. ODbL, credited "(c) OpenStreetMap contributors" on the page, as
for the Annapolis buildings (THIRD_PARTY_NOTICES.md). The USCG and NOAA chart
sites are not reachable from thread sandboxes, and Overpass isn't either, so this
runs on a GitHub runner (.github/workflows/seamarks.yml). Display only: nothing in
the simulator reads it.

    python -m boatsim.oceandata.seamarks --out sea3d/public/seamarks-annapolis.json
    python -m boatsim.oceandata.seamarks --from raw.json --out ...   # offline, from a saved reply

Each mark: lat, lon, kind ("buoy" floats and leans; "beacon" is fixed on a pile),
side ("port" green, "starboard" red, "safe" red-and-white, "special" yellow, or
"other"), shape (can, conical, pillar, spar, sphere, pile, ...), colours, name, and
light (colour, character such as "Fl" or "Q", group, period in seconds) or None.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
# The Severn River mouth, Annapolis harbour and the Bay off it to Thomas Point:
# the practice courses (sea3d/src/helm/course.ts) and the run to the light.
BBOX = (38.86, -76.52, 39.02, -76.36)  # south, west, north, east
TYPES = (
    "buoy_lateral",
    "beacon_lateral",
    "buoy_safe_water",
    "buoy_special_purpose",
    "buoy_cardinal",
    "buoy_isolated_danger",
    "beacon_special_purpose",
)
OUT = Path(__file__).resolve().parents[3] / "sea3d" / "public" / "seamarks-annapolis.json"
SOURCE = "OpenStreetMap seamarks (Overpass API), (c) OpenStreetMap contributors, ODbL"


def query(bbox: tuple[float, float, float, float] = BBOX) -> str:
    s, w, n, e = bbox
    sel = "|".join(TYPES)
    return f'[out:json][timeout:60];node["seamark:type"~"^({sel})$"]({s},{w},{n},{e});out body;'


def _num(v: str | None) -> float | None:
    if v is None:
        return None
    m = re.match(r"\s*([0-9]+(?:\.[0-9]+)?)", v)
    return float(m.group(1)) if m else None


def _side(kind: str, t: dict[str, str]) -> str:
    if kind.endswith("_lateral"):
        cat = t.get(f"seamark:{kind}:category", "")
        if cat in ("port", "preferred_channel_port"):
            return "port"
        if cat in ("starboard", "preferred_channel_starboard"):
            return "starboard"
        # No category: fall back on the colour, region B (green port, red starboard).
        col = t.get(f"seamark:{kind}:colour", "")
        return (
            "port" if col.startswith("green") else "starboard" if col.startswith("red") else "other"
        )
    if kind == "buoy_safe_water":
        return "safe"
    if kind.endswith("_special_purpose"):
        return "special"
    return "other"


def mark_from_tags(lat: float, lon: float, t: dict[str, str]) -> dict | None:
    """One seamark from its OSM tags, or None if it isn't a type we draw."""
    kind = t.get("seamark:type", "")
    if kind not in TYPES:
        return None
    shape = t.get(f"seamark:{kind}:shape") or ("pile" if kind.startswith("beacon") else "pillar")
    colours = [c for c in t.get(f"seamark:{kind}:colour", "").split(";") if c]
    light = None
    if "seamark:light:character" in t or "seamark:light:colour" in t:
        light = {
            "colour": t.get("seamark:light:colour", "white").split(";")[0],
            "character": t.get("seamark:light:character", "Fl"),
            "group": t.get("seamark:light:group"),
            "period_s": _num(t.get("seamark:light:period")),
        }
    return {
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "kind": "beacon" if kind.startswith("beacon") else "buoy",
        "side": _side(kind, t),
        "shape": shape,
        "colours": colours,
        "name": t.get("seamark:name") or t.get("name") or "",
        "light": light,
    }


def marks_from_overpass(reply: dict) -> list[dict]:
    out = []
    for el in reply.get("elements", []):
        if el.get("type") != "node":
            continue
        m = mark_from_tags(el["lat"], el["lon"], el.get("tags", {}))
        if m:
            out.append(m)
    out.sort(key=lambda m: (m["lat"], m["lon"]))
    return out


def fetch(bbox: tuple[float, float, float, float] = BBOX) -> dict:
    import requests

    r = requests.post(
        OVERPASS_URL,
        data={"data": query(bbox)},
        timeout=120,
        headers={"User-Agent": "boat-sim seamarks"},
    )
    r.raise_for_status()
    return r.json()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument(
        "--from", dest="src", type=Path, help="a saved Overpass reply instead of fetching"
    )
    ap.add_argument("--raw", type=Path, help="also save the Overpass reply here")
    a = ap.parse_args(argv)
    reply = json.loads(a.src.read_text()) if a.src else fetch()
    if a.raw:
        a.raw.parent.mkdir(parents=True, exist_ok=True)  # the bake step has no runs/seamarks yet
        a.raw.write_text(json.dumps(reply))
    marks = marks_from_overpass(reply)
    if not marks:
        print("no seamarks found: refusing to write an empty file", file=sys.stderr)
        return 1
    doc = {"source": SOURCE, "bbox": list(BBOX), "marks": marks}
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    sides: dict[str, int] = {}
    for m in marks:
        sides[m["side"]] = sides.get(m["side"], 0) + 1
    print(f"{len(marks)} seamarks -> {a.out}: {sides}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
