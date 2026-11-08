"""Iridium SBD and Globalstar link model (issue #16)."""

from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from boatsim.autonomy import WaypointAutopilot
from boatsim.basestation import HoldCoursePolicy
from boatsim.comms import GlobalstarPinger, IridiumSBDLink
from boatsim.config import load_design
from boatsim.oceandata import ConstantEnvironment, PerfectForecast
from boatsim.runner import Components, simulate
from boatsim.runner.simulate import default_mission
from boatsim.types import EnvState, EventKind, Message
from boatsim.vessel import KinematicVessel

T0 = datetime(2020, 10, 1, 12, 0, tzinfo=UTC)
CALM = EnvState(hs=0.5)
ROUGH = EnvState(hs=6.0)


def _msg(t=T0, direction="up", size=100):
    return Message(t, direction, {}, size)


def _delivery_rate(link, env, n=2000, seed=1):
    rng = np.random.default_rng(seed)
    ok = sum(link.send(_msg(T0 + timedelta(hours=i)), env, rng) is not None for i in range(n))
    return ok / n


def test_size_limits_are_enforced():
    link = IridiumSBDLink()
    rng = np.random.default_rng(0)
    with pytest.raises(ValueError):
        link.send(_msg(size=341), CALM, rng)
    with pytest.raises(ValueError):
        link.send(_msg(direction="down", size=271), CALM, rng)
    link.send(_msg(size=340), CALM, rng)
    link.send(_msg(direction="down", size=270), CALM, rng)


def test_credits_are_per_50_bytes_or_part():
    link = IridiumSBDLink()
    assert [link.credits_for(n) for n in (1, 50, 51, 100, 340)] == [1, 1, 2, 2, 7]


def test_calm_seas_almost_always_get_through_quickly():
    link = IridiumSBDLink(monthly_budget_usd=1e9)
    assert _delivery_rate(link, CALM) > 0.999  # 8 tries at 85%
    delays = [e.t_delivered - e.t_sent for e in link.ledger if e.t_delivered]
    assert np.median(delays) < timedelta(minutes=1)


def test_rough_seas_lose_more_messages():
    calm = _delivery_rate(IridiumSBDLink(monthly_budget_usd=1e9), CALM)
    mid = _delivery_rate(IridiumSBDLink(monthly_budget_usd=1e9), EnvState(hs=4.0))
    rough_link = IridiumSBDLink(monthly_budget_usd=1e9)
    rough = _delivery_rate(rough_link, ROUGH)
    assert calm > mid > rough
    # 8 tries at 0.85 x 0.3 = 25.5% each: ~90% eventually delivered, with real delays.
    assert 0.85 < rough < 0.95
    delays = [e.t_delivered - e.t_sent for e in rough_link.ledger if e.t_delivered]
    assert np.mean(delays) > timedelta(minutes=30)


def test_failed_tries_are_not_billed():
    link = IridiumSBDLink(p_try_calm=0.0)
    assert link.send(_msg(), CALM, np.random.default_rng(0)) is None
    assert link.ledger[-1].status == "lost"
    assert link.spent_usd("2020-10") == 0.0


def test_downlink_waits_for_the_next_mailbox_check():
    link = IridiumSBDLink(p_try_calm=1.0)
    t = datetime(2020, 10, 1, 7, 30, tzinfo=UTC)  # next 6-hourly check is 12:00
    done = link.send(_msg(t, "down", 60), CALM, np.random.default_rng(0))
    assert done == datetime(2020, 10, 1, 12, 0, 40, tzinfo=UTC)


def test_budget_refuses_then_resets_next_month():
    # $40 budget - $15 rental = $25 = 208 one-credit messages at $0.12.
    link = IridiumSBDLink(p_try_calm=1.0)
    rng = np.random.default_rng(0)
    sent = [link.send(_msg(T0 + timedelta(minutes=i), size=40), CALM, rng) for i in range(250)]
    assert sum(s is not None for s in sent) == 208
    assert link.ledger[-1].status == "over_budget"
    assert link.spent_usd("2020-10") <= 25.0
    assert link.send(_msg(datetime(2020, 11, 1, tzinfo=UTC), size=40), CALM, rng) is not None
    oct_ = link.monthly_summary()["2020-10"]
    assert oct_["up"] == 208 and oct_["over_budget"] == 42 and oct_["usd"] <= 40.0


def test_globalstar_redundant_copies_help_and_rough_seas_hurt():
    g = GlobalstarPinger()
    single = GlobalstarPinger(copies=1)
    assert g.p_received(CALM) > single.p_received(CALM)
    assert g.p_received(ROUGH) < g.p_received(CALM)
    rng = np.random.default_rng(2)
    got = [g.ping(T0, 37.0, -60.0, CALM, rng) for _ in range(1000)]
    rate = sum(r is not None for r in got) / 1000
    assert abs(rate - g.p_received(CALM)) < 0.03
    assert len(g.pings) == 1000
    assert next(r for r in got if r) == {
        "t": T0.isoformat(timespec="minutes"),
        "lat": 37.0,
        "lon": -60.0,
    }


def test_full_voyage_daily_reports_stay_inside_budget():
    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(EnvState(ghi=1000.0, hs=2.0))
    link = IridiumSBDLink()
    c = Components(
        env,
        PerfectForecast(env),
        KinematicVessel(design),
        WaypointAutopilot(),
        link,
        HoldCoursePolicy(),
    )
    log = simulate(c, T0, 36.85, -75.7, default_mission(), seed=4)
    sent = sum(e.kind == EventKind.MESSAGE_SENT for e in log.events)
    assert sent >= 0.95 * int(log.days)
    for month in link.monthly_summary().values():
        assert month["usd"] <= link.monthly_budget_usd
        assert month["over_budget"] == 0
