"""Resumable voyage (Take the helm): stepping in pieces is the same voyage."""

import pickle
from datetime import UTC, datetime, timedelta

from boatsim.comms.feed import SyntheticWeather
from boatsim.config import load_design
from boatsim.runner import Voyage, simulate
from boatsim.runner.land import default_land
from boatsim.runner.simulate import default_mission, standard_components

T0 = datetime(2020, 5, 1, 12, tzinfo=UTC)
DESIGN = load_design("configs/v4_kayak.yaml")


def _components(seed):
    env = SyntheticWeather(seed, T0)
    return standard_components(DESIGN, env, env, seed=seed, land=default_land())


def _blob(log):
    return pickle.dumps(
        (
            log.outcome,
            log.end,
            log.t_start_line,
            log.t_finish_line,
            [sorted(r.items()) for r in log.rows],
            [(e.t, e.kind, e.detail) for e in log.events],
        )
    )


def test_paused_and_resumed_voyage_is_identical_to_one_run():
    one = simulate(_components(4), T0, 36.65, -74.94, default_mission(), seed=4, max_days=20)
    v = Voyage(_components(4), T0, 36.65, -74.94, default_mission(), seed=4, max_days=20)
    t, stops = T0, 0
    while not v.done:
        t += timedelta(hours=7, minutes=13)  # deliberately off the step grid
        v.run_until(t)
        stops += 1
    assert stops > 50
    assert _blob(v.log) == _blob(one)


def test_run_until_stops_at_the_time_and_does_not_overrun():
    v = Voyage(_components(5), T0, 36.65, -74.94, default_mission(), seed=5, max_days=5)
    v.run_until(T0 + timedelta(hours=6))
    assert v.state.t == T0 + timedelta(hours=6) and not v.done
    v.run_until(T0 + timedelta(hours=6))  # already there: no step
    assert v.state.t == T0 + timedelta(hours=6)
    v.run_until(T0 + timedelta(days=30))  # past max_days: times out once
    assert v.done and v.log.events[-1].kind.name == "TIMEOUT"
    n = len(v.log.events)
    assert v.step() and len(v.log.events) == n
