from __future__ import annotations

import math
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime

import pandas as pd

from boatsim.runner.simulate import VoyageLog
from boatsim.types import Outcome


@dataclass
class BatchResult:
    summary: pd.DataFrame  # one row per voyage

    def success_rate(self) -> tuple[float, float, float]:
        """Arrival fraction with a 95% Wilson interval: (rate, low, high)."""
        n = len(self.summary)
        if n == 0:
            return 0.0, 0.0, 0.0
        k = int((self.summary["outcome"] == Outcome.ARRIVED.value).sum())
        z = 1.96
        p = k / n
        denom = 1 + z**2 / n
        centre = (p + z**2 / (2 * n)) / denom
        half = z * math.sqrt(p * (1 - p) / n + z**2 / (4 * n**2)) / denom
        return p, max(0.0, centre - half), min(1.0, centre + half)


def run_batch(
    run_one: Callable[[datetime, int], VoyageLog], starts: Iterable[datetime], seed: int = 0
) -> BatchResult:
    """Stub: runs voyages one after another. Ravi adds parallelism, failure
    injection, parameter spread, and per-month and cause-of-loss breakdowns."""
    rows = []
    for i, start in enumerate(starts):
        log = run_one(start, seed + i)
        rows.append(
            {
                "start": start,
                "seed": log.seed,
                "outcome": log.outcome.value,
                "days": log.days,
                "final_soc": log.rows[-1]["soc"] if log.rows else None,
            }
        )
    return BatchResult(pd.DataFrame(rows))
