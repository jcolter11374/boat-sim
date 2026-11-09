"""#118: does the open-ocean failure rate rise with days at sea? Fit to the Microtransat
record. Standard library + numpy only.

    python docs/qa/scripts/wearout_fit.py path/to/crossing_attempts.csv

The CSV is the Randolph team's docs/data/crossing_attempts.csv (MIT, sheltonr2/drone-boat);
it is not copied here. The near-land / open-ocean split is theirs (hazard_analysis.py):
a boat leaves the 150 km band after 1.5 x 150 km of track, at its average speed.
The clock is days in open ocean. A boat is an event if it ended in open ocean for a
reason other than "none"; finishers and boats whose crossing ended near land are censored.
"""

import csv
import math
import sys

import numpy as np

NEAR_KM, TORTUOSITY = 150.0, 1.5
CHI2_1_95 = 3.841  # 95% point of chi-square, 1 degree of freedom


def open_ocean_exposure(path):
    out = []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            if not r["days"] or r["end_zone"] == "U":
                continue
            d = float(r["days"])
            if r["end_zone"] == "N" and r["crossed"] != "yes":
                continue  # never reached open ocean
            v = float(r["track_km"]) / d if r["track_km"] else 50.0
            dep = min(d, TORTUOSITY * NEAR_KM / v)
            arr = dep if r["crossed"] == "yes" else 0.0
            o = d - min(d, dep + arr)
            event = r["end_zone"] == "O" and r["root_cause"] != "none"
            out.append((o, event, r["id"], r["root_cause"]))
    return out


def weibull_profile(t, e, k):
    """Max log-likelihood over scale at shape k; returns (logL, scale). H(t) = (t/s)^k."""
    d = e.sum()
    s = (np.sum(t**k) / d) ** (1.0 / k)
    ll = np.sum(e * (math.log(k) - math.log(s) + (k - 1) * np.log(t / s))) - np.sum((t / s) ** k)
    return float(ll), float(s)


def p_value_1df(lr):
    return math.erfc(math.sqrt(max(lr, 0.0) / 2))


def main(path):
    obs = open_ocean_exposure(path)
    t = np.array([o[0] for o in obs])
    e = np.array([o[1] for o in obs], float)
    n_ev, days = e.sum(), t.sum()
    lam = n_ev / days
    ll_c = n_ev * math.log(lam) - n_ev
    print(f"Boats that reached open ocean: {len(t)}; events {int(n_ev)}; {days:.0f} boat-days")
    for o in sorted(obs):
        print(f"  #{o[2]:>3} {o[0]:6.1f} days offshore  {'event' if o[1] else 'censored'}  {o[3]}")
    print(f"Constant rate: {lam:.4f}/day, logL {ll_c:.3f}, AIC {2 - 2 * ll_c:.2f}")
    ks = np.linspace(0.3, 4.0, 3701)
    prof = np.array([weibull_profile(t, e, k)[0] for k in ks])
    i = int(prof.argmax())
    k_hat, ll_w = ks[i], prof[i]
    ok = ks[prof >= ll_w - CHI2_1_95 / 2]
    lr = 2 * (ll_w - ll_c)
    print(
        f"Weibull: shape k {k_hat:.2f} (95% {ok.min():.2f}-{ok.max():.2f}), logL {ll_w:.3f}, "
        f"AIC {4 - 2 * ll_w:.2f}; likelihood ratio {lr:.2f}, p = {p_value_1df(lr):.2f}"
    )
    print("Rows for WEAROUT_PARAMS (t_ref: day the shaped rate equals the constant one):")
    for name, k in (("central", k_hat), ("low", ok.min()), ("high", ok.max())):
        _, s = weibull_profile(t, e, k)
        t_ref = s * (lam * s / k) ** (1 / (k - 1))
        surv = "  ".join(f"S({d})={math.exp(-((d / s) ** k)):.2f}" for d in (30, 60, 90))
        print(f"  {name:8s} k {k:.2f}  scale {s:.1f} d  t_ref {t_ref:.1f} d  offshore {surv}")
    for brk in (30, 45, 60):
        d1, d2 = e[t <= brk].sum(), e[t > brk].sum()
        e1, e2 = np.minimum(t, brk).sum(), np.maximum(t - brk, 0).sum()
        ll = sum(d * math.log(d / x) - d for d, x in ((d1, e1), (d2, e2)) if d)
        print(
            f"Two rates, break at day {brk}: {d1 / e1:.4f} then {d2 / e2:.4f}/day; "
            f"p = {p_value_1df(2 * (ll - ll_c)):.2f}; boats still out after it {int((t > brk).sum())}"
        )


if __name__ == "__main__":
    main(sys.argv[1])
