"""Rough distance to land, for hazards that only happen near a coast.

STUB until Priya's real coastline lands (issue #11). This is the distance to
the nearest of a few dozen hand-picked coastal points, good to roughly +/-50 km.
That's fine for "within 50 or 100 km of land" tests, and useless for anything finer.
"""

from __future__ import annotations

from functools import lru_cache

from boatsim.geo import distance_m

# (lat, lon) points on coasts the route can come near. Roughly 100-200 km apart.
_COAST_POINTS = [
    # North American east coast, Florida to Newfoundland
    (27.0, -80.1),
    (30.0, -81.3),
    (32.0, -80.8),
    (33.8, -78.5),
    (35.2, -75.5),
    (36.9, -75.9),
    (38.4, -75.1),
    (39.6, -74.2),
    (40.6, -73.0),
    (41.3, -71.0),
    (42.0, -70.0),
    (43.6, -70.2),
    (44.5, -67.5),
    (44.0, -65.5),
    (45.3, -61.0),
    (46.8, -60.3),
    (46.6, -53.1),
    (48.5, -53.0),
    (51.0, -55.8),
    # Bermuda, Azores, Madeira, Canaries
    (32.3, -64.8),
    (39.4, -31.2),
    (38.6, -28.4),
    (38.7, -27.2),
    (37.8, -25.5),
    (36.95, -25.1),
    (32.7, -16.9),
    (28.3, -16.5),
    (28.5, -13.9),
    # Europe, Gibraltar to Norway
    (36.0, -5.6),
    (37.0, -8.9),
    (38.7, -9.5),
    (40.2, -8.9),
    (41.8, -8.9),
    (43.0, -9.3),
    (43.5, -6.0),
    (43.4, -2.0),
    (45.0, -1.3),
    (46.5, -1.8),
    (47.8, -4.4),
    (48.4, -5.1),
    (49.7, -1.9),
    (50.0, -5.2),
    (50.6, -3.4),
    (51.4, -10.0),
    (51.6, -8.5),
    (52.7, -9.9),
    (54.3, -10.1),
    (55.2, -7.0),
    (56.5, -6.3),
    (58.2, -6.5),
    (58.6, -3.0),
    (60.4, 5.0),
    (62.5, 6.0),
]


def distance_to_land_km(lat: float, lon: float) -> float:
    """Approximate distance to the nearest listed coastal point, km (cached on a
    0.05 deg grid, ~5 km, well inside the stub's own error)."""
    return _cached(round(lat * 20.0), round(lon * 20.0))


@lru_cache(maxsize=65536)
def _cached(lat20: int, lon20: int) -> float:
    lat, lon = lat20 / 20.0, lon20 / 20.0
    return min(distance_m(lat, lon, a, b) for a, b in _COAST_POINTS) / 1000.0
