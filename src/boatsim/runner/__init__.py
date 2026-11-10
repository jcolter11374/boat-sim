"""Voyage runner: wires the packages together and steps one voyage.
Owner: Maya (Lead).

The process-pool helpers (runner.parallel) load on first use, so importing the
runner works where there is no multiprocessing (the in-browser sandbox)."""

from boatsim.runner.arrival import FinishTarget
from boatsim.runner.simulate import Components, VoyageLog, simulate

__all__ = [
    "Components",
    "FinishTarget",
    "StandardVoyage",
    "VoyageLog",
    "run_many",
    "simulate",
    "summarize",
]


def __getattr__(name: str):
    if name in ("StandardVoyage", "run_many", "summarize"):
        from boatsim.runner import parallel

        return getattr(parallel, name)
    raise AttributeError(f"module 'boatsim.runner' has no attribute {name!r}")
