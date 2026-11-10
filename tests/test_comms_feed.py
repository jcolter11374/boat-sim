"""Live tracker feed (3D roadmap item 3): builder rules and replay mode."""

import json
from datetime import UTC, datetime, timedelta

from boatsim.comms.feed import (
    Tape,
    build_feed,
    decode_uplink,
    ghost,
    record_replay,
    replay_now,
)
from boatsim.comms.packing import Status, pack_report

T0 = datetime(2027, 5, 1, 12, tzinfo=UTC)
DROP = (36.65, -74.94)
FINISH = (39.5, -13.5, 25.0)
OFFSHORE = (38.0, -60.0)
NEAR_LAND = (38.5, -28.4)  # pretend Azores


def _land_km(lat, lon):
    return 5.0 if (lat, lon) == NEAR_LAND else 500.0


def _raw(t, lat, lon, soc=0.8, flags=0):
    return pack_report({"t": t, "lat": lat, "lon": lon, "soc": soc, "hdg": 90, "flags": flags})


def _tape(**kw):
    return Tape(T0, *DROP, FINISH, **kw)


def _feed(tape, now):
    return build_feed(tape, now, land_km=_land_km)


def test_offshore_fix_is_published_when_received():
    t = T0 + timedelta(days=5)
    tape = _tape(uplinks=[(t, t + timedelta(minutes=2), _raw(t, *OFFSHORE))])
    assert _feed(tape, t + timedelta(minutes=1))["fixes"] == []
    f = _feed(tape, t + timedelta(minutes=3))["fixes"]
    assert len(f) == 1 and f[0]["src"] == "iridium" and f[0]["mode"] == "normal"
    assert 0.0 <= f[0]["soc"] <= 1.0


def test_fix_near_land_waits_24_hours_and_so_does_the_route_it_triggered():
    t = T0 + timedelta(days=30)
    tape = _tape(
        uplinks=[(t, t + timedelta(minutes=2), _raw(t, *NEAR_LAND))],
        pings=[(t, t + timedelta(minutes=5), *NEAR_LAND)],
        routes=[
            {
                "sent": t,
                "version": 1,
                "kind": "route",
                "waypoints": [(38.0, -27.0)],
                "near_land": True,
            }
        ],
    )
    early = _feed(tape, t + timedelta(hours=23))
    assert early["fixes"] == [] and early["routes"] == []
    late = _feed(tape, t + timedelta(hours=24, minutes=1))
    assert len(late["fixes"]) == 2 and late["routes"][0]["waypoints"] == [[38.0, -27.0]]


def test_nothing_from_before_the_drop():
    t = T0 - timedelta(days=3)  # shakedown near home
    tape = _tape(
        uplinks=[(t, t + timedelta(minutes=2), _raw(t, 38.9, -76.4))],
        pings=[(t, t, 38.9, -76.4)],
        routes=[{"sent": t, "version": 1, "kind": "ack", "waypoints": [], "near_land": False}],
    )
    feed = _feed(tape, T0 + timedelta(days=1))
    assert feed["fixes"] == [] and feed["routes"] == []


def test_bad_status_byte_keeps_position_and_bad_record_is_skipped():
    t = T0 + timedelta(days=2)
    bad_flags = _raw(t, *OFFSHORE)[:-1] + bytes([0b1110_0000])
    f = decode_uplink(bad_flags)
    assert f["mode"] == "unknown" and f["flags"] is None and abs(f["lat"] - OFFSHORE[0]) < 1e-5
    assert decode_uplink(b"\x01\x02") is None
    tape = _tape(uplinks=[(t, t, bad_flags), (t, t, b"\x01\x02")])
    feed = _feed(tape, t + timedelta(hours=1))
    assert len(feed["fixes"]) == 1
    text = json.dumps(feed)
    assert bad_flags.hex() not in text and "imei" not in text.lower()


def test_status_bits_become_a_mode():
    t = T0 + timedelta(days=2)
    f = decode_uplink(_raw(t, *OFFSHORE, flags=Status.SAFE_MODE | Status.LOST_COMMS))
    assert f["mode"] == "lost_comms" and f["flags"]["lost_comms"]
    assert decode_uplink(_raw(t, *OFFSHORE, flags=Status.SAFE_MODE))["mode"] == "safe"


def test_status_comes_from_fixes_only():
    t = T0 + timedelta(days=40)
    inside = (39.6, -13.6)
    tape = _tape(pings=[(t, t, *inside)])
    assert _feed(tape, t + timedelta(hours=1))["voyage"]["status"] == "finished"
    tape = _tape(pings=[(T0 + timedelta(days=2), T0 + timedelta(days=2), *OFFSHORE)])
    assert _feed(tape, T0 + timedelta(days=5, hours=1))["voyage"]["status"] == "lost_contact"
    assert _feed(tape, T0 + timedelta(days=13))["voyage"]["status"] == "dq"  # >10 days silent
    assert _feed(_tape(), T0 - timedelta(days=1))["voyage"]["status"] == "pre_launch"


def test_acks_carry_no_waypoints():
    t = T0 + timedelta(days=3)
    tape = _tape(
        routes=[{"sent": t, "version": 2, "kind": "ack", "waypoints": [(1, 2)], "near_land": False}]
    )
    assert _feed(tape, t + timedelta(hours=1))["routes"] == [
        {"sent": "2027-05-04T12:00:00Z", "version": 2, "kind": "ack"}
    ]


def test_replay_clock_loops_and_holds_the_end():
    epoch = datetime(2026, 11, 10, tzinfo=UTC)
    assert replay_now(T0, epoch + timedelta(hours=5), epoch, 1.0, 60.0) == T0 + timedelta(days=5)
    assert replay_now(T0, epoch + timedelta(hours=64), epoch, 1.0, 60.0) == T0 + timedelta(days=1)


def test_replay_voyage_feeds_reports_pings_and_a_ghost():
    tape, _ = record_replay(T0, seed=1, max_days=3)
    assert tape.replay and tape.weather == "synthetic"
    now = T0 + timedelta(days=2, hours=13)
    feed = build_feed(tape, now)
    srcs = {f["src"] for f in feed["fixes"]}
    assert srcs == {"iridium", "beacon"}
    assert all(f["t"] <= f["rx"] for f in feed["fixes"])
    assert [f["t"] for f in feed["fixes"]] == sorted(f["t"] for f in feed["fixes"])
    assert feed["voyage"]["status"] == "at_sea" and feed["summary"]["km_sailed"] > 50
    assert feed["voyage"]["near_land_delay"] == {"km": 20.0, "hours": 24.0}
    g = ghost(tape, feed, now, runs=2, days=2)
    assert g["from_fix"] == feed["fixes"][-1]["t"] and len(g["median"]) >= 1
    assert all(len(p) == 4 for p in g["spread"])
