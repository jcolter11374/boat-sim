"""Distance to land, for hazards that depend on being near a coast.

Inside the route box this uses the shared land mask (runner/land.py: Natural
Earth 1:10m on a 0.02 deg grid, kept in git). The mask is coarsened to 0.1 deg
(about 10 km) and the coastline cells are kept; the distance is to the nearest
coastline cell, good to about +/-10 km. That's what the near-land phase
(within 150 km) and the capture band need.

Outside the box, or if the mask file is missing, it falls back to the old stub:
the distance to the nearest of a few dozen hand-picked coastal points, good to
roughly +/-50 km. Priya's coastline for the arrival rule (#11) is separate.
"""

from __future__ import annotations

import math
from functools import lru_cache

import numpy as np

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


EARTH_RADIUS_KM = 6371.0
COARSE_DEG = 0.1


def distance_to_land_km(lat: float, lon: float) -> float:
    """Distance to the nearest coastline, km (cached on a 0.05 deg grid, ~5 km)."""
    return _cached(round(lat * 20.0), round(lon * 20.0))


@lru_cache(maxsize=1)
def _coast_cells():
    """(lat_rad, lon_rad, cos_lat, box) of 0.1 deg coastline cells, or None."""
    try:
        from boatsim.runner.land import default_land

        m = default_land()
    except (OSError, ValueError):
        m = None
    if m is None:
        return None
    k = max(round(COARSE_DEG / m.res), 1)
    ni, nj = m.nlat // k, m.nlon // k
    land = m.mask[: ni * k, : nj * k].reshape(ni, k, nj, k).any(axis=(1, 3))
    pad = np.pad(land, 1, constant_values=False)
    water_next = ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])
    ii, jj = np.nonzero(land & water_next)
    res = m.res * k
    lat = np.radians(m.lat0 + (ii + 0.5) * res)
    lon = np.radians(m.lon0 + (jj + 0.5) * res)
    box = (m.lat0, m.lat0 + m.nlat * m.res, m.lon0, m.lon0 + m.nlon * m.res)
    return lat, lon, np.cos(lat), box


@lru_cache(maxsize=65536)
def _cached(lat20: int, lon20: int) -> float:
    lat, lon = lat20 / 20.0, lon20 / 20.0
    cells = _coast_cells()
    if cells is not None:
        clat, clon, ccos, box = cells
        if box[0] <= lat <= box[1] and box[2] <= lon <= box[3] and clat.size:
            p, q = math.radians(lat), math.radians(lon)
            h = np.sin((clat - p) / 2.0) ** 2 + math.cos(p) * ccos * np.sin((clon - q) / 2.0) ** 2
            return float(2.0 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(h.min())))
    return min(distance_m(lat, lon, a, b) for a, b in _COAST_POINTS) / 1000.0
