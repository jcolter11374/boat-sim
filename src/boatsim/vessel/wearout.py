"""Wear-out: an open-ocean failure rate that rises with days at sea (#118).

Fitted to the Microtransat crossing record (the Randolph team's
docs/data/crossing_attempts.csv, MIT) by docs/qa/scripts/wearout_fit.py. The record
cannot tell wear-out apart from a constant rate (likelihood-ratio p = 0.25), so the
table gives a range, not one answer. Write-up: docs/qa/wearout-fit-2026-11.md.

The multiplier is the shape of a Weibull hazard, scaled to 1 at t_ref_days:

    rate(t) = base_open_ocean_rate * wearout_multiplier(t, params)

where t is days since the boat left the near-land band (about 150 km from a coast).
With base = 0.0129/day (the record's constant open-ocean rate) the "central" row
reproduces the fitted Weibull hazard. k = 1 is a constant rate.

No dependencies beyond the standard library, so the Randolph team can copy it as is.
"""

from __future__ import annotations

# k: Weibull shape (1 = constant, > 1 = wear-out). t_ref_days: the day the shaped
# rate equals the constant one fitted to the same record.
WEAROUT_PARAMS: dict[str, dict[str, float]] = {
    "none": {"k": 1.0, "t_ref_days": 35.0},  # constant rate; AIC's choice
    "central": {"k": 1.41, "t_ref_days": 34.9},  # maximum likelihood
    "low": {"k": 0.75, "t_ref_days": 22.7},  # 95% profile bound: falling rate
    "high": {"k": 2.24, "t_ref_days": 48.6},  # 95% profile bound: strong wear-out
}

# The record's constant open-ocean rate: 8 events in 622 boat-days.
RECORD_OPEN_OCEAN_PER_DAY = 0.0129

# Below this, a shape under 1 would blow up; nobody fails at a rate set by t = 0.
MIN_DAY = 1.0


def wearout_multiplier(day_open_ocean: float, params: dict[str, float] | str = "none") -> float:
    """Multiplier on the open-ocean failure rate after day_open_ocean days offshore.

    params: a row of WEAROUT_PARAMS, or its name. Returns (t / t_ref) ** (k - 1)."""
    if isinstance(params, str):
        params = WEAROUT_PARAMS[params]
    k = float(params["k"])
    if k == 1.0:
        return 1.0
    t = max(float(day_open_ocean), MIN_DAY)
    return (t / float(params["t_ref_days"])) ** (k - 1.0)
