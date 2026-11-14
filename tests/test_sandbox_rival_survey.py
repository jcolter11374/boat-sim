"""The ghost survey (M5 piece G1): a fixed order against the ghost, tallied as the results card would."""

import io

import pytest
from test_sandbox import _fake_sources
from test_sandbox_helm import MAY1

from boatsim.sandbox import forcing as F
from boatsim.sandbox import rival_survey as S
from boatsim.sandbox import run as R

DAYS = 1.5  # game days: long enough for the two boats to part, short enough for a PR check


@pytest.fixture(scope="module")
def env():
    era5, glorys, ships = _fake_sources()
    buf = io.BytesIO()
    F.cut(2020, buf, era5, glorys, ships, log=lambda *_: None, first=(5, 1), last=(5, 4))
    return R.open_bundle(buf.getvalue())


def test_no_order_is_the_ghosts_own_voyage(env):
    r = S.play(env, None, None, 0.0, launch_index=MAY1, max_days=DAYS)
    assert r["boat"]["outcome"] == r["ghost"]["outcome"]
    assert r["boat"]["days"] == r["ghost"]["days"]
    assert r["orders"] == []


def test_a_fixed_order_is_given_once_and_sails_a_different_voyage(env):
    r = S.play(env, None, "finish", 0.5, launch_index=MAY1, max_days=DAYS)
    assert [(o["heading"], o["power"]) for o in r["orders"]] == [("finish", 0.5)]
    assert r["verdict"] in S.VERDICTS


def test_survey_plays_every_order_on_every_day(monkeypatch):
    played = []

    def fake(env, day, heading, power, **kw):
        played.append((day, heading, power))
        won = heading == "finish"
        return {
            "verdict": "won" if won else "draw",
            "margin_days": 3.0 if won else 0.0,
            "boat": {"outcome": "arrived", "days": 57.0 if won else 60.0},
            "ghost": {"outcome": "arrived", "days": 60.0},
        }

    monkeypatch.setattr(S, "play", fake)
    days = ["2020-04-01", "2020-04-05"]
    orders = (S.FIXED_ORDERS[0], S.FIXED_ORDERS[3])
    seen = []
    res = S.survey(None, days, orders=orders, log=seen.append)
    assert played == [(d, o[1], o[2]) for d in days for o in orders]
    assert seen == res["rows"] and len(seen) == 4
    assert (
        res["orders"]["no order"]["draw"] == 2 and res["orders"]["finish, half power"]["won"] == 2
    )
    assert S.unfair(res["orders"]) == [
        "'finish, half power' beats the ghost on 2 of the 2 days it finishes"
    ]
    assert "the one order" in S.table(res["orders"]) and "+3.0" in S.table(res["orders"])


def _rows(verdicts_and_margins, order="finish, half power"):
    return [
        {"day": f"d{i}", "order": order, "verdict": v, "margin_days": m, "ghost": g}
        for i, (v, m, g) in enumerate(verdicts_and_margins)
    ]


def test_summary_counts_and_the_fairness_target():
    # The ghost finishes 4 days; the fixed order beats it on 3 of them: not fair.
    rows = _rows(
        [
            ("won", 2.0, "arrived"),
            ("won", 6.0, "arrived"),
            ("won", 3.0, "arrived"),
            ("lost", -1.0, "arrived"),
            ("neither_finished", None, "lost"),
        ]
    )
    s = S.summarise(rows)["finish, half power"]
    assert (s["won"], s["lost"], s["draw"], s["neither_finished"]) == (3, 1, 0, 1)
    assert s["ghost_finished"] == 4 and s["both_finished"] == 4
    assert s["median_margin_days"] == 2.5 and s["win_share"] == 0.75
    assert S.unfair({"finish, half power": s}) == [
        "'finish, half power' beats the ghost on 3 of the 4 days it finishes"
    ]
    # One win in four, the middle margin behind: a fair rival.
    fair = S.summarise(
        _rows(
            [
                ("won", 0.8, "arrived"),
                ("lost", -2.0, "arrived"),
                ("lost", -3.0, "arrived"),
                ("draw", 0.1, "arrived"),
            ]
        )
    )
    assert S.unfair(fair) == []
    # Few wins, but far ahead in the middle: still flagged.
    far = S.summarise(
        _rows(
            [
                ("won", 5.0, "arrived"),
                ("draw", 1.5, "arrived"),
                ("draw", 1.2, "arrived"),
                ("lost", -0.2, "arrived"),
            ]
        )
    )
    assert S.unfair(far) == [
        "'finish, half power' finishes 1.4 days ahead of the ghost in the middle"
    ]
    # A player who finishes when the ghost doesn't has won; it has no margin in days.
    lone = S.summarise(_rows([("won", None, "lost")]))["finish, half power"]
    assert lone["win_share"] is None and lone["median_margin_days"] is None
