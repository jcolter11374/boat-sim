from datetime import datetime

from boatsim.autonomy import WaypointAutopilot
from boatsim.basestation import HoldCoursePolicy
from boatsim.comms import PerfectLink
from boatsim.config import load_design
from boatsim.mc import run_batch
from boatsim.oceandata import ConstantEnvironment, PerfectForecast
from boatsim.runner import Components, simulate
from boatsim.runner.simulate import default_mission
from boatsim.types import EnvState, Outcome
from boatsim.vessel import KinematicVessel


def _components(env_state=None):
    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(env_state or EnvState(ghi=1000.0))  # endless sun: stub only
    return design, Components(
        env=env,
        forecast=PerfectForecast(env),
        vessel=KinematicVessel(design),
        autopilot=WaypointAutopilot(),
        link=PerfectLink(),
        base=HoldCoursePolicy(),
    )


def test_stub_boat_reaches_azores_in_plausible_time():
    _, c = _components()
    log = simulate(c, datetime(2020, 10, 1), 36.85, -75.7, default_mission())
    assert log.outcome == Outcome.ARRIVED
    # ~2,300 nm at 1.7 kt is ~56 days
    assert 45 < log.days < 70


def test_head_current_stops_progress():
    _, c = _components(EnvState(ghi=1000.0, current_u=-1.0))  # 2 kt foul current
    log = simulate(c, datetime(2020, 10, 1), 36.85, -75.7, default_mission(), max_days=10)
    assert log.outcome == Outcome.TIMEOUT
    assert log.rows[-1]["lon"] < -75.7


def test_batch_reports_rate_and_interval():
    _, c = _components()
    starts = [datetime(2020, 10, 1), datetime(2020, 11, 1)]
    res = run_batch(
        lambda s, seed: simulate(c, s, 36.85, -75.7, default_mission(), seed=seed), starts
    )
    rate, lo, hi = res.success_rate()
    assert rate == 1.0 and lo < 1.0 and hi == 1.0
