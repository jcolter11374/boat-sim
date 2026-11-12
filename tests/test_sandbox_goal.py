"""A mission's goal (Sandy's shadow first): the deadline ends the voyage as "goal",
and the game tracks the storm's distance (Rosa and Ravi's seam, 12 Nov 2026)."""

import dataclasses
import io

import pytest
from test_sandbox import _fake_sources

from boatsim.oceandata import challenges as C
from boatsim.sandbox import forcing as F
from boatsim.sandbox import run as R
from boatsim.sandbox.helm import Game


def test_hourly_track_and_storm_at():
    tr = C.hourly([("2020-06-15T12:00:00Z", 30.0, -70.0), ("2020-06-15T18:00:00Z", 33.0, -76.0)])
    assert len(tr) == 7 and tr[3] == ["2020-06-15T15:00:00Z", 31.5, -73.0]
    assert C.storm_at(tr, C._t("2020-06-15T15:30:00Z")) == pytest.approx((31.75, -73.5))
    assert C.storm_at(tr, C._t("2020-06-15T11:00:00Z")) is None


def test_sandy_goal_in_the_catalog_has_rosas_shape():
    g = next(c for c in C.catalog()["challenges"] if c["id"] == "sandys-shadow")["goal"]
    assert g["until"] == "2012-10-31T12:00:00Z" and g["call_day"] == 3
    assert g["storm"]["clear_km"] == 300 and g["storm"]["well_km"] == 400
    assert len(g["storm"]["track"]) == 9 * 24 + 1  # hourly, 22 Oct 12 UTC to 31 Oct 12 UTC
    assert g["stars3"] == {"east_of": -68.0, "battery_min": 0.2}
    assert "goal" not in next(c for c in C.catalog()["challenges"] if c["id"] == "gentle-june")


def test_a_mission_ends_at_its_deadline_as_goal(monkeypatch):
    era5, glorys, ships = _fake_sources()
    buf = io.BytesIO()
    F.cut(2020, buf, era5, glorys, ships, log=lambda *_: None, first=(6, 14), last=(6, 17))
    june = R.open_bundle(buf.getvalue())
    goal = {
        "until": "2020-06-16T00:00:00Z",  # 12 h after the drop
        "storm": {
            "name": "Test",
            "track_6h": [
                ("2020-06-15T12:00:00Z", 34.0, -72.0),
                ("2020-06-16T00:00:00Z", 34.0, -70.0),
            ],
            "clear_km": 300,
            "well_km": 400,
        },
    }
    i = next(k for k, c in enumerate(C.CHALLENGES) if c.id == "gentle-june")
    patched = list(C.CHALLENGES)
    patched[i] = dataclasses.replace(patched[i], goal=goal)
    monkeypatch.setattr(C, "CHALLENGES", patched)
    g = Game(june, challenge="gentle-june")
    assert g.max_days == pytest.approx(0.5)
    s = g.status()["goal"]
    assert s["days_left"] == pytest.approx(0.5) and 100 < s["storm_km"] < 1000
    assert s["closest_km"] == pytest.approx(s["storm_km"])
    g.run(hours=24, ghost_passes=False, land_within_km=None, breakdown=False)
    st = g.status()
    assert st["over"] and st["goal"]["days_left"] == 0.0
    assert st["goal"]["closest_km"] <= s["storm_km"] + 1e-6
    card = g.result()
    assert card["boat"]["outcome"] == "goal" and card["ghost"]["outcome"] == "goal"
    assert card["boat"]["ending"]["headline"] == "Made it"
    h = Game.load(june, g.save())  # a share link replays to the same end
    assert h.status()["goal"]["closest_km"] == pytest.approx(st["goal"]["closest_km"])
