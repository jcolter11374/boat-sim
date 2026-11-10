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
    uint8   status flags (see Status below; 0 = all normal)

Status bits (pinned 10 Nov 2026 for the live tracker feed; the firmware must
set the same bits):

    bit 0  SAFE_MODE      safe mode has taken over from normal route following
    bit 1  LOST_COMMS     no message from base for 5 days: heading east alone
    bit 2  MOTORS_OFF     motors stopped to save a low battery
    bit 3  ONE_THRUSTER   one thruster has failed; steering on the other
    bit 4  SAFE_BOX_DOWN  the backup (safe) electronics box is dead: main is
                          reporting with no backup. There is no "main box
                          down" bit, because the Iridium modem lives in the
                          main box: if main dies, only beacon pings arrive.
    bits 5-7              reserved, always 0

Owner: Sam.
"""

from __future__ import annotations

import struct
from datetime import UTC, datetime
from enum import IntFlag

REPORT_FORMAT = "<IiiBHB"
REPORT_BYTES = struct.calcsize(REPORT_FORMAT)


class Status(IntFlag):
    SAFE_MODE = 1 << 0
    LOST_COMMS = 1 << 1
    MOTORS_OFF = 1 << 2
    ONE_THRUSTER = 1 << 3
    SAFE_BOX_DOWN = 1 << 4


STATUS_MASK = 0b0001_1111  # bits 5-7 reserved


def decode_status(flags: int) -> dict[str, bool]:
    """Status byte -> {"safe_mode": bool, ...}, one key per defined bit."""
    if flags & ~STATUS_MASK & 0xFF:
        raise ValueError(f"reserved status bits set: {flags:#04x}")
    return {s.name.lower(): bool(flags & s) for s in Status}


def encode_status(status: dict[str, bool]) -> int:
    """Inverse of decode_status. Unknown names are an error, not ignored."""
    flags = 0
    for name, on in status.items():
        try:
            bit = Status[name.upper()]
        except KeyError:
            raise ValueError(f"unknown status bit {name!r}") from None
        if on:
            flags |= bit
    return int(flags)


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
        _flags(report.get("flags", 0)),
    )


def _flags(flags: int) -> int:
    flags = int(flags)
    if not 0 <= flags <= STATUS_MASK:
        raise ValueError(f"status flags out of range or reserved bits set: {flags:#x}")
    return flags


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
        "status": decode_status(flags),
    }
