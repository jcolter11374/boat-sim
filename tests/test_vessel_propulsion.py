import pytest

from boatsim.vessel.hull import G
from boatsim.vessel.propulsion import (
    T200_FULL_POWER_W,
    ThrusterParams,
    fitted_efficiency,
    thrust_one,
    total_thrust,
)

P = ThrusterParams()


def test_reproduces_datasheet_full_throttle_point():
    # Blue Robotics T200, 12 V: 3.71 kgf forward at 205 W
    t = thrust_one(P, T200_FULL_POWER_W, 0.0)
    assert t / G == pytest.approx(3.71, rel=0.01)
    assert 0.3 < fitted_efficiency() < 0.4


def test_thrust_falls_with_speed_and_never_beats_energy():
    p = 14.0
    t0 = thrust_one(P, p, 0.0)
    t1 = thrust_one(P, p, 0.9)
    assert t1 < t0
    assert t1 * 0.9 <= P.efficiency * p  # useful power can't exceed shaft power


def test_zero_power_or_no_thrusters():
    assert thrust_one(P, 0.0, 1.0) == 0.0
    assert total_thrust(P, 30.0, 1.0, 0) == 0.0


def test_two_thrusters_beat_one_at_same_total_power():
    assert total_thrust(P, 28.0, 0.9, 2) > total_thrust(P, 28.0, 0.9, 1)


def test_config_splits_max_drive_between_thrusters():
    p = ThrusterParams.from_config({"thruster_count": 2, "max_drive_w": 100})
    assert p.max_power_each_w == 50.0
