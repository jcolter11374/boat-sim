"""When does a voyage count as arrived?

John's rule (2026-11-08): any landfall in Europe counts, the Azores included.

STUB: crude boxes, not a coastline. Priya replaces this with a real coastline
buffer (e.g. within 12 nm of European land) from Natural Earth or GSHHG.
"""

from __future__ import annotations

from boatsim.geo import distance_m

# (lat_min, lat_max, lon_min, lon_max): rough sea areas next to European coasts.
_EUROPE_BOXES = [
    (36.0, 44.0, -10.5, -8.0),  # Portugal and NW Spain, Atlantic coast
    (43.0, 48.5, -5.0, -1.0),  # Bay of Biscay
    (48.0, 51.5, -6.0, 2.0),  # Brittany, Channel
    (49.5, 59.5, -11.0, -5.0),  # Ireland, west Scotland
    (59.5, 71.0, 4.0, 15.0),  # Norway
]
_AZORES_CENTRE = (38.5, -28.0)
_AZORES_RADIUS_M = 300_000.0  # covers all nine islands


def in_europe(lat: float, lon: float) -> bool:
    if distance_m(lat, lon, *_AZORES_CENTRE) < _AZORES_RADIUS_M:
        return True
    return any(a <= lat <= b and c <= lon <= d for a, b, c, d in _EUROPE_BOXES)
