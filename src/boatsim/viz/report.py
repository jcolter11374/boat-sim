from __future__ import annotations

from boatsim.mc.batch import BatchResult


def text_summary(result: BatchResult) -> str:
    """Stub: a plain-text summary. Iris replaces this with the HTML report
    (map of tracks by outcome, battery over time, odds by launch month)."""
    rate, lo, hi = result.success_rate()
    n = len(result.summary)
    return f"{n} voyages, arrived {rate:.0%} (95% range {lo:.0%} to {hi:.0%})"
