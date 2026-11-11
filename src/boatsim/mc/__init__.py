"""Monte Carlo batches and QA. Owner: Ravi (thread 4).

`run_batch` and `BatchResult` load on first use, so modules that need no
pandas (stats, leaderboard) import cleanly in the browser (Pyodide).
"""

__all__ = ["BatchResult", "run_batch"]


def __getattr__(name: str):
    if name in __all__:
        from boatsim.mc import batch

        return getattr(batch, name)
    raise AttributeError(f"module 'boatsim.mc' has no attribute {name!r}")
