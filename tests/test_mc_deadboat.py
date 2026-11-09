"""Dead-boat drift by drop distance (#90): offline tests on made-up weather."""

from __future__ import annotations

from datetime import datetime

import numpy as np
import pandas as pd
import pytest

from boatsim.config import load_design
from boatsim.geo import distance_m
from boatsim.mc import deadboat as D
from boatsim.oceandata import ConstantEnvironment
from boatsim.types import EnvState

T0 = datetime(2020, 5, 1, 12)


def test_start_points_lie_on_one_line_through_todays_drop():
    lat, lon = D.start_point("drop")
    assert (lat, lon) == pytest.approx((36.85, -75.70), abs=0.01)  # configs/v4_kayak.yaml
    for name, km in D.STARTS_KM.items():
        assert distance_m(*D.CAPE_HENRY, *D.start_point(name)) / 1000 == pytest.approx(km, rel=1e-3)
    lons = [D.start_point(n)[1] for n in D.STARTS_KM]
    assert lons == sorted(lons)  # further out = further east


def test_launches_are_the_1st_and_15th_of_april_to_june():
    ts = D.launches([2019, 2020])
    assert (
        len(ts) == 12 and ts[0] == datetime(2019, 4, 1, 12) and ts[-1] == datetime(2020, 6, 15, 12)
    )


def test_distance_to_land_uses_the_coast_cells():
    coast = np.array([[36.0, -75.0]])
    d = D.distance_to_land_km([36.0, 37.0], [-75.0, -75.0], coast)
    assert d[0] == pytest.approx(0.0) and d[1] == pytest.approx(111.2, rel=0.01)


class _Land:
    def on_land(self, lat, lon):
        return lon < -75.8  # land just west of the drop point


def test_dead_boat_blown_ashore_stops_and_counts_near_land_time():
    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(EnvState(wind_u=-10.0, ghi=0.0))  # wind from the east
    r = D.run_one(env, design, T0, "drop", days=5, land=_Land())
    assert r["aground"] and r["aground_lon"] < -75.8
    assert 0 < r["aground_day"] < 5 and not r["gulf_stream"]
    assert r["days_near_land"] == pytest.approx(r["aground_day"], abs=0.05)


def test_dead_boat_carried_east_reaches_the_gulf_stream():
    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(EnvState(current_u=1.5, ghi=0.0))
    r = D.run_one(env, design, T0, "shelf", days=5, land=_Land())
    assert not r["aground"] and r["gulf_stream"]
    assert r["gulf_stream_day"] == pytest.approx(
        distance_m(36.59, -74.73, 36.59, -72.0) / 1.5 / 86400, rel=0.2
    )


def test_report_has_one_row_per_start_point():
    rows = []
    for name in D.STARTS_KM:
        for k in range(4):
            ashore = name == "drop" and k < 3
            rows.append(
                {
                    "start_point": name,
                    "start_km": D.STARTS_KM[name],
                    "start": T0,
                    "year": 2020,
                    "aground": ashore,
                    "aground_day": 3.0 if ashore else np.nan,
                    "aground_lat": 37.0,
                    "aground_lon": -76.3,
                    "gulf_stream": name == "shelf",
                    "gulf_stream_day": 6.0 if name == "shelf" else np.nan,
                    "days_near_land": 3.0,
                }
            )
    md = D.report_markdown(pd.DataFrame(rows))
    assert "| Today's drop (29 km, 15.6 nm) | 4 | 3 (75%) | 3.0 |" in md
    assert "| Shelf edge (about 120 km) | 4 | 0 (0%) |  | 4 (100%) | 6.0 |" in md
    header, sep = [ln for ln in md.splitlines() if ln.startswith("|")][:2]
    assert header.count("|") == sep.count("|")
