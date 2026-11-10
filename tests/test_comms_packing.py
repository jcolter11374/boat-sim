"""Packed binary report (issue #72): real byte count, one Iridium credit."""

from datetime import UTC, datetime

import pytest

from boatsim.comms import IridiumSBDLink
from boatsim.comms.packing import (
    REPORT_BYTES,
    Status,
    decode_status,
    encode_status,
    pack_report,
    unpack_report,
)

REPORT = {"t": "2020-10-01T14:00+00:00", "lat": 37.12345, "lon": -61.98765, "soc": 0.734, "hdg": 87}


def test_report_is_16_bytes_and_one_credit():
    data = pack_report(REPORT)
    assert len(data) == REPORT_BYTES == 16
    assert IridiumSBDLink().credits_for(len(data)) == 1
    assert IridiumSBDLink().credits_for(len(str(REPORT))) == 2  # the old text sizing


def test_round_trip_keeps_metre_level_position():
    back = unpack_report(pack_report(REPORT))
    assert abs(back["lat"] - REPORT["lat"]) < 1e-5
    assert abs(back["lon"] - REPORT["lon"]) < 1e-5
    assert back["soc"] == 0.73 and back["hdg"] == 87 and back["flags"] == 0
    assert datetime.fromisoformat(back["t"]) == datetime(2020, 10, 1, 14, 0, tzinfo=UTC)


def test_naive_times_are_treated_as_utc_and_values_are_clamped():
    r = {**REPORT, "t": datetime(2020, 10, 1, 14, 0), "soc": 1.3, "hdg": 360.4, "flags": 5}
    back = unpack_report(pack_report(r))
    assert back["soc"] == 1.0 and back["hdg"] == 0 and back["flags"] == 5
    assert back["t"].startswith("2020-10-01T14:00")


def test_every_status_bit_round_trips_alone_and_together():
    names = [s.name.lower() for s in Status]
    assert names == ["safe_mode", "lost_comms", "motors_off", "one_thruster", "safe_box_down"]
    for bit in Status:
        back = unpack_report(pack_report({**REPORT, "flags": int(bit)}))
        assert back["flags"] == int(bit)
        assert back["status"] == {n: n == bit.name.lower() for n in names}
        assert encode_status(back["status"]) == int(bit)
    every = encode_status({n: True for n in names})
    assert every == 0b0001_1111
    assert unpack_report(pack_report({**REPORT, "flags": every}))["status"] == dict.fromkeys(
        names, True
    )
    assert unpack_report(pack_report(REPORT))["status"] == dict.fromkeys(names, False)


@pytest.mark.parametrize("bad", [1 << 5, 1 << 6, 1 << 7, 0x100, -1])
def test_reserved_or_out_of_range_bits_are_refused(bad):
    with pytest.raises(ValueError):
        pack_report({**REPORT, "flags": bad})
    if 0 <= bad <= 0xFF:
        with pytest.raises(ValueError):
            decode_status(bad)


def test_unknown_status_name_is_an_error():
    with pytest.raises(ValueError):
        encode_status({"main_box_down": True})
