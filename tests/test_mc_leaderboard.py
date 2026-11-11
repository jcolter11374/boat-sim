"""Leaderboard fairness checks and paired ranking (#197, Ravi's 8 rules)."""

import json
import re

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


# --- Building a board (data side) ---------------------------------------------


def _rows(builds, years, per_year=13):
    import pandas as pd

    from boatsim.mc.sensitivity import window_launches

    out = []
    for y in years:
        for i, s in enumerate(window_launches(y, 7)[:per_year]):
            for k, b in enumerate(builds):
                ok = (i + k) % 3 != 0
                out.append(
                    {
                        "build": b,
                        "start": s,
                        "seed": y * 1000 + i,
                        "outcome": "arrived" if ok else "lost",
                        "days": 70.0 + i,
                    }
                )
    return pd.DataFrame(out)


def _fixed_run(monkeypatch):
    run = {"job": "1/leaderboard/1", "commit": "abc1234", "numpy": "2.0", "cpu": "test cpu"}
    monkeypatch.setattr(L, "provenance", lambda: dict(run))
    return run


def test_default_entries_are_grid_builds():
    from boatsim.mc.boatyard import BUILDS

    assert L.DEFAULT_ENTRIES and all(b in BUILDS for b in L.DEFAULT_ENTRIES)
    assert len(set(L.DEFAULT_ENTRIES)) == len(L.DEFAULT_ENTRIES)


def test_launch_set_id_names_years_and_spacing():
    assert L.launch_set_id([2019, 2015, 2017], 7) == "2015-2019-AprJun-every7d-v1"


def test_badges_and_design_hash():
    from boatsim.mc.boatyard import BUILDS

    assert L.badges(BUILDS["k-p25"]) == [L.KAYAK_BADGE]
    assert L.badges(BUILDS["revc"]) == ["our model of Randolph Rev C"]
    h = {b: L.design_hash(BUILDS[b]) for b in ("k-p25", "k-p20", "revc")}
    assert len(set(h.values())) == 3  # a part change or a different file changes the hash
    assert h["k-p25"] == L.design_hash(BUILDS["k-p25"])


def test_assembled_board_passes_the_fairness_checks(monkeypatch):
    run = _fixed_run(monkeypatch)
    builds = ["k-p25", "k-p20", "revc"]
    years = [2015, 2016, 2017, 2018, 2019]
    board = L.assemble(_rows(builds, years), _rows(builds, [2021]), 7, years, [2021])
    assert L.check_board(board) == []
    assert board["board"]["launch_set"] == "2015-2019-AprJun-every7d-v1"
    assert board["board"]["holdout_set"] == "2021-2021-AprJun-every7d-v1"
    assert board["board"]["sha"] == run["commit"]
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\dZ", board["board"]["made"])
    e = {x["design"]: x for x in board["entries"]}
    assert set(e) == set(builds)
    assert all(x["run"] == run for x in board["entries"])
    assert len(e["k-p25"]["launches"]) == 65
    assert e["k-p25"]["launches"][0]["start"] == "2015-04-01T12:00"
    json.dumps(board)  # plain JSON
    assert "too close to call" in L.report(board) or "beats" in L.report(board)


def test_assembled_board_flags_short_sets_and_missing_holdout(monkeypatch):
    _fixed_run(monkeypatch)
    builds = ["k-p25", "revb"]
    board = L.assemble(_rows(builds, [2020]), None, 7, [2020], [])
    problems = " ".join(L.check_board(board))
    assert "rule 2" in problems and "rule 6" in problems


def test_cli_assemble_writes_the_board(tmp_path, monkeypatch):
    _fixed_run(monkeypatch)
    monkeypatch.setenv(L.FLAG, "1")
    builds = ["k-p25", "k-p30"]
    years = [2015, 2016, 2017, 2018, 2019]
    pubs = []
    for y in years:
        f = tmp_path / f"public_{y}.csv"
        _rows(builds, [y]).to_csv(f, index=False)
        pubs.append(str(f))
    hold = tmp_path / "holdout_2021.csv"
    _rows(builds, [2021]).to_csv(hold, index=False)
    out = tmp_path / "board.json"
    L.main(["assemble", "--public", *pubs, "--holdout", str(hold), "--out", str(out), "--strict"])
    board = json.loads(out.read_text())
    assert L.check_board(board) == []
    assert board["board"]["launch_set"] == "2015-2019-AprJun-every7d-v1"


def test_stock_vessels_never_rank_against_the_drones(monkeypatch):
    from boatsim.mc.boatyard import BUILDS

    for stock in ("cruiser31", "dinghy14", "beachcat16"):
        assert L.boat_class(f"configs/stock_{stock}.yaml") == L.STOCK_CLASS
    assert {L.boat_class(BUILDS[b].design_path) for b in L.DEFAULT_ENTRIES} == {L.DRONE_CLASS}
    # No Boatyard build (so nothing the board or the race view can pick) is a stock vessel.
    assert all(L.boat_class(b.design_path) == L.DRONE_CLASS for b in BUILDS.values())
    _fixed_run(monkeypatch)
    builds = ["k-p25", "revc"]
    years = [2015, 2016, 2017, 2018, 2019]
    board = L.assemble(_rows(builds, years), _rows(builds, [2021]), 7, years, [2021])
    assert L.check_board(board) == []
    board["entries"][1]["class"] = L.STOCK_CLASS
    assert any("rule 7" in p for p in L.check_board(board))


def test_summary_has_what_the_page_draws(tmp_path, monkeypatch):
    _fixed_run(monkeypatch)
    builds = ["k-p25", "k-p20", "revc"]
    years = [2015, 2016, 2017, 2018, 2019]
    board = L.assemble(_rows(builds, years), _rows(builds, [2021]), 7, years, [2021])
    s = board["summary"]
    assert s["fair"] and s["problems"] == [] and s["reference"] == "k-p25"
    rows = {r["design"]: r for r in s["rows"]}
    assert set(rows) == set(builds)
    assert "vs_reference" not in rows["k-p25"]
    v = rows["revc"]["vs_reference"]
    assert v["ci95"][0] <= v["gap"] <= v["ci95"][1] and isinstance(v["clear"], bool)
    assert rows["revc"]["badges"] == ["our model of Randolph Rev C"]
    assert rows["k-p25"]["holdout"]["launches"] == 13
    assert all(r["tier"] >= 1 for r in s["rows"])
    # The CLI adds a summary to a board built before summaries existed.
    monkeypatch.setenv(L.FLAG, "1")
    del board["summary"]
    f = tmp_path / "board.json"
    f.write_text(json.dumps(board))
    L.main(["summarise", str(f)])
    assert json.loads(f.read_text())["summary"]["rows"]


def test_paired_interval_stays_inside_plus_minus_100_points():
    # A six-launch race season (race view): 3 flips one way, none the other.
    la = [
        {"start": f"2020-0{4 + i // 2}-01", "seed": i, "outcome": "arrived" if i < 4 else "lost"}
        for i in range(6)
    ]
    lb = [
        {"start": x["start"], "seed": x["seed"], "outcome": "arrived" if x["seed"] == 0 else "lost"}
        for x in la
    ]
    p = L.paired({"design": "a", "launches": la}, {"design": "b", "launches": lb})
    assert p.a_only == 3 and p.b_only == 0
    assert -1.0 <= p.lo <= p.gap <= p.hi <= 1.0
