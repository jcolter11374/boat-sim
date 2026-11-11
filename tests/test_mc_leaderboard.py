"""Leaderboard fairness checks and paired ranking (#197, Ravi's 8 rules)."""

import json

import pytest

from boatsim.mc import leaderboard as L

RUN = {"job": "1/2", "commit": "abc1234", "numpy": "2.3.1", "cpu": "AMD EPYC 7763"}


def _launches(finish, n=80, year=2020):
    return [
        {
            "start": f"{year}-04-{1 + i % 28:02d}T{i // 28:02d}:00",
            "seed": year * 1000 + i,
            "outcome": "arrived" if finish(i) else "lost",
            "days": 70.0,
        }
        for i in range(n)
    ]


def _entry(name, finish, hold=None, **run):
    return {
        "design": name,
        "design_sha256": "f" * 64,
        "badges": [],
        "run": {**RUN, **run},
        "launches": _launches(finish),
        "holdout": {"launches": _launches(hold or finish, 60, 2021)},
    }


def _board(*entries):
    return {"board": {"launch_set": "s1", "holdout_set": "h1"}, "entries": list(entries)}


def test_a_fair_board_passes():
    b = _board(_entry("a", lambda i: i % 4 != 0), _entry("b", lambda i: i % 2 == 0))
    assert L.check_board(b) == []


def test_each_rule_is_checked():
    good = _entry("a", lambda i: True)
    other = _entry("b", lambda i: True)
    other["launches"] = other["launches"][:-1]  # rule 1: a launch missing
    assert any("rule 1" in p for p in L.check_board(_board(good, other)))
    short = _board(_entry("a", lambda i: True), _entry("b", lambda i: True))
    for e in short["entries"]:
        e["launches"] = e["launches"][:30]
    assert any("rule 2" in p for p in L.check_board(short))
    assert any("rule 5" in p for p in L.check_board(_board(good, _entry("b", bool, commit="x"))))
    assert any("#197" in p for p in L.check_board(_board(good, _entry("b", bool, job="9/9"))))
    nocpu = _entry("b", bool)
    del nocpu["run"]["cpu"]
    assert any("cpu" in p for p in L.check_board(_board(good, nocpu)))
    nohash = _entry("b", bool)
    nohash["design_sha256"] = ""
    assert any("rule 8" in p for p in L.check_board(_board(good, nohash)))
    nohold = _board(good, _entry("b", bool))
    nohold["board"]["holdout_set"] = None
    assert any("rule 6" in p for p in L.check_board(nohold))
    assert any("more than once" in p for p in L.check_board(_board(good, _entry("a", bool))))


def test_paired_counts_only_flipped_launches():
    a = _entry("a", lambda i: i < 50)
    b = _entry("b", lambda i: 10 <= i < 55)
    p = L.paired(a, b)
    assert (p.n, p.a_only, p.b_only) == (80, 10, 5)
    assert p.gap == pytest.approx(5 / 80)
    assert p.p == pytest.approx(L.sign_test(10, 5))
    assert not p.clear and "too close to call" in p.words()


def test_a_real_gap_is_called():
    a = _entry("a", lambda i: i < 70)
    b = _entry("b", lambda i: i < 40)
    p = L.paired(a, b)
    assert p.clear and p.lo > 0 and p.p < 1e-6
    assert p.words().startswith("a beats b: 30 launches to 0")


def test_identical_designs_are_not_separated():
    p = L.paired(_entry("a", lambda i: i % 3 == 0), _entry("b", lambda i: i % 3 == 0))
    assert (p.a_only, p.b_only, p.gap, p.lo, p.hi) == (0, 0, 0.0, 0.0, 0.0) and not p.clear


def test_rank_ties_what_luck_could_explain():
    b = _board(
        _entry("top", lambda i: i < 70),
        _entry("close", lambda i: i < 68),  # 2 launches behind: a tie
        _entry("worse", lambda i: i < 35),
    )
    rows = L.rank(b)
    assert [(r["design"], r["tier"]) for r in rows] == [("top", 1), ("close", 1), ("worse", 2)]


def test_holdout_flags_a_design_tuned_to_the_test():
    tuned = _entry("tuned", lambda i: i < 76, hold=lambda i: i < 20)
    honest = _entry("honest", lambda i: i < 50)
    flags = L.holdout_flags(_board(tuned, honest))
    assert len(flags) == 1 and flags[0].startswith("tuned:")


def test_cli_is_behind_a_flag(tmp_path, monkeypatch, capsys):
    f = tmp_path / "board.json"
    f.write_text(json.dumps(_board(_entry("a", lambda i: i < 60), _entry("b", lambda i: i < 20))))
    monkeypatch.delenv(L.FLAG, raising=False)
    with pytest.raises(SystemExit, match="behind a flag"):
        L.main([str(f)])
    monkeypatch.setenv(L.FLAG, "1")
    L.main([str(f), "--strict"])
    out = capsys.readouterr().out
    assert "| 1 | a | 75% |" in out and "a beats b" in out
