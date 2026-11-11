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
    link = IridiumSBDLink()
    assert _delivery_rate(link, CALM) > 0.999  # 8 tries at 85%
    delays = [e.t_delivered - e.t_sent for e in link.ledger if e.t_delivered]
    assert np.median(delays) < timedelta(minutes=1)


def test_rough_seas_lose_more_messages():
    calm = _delivery_rate(IridiumSBDLink(), CALM)
    mid = _delivery_rate(IridiumSBDLink(), EnvState(hs=4.0))
    rough_link = IridiumSBDLink()
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
    link = IridiumSBDLink(p_try_calm=1.0, mailbox="scheduled", mailbox_every=timedelta(hours=6))
    t = datetime(2020, 10, 1, 7, 30, tzinfo=UTC)  # next 6-hourly check is 12:00
    done = link.send(_msg(t, "down", 60), CALM, np.random.default_rng(0))
    assert done == datetime(2020, 10, 1, 12, 0, 40, tzinfo=UTC)
    daily = IridiumSBDLink(p_try_calm=1.0, mailbox="scheduled")  # once a day at 00:00 UTC
    done = daily.send(_msg(t, "down", 60), CALM, np.random.default_rng(0))
    assert done == datetime(2020, 10, 2, 0, 0, 40, tzinfo=UTC)


def test_default_mailbox_rides_on_the_next_report_session():
    """Default: the boat only collects base messages in its daily report session."""
    link = IridiumSBDLink(p_try_calm=1.0)
    rng = np.random.default_rng(0)
    report_t = datetime(2020, 10, 1, 14, 0, tzinfo=UTC)
    link.send(_msg(report_t, "up", 16), CALM, rng)
    reply_t = report_t + timedelta(minutes=1)  # base answers straight away
    done = link.send(_msg(reply_t, "down", 24), CALM, rng)
    assert done == datetime(2020, 10, 2, 14, 0, 40, tzinfo=UTC)  # with tomorrow's report
    cost = link.voyage_cost_usd(report_t, report_t + timedelta(days=10))
    assert cost["empty_mailbox_checks"] == 0.0


def test_no_spending_cap_by_default():
    link = IridiumSBDLink(p_try_calm=1.0)
    rng = np.random.default_rng(0)
    sent = [link.send(_msg(T0 + timedelta(minutes=i), size=40), CALM, rng) for i in range(500)]
    assert all(s is not None for s in sent)
    assert link.monthly_summary()["2020-10"]["usd"] == round(17.0 + 500 * 0.12, 2)


def test_voyage_cost_is_itemised():
    link = IridiumSBDLink(p_try_calm=1.0, mailbox="scheduled")
    rng = np.random.default_rng(0)
    start = datetime(2020, 10, 15, 12, tzinfo=UTC)
    end = datetime(2020, 12, 3, 12, tzinfo=UTC)  # touches Oct, Nov, Dec
    for d in range(49):
        link.send(_msg(start + timedelta(days=d), size=90), CALM, rng)  # 2 credits each
    link.send(_msg(start, "down", 40), CALM, rng)  # one route from base
    cost = link.voyage_cost_usd(start, end)
    assert cost["line_rental"] == 3 * 17.0
    assert cost["messages"] == round(49 * 2 * 0.12 + 0.12, 2)
    assert cost["empty_mailbox_checks"] == round((49 - 1) * 0.12, 2)  # 49 daily checks
    assert cost["total"] == round(
        cost["line_rental"] + cost["messages"] + cost["empty_mailbox_checks"], 2
    )


def test_optional_cap_refuses_then_resets_next_month():
    # $42 cap - $17 rental = $25 = 208 one-credit messages at $0.12.
    link = IridiumSBDLink(p_try_calm=1.0, monthly_budget_usd=42.0)
    rng = np.random.default_rng(0)
    sent = [link.send(_msg(T0 + timedelta(minutes=i), size=40), CALM, rng) for i in range(250)]
    assert sum(s is not None for s in sent) == 208
    assert link.ledger[-1].status == "over_budget"
    assert link.spent_usd("2020-10") <= 25.0
    assert link.send(_msg(datetime(2020, 11, 1, tzinfo=UTC), size=40), CALM, rng) is not None
    oct_ = link.monthly_summary()["2020-10"]
    assert oct_["up"] == 208 and oct_["over_budget"] == 42 and oct_["usd"] <= 42.0


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


def test_full_voyage_daily_reports_get_through_and_are_costed():
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
    cost = link.voyage_cost_usd(log.start, log.end)
    # ~2.5 months of rental plus a few dollars of credits for daily reports.
    assert 30.0 < cost["total"] < 95.0


def test_airtime_counter_counts_messages_and_bills_the_published_plan():
    from boatsim.comms.iridium import LedgerEntry

    link = IridiumSBDLink()
    oct_, nov = T0, T0 + timedelta(days=40)

    def entry(t, direction, size, status="delivered"):
        done = t if status == "delivered" else None
        return LedgerEntry(t, direction, size, 1, 0.12, 1, done, status)

    link.ledger = [
        entry(oct_, "up", 30),
        entry(oct_, "down", 4),  # billed as 10 bytes, the plan's minimum
        entry(oct_, "up", 30, status="lost"),  # never got through: free
        *[entry(nov, "up", 300) for _ in range(20)],  # 6,000 bytes: 1,000 over
    ]
    a = link.airtime(oct_, nov)
    assert a["up"] == {"messages": 21, "bytes": 6030}
    assert a["down"] == {"messages": 1, "bytes": 4}
    assert a["lost"] == 1 and a["months"] == 2 and a["bytes_billed"] == 6040
    usd = a["usd"]
    assert usd["monthly_fees"] == pytest.approx(2 * 15.75)
    assert usd["extra_bytes"] == pytest.approx(1000 * 0.00315)
    assert usd["activation"] == 26.25 and usd["empty_mailbox_checks"] == 0.0
    assert usd["total"] == pytest.approx(31.5 + 3.15 + 26.25)
    # The prepaid estimate the batch runs use is unchanged.
    assert link.voyage_cost_usd(oct_, nov)["line_rental"] == 2 * 17.0
