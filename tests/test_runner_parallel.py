from datetime import datetime, timedelta

from boatsim.runner import StandardVoyage, run_many, summarize

JOB = StandardVoyage(weather="constant", max_days=20)
STARTS = [datetime(2020, 10, 1) + timedelta(days=7 * i) for i in range(4)]


def test_parallel_matches_serial():
    serial = run_many(JOB, STARTS, seed=5, workers=1, reduce=summarize)
    parallel = run_many(JOB, STARTS, seed=5, workers=2, reduce=summarize)
    assert serial == parallel
    assert [r["seed"] for r in serial] == [5, 6, 7, 8]
    assert [r["start"] for r in serial] == STARTS


def test_summary_record_is_small_and_complete():
    (row,) = run_many(JOB, STARTS[:1], workers=1, reduce=summarize)
    assert row["outcome"] in {"arrived", "lost", "timeout"}
    assert 0 < row["days"] <= 20
    for key in ("end_lat", "end_lon", "final_soc", "knockdown_events", "routes_received"):
        assert key in row


def test_without_reduce_returns_full_logs():
    (log,) = run_many(JOB, STARTS[:1], workers=1)
    assert log.rows and log.start == STARTS[0]
