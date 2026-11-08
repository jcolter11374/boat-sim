"""Small spherical-earth helpers shared by every package."""

from __future__ import annotations

import math

EARTH_RADIUS_M = 6_371_000.0
KNOT = 0.514444  # m/s
NM = 1852.0  # m


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance (haversine)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial great-circle bearing from point 1 to point 2, compass degrees."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(x, y)) % 360.0


def move(lat: float, lon: float, east_m: float, north_m: float) -> tuple[float, float]:
    """Move a point by a small east/north displacement (fine for 10-minute steps)."""
    dlat = math.degrees(north_m / EARTH_RADIUS_M)
    dlon = math.degrees(east_m / (EARTH_RADIUS_M * math.cos(math.radians(lat))))
    return lat + dlat, ((lon + dlon + 180.0) % 360.0) - 180.0


def heading_to_vector(heading_deg: float, magnitude: float) -> tuple[float, float]:
    """Compass heading and speed -> (east, north) components."""
    h = math.radians(heading_deg)
    return magnitude * math.sin(h), magnitude * math.cos(h)
