import pytest

from boatsim.geo import bearing_deg, distance_m, move


def test_one_degree_latitude_is_60_nm():
    assert distance_m(0, 0, 1, 0) == pytest.approx(111_195, rel=1e-3)


def test_bearing_due_east_on_equator():
    assert bearing_deg(0, 0, 0, 1) == pytest.approx(90.0)


def test_move_round_trip():
    lat, lon = move(37.0, -75.0, 1000.0, 1000.0)
    assert distance_m(37.0, -75.0, lat, lon) == pytest.approx(1414.2, rel=1e-3)
