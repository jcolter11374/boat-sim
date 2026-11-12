"""The replay check's CLI re-simulates many replays, several at once (#335)."""

import pytest

from boatsim.runner import replay


def test_verify_many_in_parallel_reports_each_file(monkeypatch, capsys):
    seen = {"a.json": [], "b.json": ["days: 120.68 != 84.71"]}
    monkeypatch.setattr(replay, "verify", lambda path, design, max_days: seen[path.name])
    with pytest.raises(SystemExit, match="1 replay"):
        replay.main(["verify", "--workers", "2", "a.json", "b.json"])
    out = capsys.readouterr().out
    assert "a.json: matches a fresh run" in out
    assert "b.json: DIFFERS from a fresh run" in out
    assert "days: 120.68 != 84.71" in out
