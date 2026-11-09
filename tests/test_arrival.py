"""Microtransat finish and start rules (runner/arrival.py)."""

from datetime import datetime, timedelta

import pytest

from boatsim.runner.arrival import (
    EAST_LINE,
    WEST_LINE,
    FinishTarget,
    SilenceClock,
    crosses,
)


def test_default_target_is_on_the_eastern_line():
    t = FinishTarget()
    assert (t.lat, t.lon) == (39.5, -13.5)


def test_target_off_the_line_is_refused():
    with pytest.raises(ValueError):
        FinishTarget(39.5, -9.6)  # the Portuguese coast is east of the line


def test_finish_only_inside_25_km():
    t = FinishTarget()
    assert t.reached(39.5, -13.5)
    assert t.reached(39.6, -13.5)  # ~11 km north
    assert not t.reached(39.8, -13.5)  # ~33 km north


def test_azores_and_portugal_are_not_finishes():
    t = FinishTarget()
    assert not t.reached(38.7, -27.2)  # Terceira
    assert not t.reached(38.7, -9.1)  # Lisbon


def test_drop_point_is_west_of_the_start_line_and_crossing_is_seen():
    # Sailing east from the drop point along 36.85N crosses the western line near 68.8W.
    assert crosses(WEST_LINE, (36.85, -69.0), (36.85, -68.5))
    assert not crosses(WEST_LINE, (36.85, -75.7), (36.85, -75.0))


def test_eastern_line_crossing():
    assert crosses(EAST_LINE, (40.0, -14.0), (40.0, -13.0))  # the 44.5N-37N leg at 13.5W
    assert not crosses(EAST_LINE, (40.0, -30.0), (40.0, -29.0))


def test_silence_rules():
    t0 = datetime(2020, 5, 1)
    c = SilenceClock(t0)
    c.heard(t0)
    assert c.disqualified(t0 + timedelta(days=10)) is None
    assert "in a row" in c.disqualified(t0 + timedelta(days=10, hours=1))

    c = SilenceClock(t0)
    # Heard every 4th day: gaps of 3 silent days, never 10 in a row.
    for d in range(0, 40, 4):
        c.heard(t0 + timedelta(days=d, hours=12))
    assert c.disqualified(t0 + timedelta(days=20, hours=13)) is None  # 15 silent days so far
    assert "in total" in c.disqualified(t0 + timedelta(days=22, hours=13))
