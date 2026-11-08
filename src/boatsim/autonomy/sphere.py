"""Great-circle helpers the guidance code needs and geo.py doesn't have yet.

Kept inside autonomy/ so geo.py (Lead-owned) is untouched. If other packages
need these, move them to geo.py in a Lead-reviewed PR.
"""

from __future__ import annotations

import math

from boatsim.geo import EARTH_RADIUS_M, bearing_deg, distance_m


def destination(lat: float, lon: float, bearing: float, dist_m: float) -> tuple[float, float]:
    """Point reached by sailing dist_m along a great circle from (lat, lon)
    with initial compass bearing `bearing`."""
    d = dist_m / EARTH_RADIUS_M
    p1, l1, b = math.radians(lat), math.radians(lon), math.radians(bearing)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(
        math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2)
    )
    return math.degrees(p2), ((math.degrees(l2) + 180.0) % 360.0) - 180.0


def track_offsets(
    o_lat: float, o_lon: float, d_lat: float, d_lon: float, lat: float, lon: float
) -> tuple[float, float]:
    """Where the boat is relative to the great-circle track from origin to destination.

    Returns (cross_track_m, along_track_m). Cross-track is positive when the boat
    is to the right (starboard) of the track, looking toward the destination.
    Along-track is the distance from the origin measured along the track; it is
    negative if the boat is behind the origin.
    """
    d13 = distance_m(o_lat, o_lon, lat, lon) / EARTH_RADIUS_M
    if d13 == 0.0:
        return 0.0, 0.0
    t13 = math.radians(bearing_deg(o_lat, o_lon, lat, lon))
    t12 = math.radians(bearing_deg(o_lat, o_lon, d_lat, d_lon))
    xt = math.asin(max(-1.0, min(1.0, math.sin(d13) * math.sin(t13 - t12))))
    c = math.cos(d13) / max(math.cos(xt), 1e-12)
    at = math.acos(max(-1.0, min(1.0, c)))
    if math.cos(t13 - t12) < 0:
        at = -at
    return xt * EARTH_RADIUS_M, at * EARTH_RADIUS_M


def wrap180(angle: float) -> float:
    """Wrap an angle difference into -180..180 degrees."""
    return (angle + 180.0) % 360.0 - 180.0
