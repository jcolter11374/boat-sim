"""Binary packing for the daily position report, so its size is the real one.

The boat sends its report as a packed binary record, not text. Iridium bills
1 credit per 50 bytes, so a 16-byte record costs 1 credit where the ~83-byte
text version cost 2.

Layout (little-endian, 16 bytes):

    uint32  time, seconds since 1970-01-01 UTC
    int32   latitude,  1e-5 degrees (about 1 m)
    int32   longitude, 1e-5 degrees
    uint8   battery charge, percent
    uint16  heading, degrees
    uint8   status flags (bit meanings set by the firmware; 0 = all normal)

Owner: Sam.
"""

from __future__ import annotations

import struct
from datetime import UTC, datetime

REPORT_FORMAT = "<IiiBHB"
REPORT_BYTES = struct.calcsize(REPORT_FORMAT)


def _epoch(t: datetime) -> int:
    if t.tzinfo is None:
        t = t.replace(tzinfo=UTC)
    return int(t.timestamp())


def pack_report(report: dict) -> bytes:
    """Pack a runner report dict (t, lat, lon, soc, hdg[, flags]) into bytes."""
    t = report["t"]
    if isinstance(t, str):
        t = datetime.fromisoformat(t)
    return struct.pack(
        REPORT_FORMAT,
        _epoch(t),
        round(report["lat"] * 1e5),
        round(report["lon"] * 1e5),
        max(0, min(100, round(report["soc"] * 100))),
        round(report["hdg"]) % 360,
        int(report.get("flags", 0)) & 0xFF,
    )


def unpack_report(data: bytes) -> dict:
    """Inverse of pack_report, as base would decode it."""
    secs, lat, lon, soc, hdg, flags = struct.unpack(REPORT_FORMAT, data)
    t = datetime.fromtimestamp(secs, tz=UTC)
    return {
        "t": t.isoformat(timespec="minutes"),
        "lat": lat / 1e5,
        "lon": lon / 1e5,
        "soc": soc / 100,
        "hdg": hdg,
        "flags": flags,
    }
