"""The weather-challenge stars judge (sandbox.stars) on made-up tracks."""

from datetime import datetime, timedelta

import pytest

from boatsim.sandbox.stars import SANDY, centre_at, closest_km, judge, storm_track

T0 = datetime(2012, 10, 22, 12)  # noqa: DTZ001 (the simulator runs on naive UTC)
# A storm heading due north along 74W, 1 degree of latitude every 6 hours.
STORM = [(T0 + timedelta(hours=6 * i), 30.0 + i, -74.0) for i in range(12)]


def rows(lon_end: float, soc_low: float = 0.5, lat: float = 38.0, lon0: float = -70.0):
    out = []
    for h in range(9 * 24 + 1):
        f = h / (9 * 24)
        out.append(
            {
                "t": T0 + timedelta(hours=h),
                "lat": lat,
                "lon": lon0 + f * (lon_end - lon0),
                "soc": soc_low if h == 100 else 0.8,
            }
        )
    return out


def test_the_centre_is_interpolated_between_best_track_points():
    assert centre_at(STORM, T0 + timedelta(hours=3)) == pytest.approx((30.5, -74.0))
    assert centre_at(STORM, T0 - timedelta(hours=1)) is None
    assert centre_at(STORM, STORM[-1][0] + timedelta(hours=1)) is None


def test_closest_approach_counts_every_hour_not_just_the_6_hourly_points():
    # A boat that sits at 33.5N 73W: the storm passes 33.5N at hour 21, between two points.
    r = [{"t": T0 + timedelta(hours=h), "lat": 33.5, "lon": -73.0} for h in range(48)]
    assert closest_km(r, STORM) == pytest.approx(92.8, abs=1.0)


def test_stars_stack_and_three_needs_the_right_way_and_battery():
    far = rows(-66.0)  # ends east of 68W, starts 4 degrees of longitude from the storm
    assert judge(far, "at_sea", STORM, SANDY)["stars"] == 3
    assert judge(rows(-66.0, soc_low=0.1), "at_sea", STORM, SANDY)["stars"] == 2  # flat-ish battery
    assert (
        judge(rows(-69.0, lon0=-69.5), "at_sea", STORM, SANDY)["stars"] == 2
    )  # not far enough east
    assert judge(far, "lost", STORM, SANDY)["stars"] == 0  # not sailing at the end: no goal
    # Inside the clear distance but outside the goal distance: one star.
    near = rows(-66.0, lon0=-70.0, lat=38.0)
    for r in near:
        r["lon"] = -70.8  # about 280 km from 74W at 38N
    j = judge(near, "at_sea", STORM, SANDY)
    assert SANDY.goal_km < j["closest_km"] < SANDY.clear_km and j["stars"] == 1


def test_storm_track_reads_one_storm_from_an_ibtracs_csv(tmp_path):
    p = tmp_path / "ib.csv"
    p.write_text(
        "SID,SEASON,NAME,ISO_TIME,LAT,LON\n"
        " ,Year, , ,degrees_north,degrees_east\n"
        "a,2012,SANDY,2012-10-22 18:00:00,14.3,-77.4\n"
        "a,2012,SANDY,2012-10-22 12:00:00,13.9,-77.5\n"
        "b,2012,TONY,2012-10-22 12:00:00,30.0,-50.0\n"
        "c,2005,SANDY,2005-09-01 12:00:00,20.0,-60.0\n"
    )
    t = storm_track(p, "SANDY", 2012)
    assert [x[1] for x in t] == [13.9, 14.3]  # in time order, one storm, one season
