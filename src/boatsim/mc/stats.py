"""Small statistics shared by the odds studies and the browser: numbers only,
no pandas, so Pyodide can import it (the race view, sandbox/race.py)."""

from __future__ import annotations

import math


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float, float]:
    """k of n with a 95% Wilson interval: (fraction, low, high)."""
    if n == 0:
        return float("nan"), float("nan"), float("nan")
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return p, max(0.0, centre - half), min(1.0, centre + half)


def sign_test(gained: int, lost: int) -> float:
    """Two-sided exact sign test: chance of a split at least this lopsided
    among the flipped voyages if the change made no difference."""
    n = gained + lost
    if n == 0:
        return 1.0
    k = min(gained, lost)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return min(1.0, 2 * tail)
