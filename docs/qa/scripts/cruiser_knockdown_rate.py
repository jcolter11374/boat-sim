"""How often the knockdown model (vessel/hazards.py) rolls a keelboat, against what it was fitted to.

    PYTHONPATH=src python docs/qa/scripts/cruiser_knockdown_rate.py [configs/stock_cruiser31.yaml]

Prints (1) expected knockdowns and the chance of at least one in a 12-hour storm, by sea height,
for a 10 m yacht (the size the fit used) and for the boat's own length; (2) for each saved replay
of the 31 ft cruiser, the knockdowns the model expects from that voyage's own hourly sea and wind
next to the number the replay shows. See docs/qa/cruiser-knockdown-rate-2026-11.md.
"""

import glob
import json
import math
import sys
from dataclasses import replace
from pathlib import Path

from boatsim.config import load_design
from boatsim.vessel.hazards import HazardParams, knockdown_rate_per_hour

design = sys.argv[1] if len(sys.argv) > 1 else "configs/stock_cruiser31.yaml"
p = HazardParams.from_config(load_design(design).hazards)
TP, WIND, HOURS = 11.0, 25.0, 12.0  # the fit's storm (tests/test_keelboat_knockdowns.py), Hs varied

print(
    f"{design}: hull {p.hull_length_m} m, critical breaker {p.critical_wave_frac_of_length} of length"
)
print("12 h storm, wave period 11 s, wind 25 m/s: expected knockdowns (chance of at least one)")
print(
    "Hs m | 10 m yacht   | this boat    | chance a roll sinks her | chance the storm sinks this boat"
)
for hs in (6, 7, 8, 9, 10, 11):
    cells = []
    for length in (10.0, p.hull_length_m):
        lam = knockdown_rate_per_hour(replace(p, hull_length_m=length), hs, TP, WIND) * HOURS
        cells.append(f"{lam:5.2f} ({1 - math.exp(-lam):4.0%})")
    sink = min(p.p_inverted_stuck * (hs / p.damage_ref_hs_m) ** 2, p.max_damage_p)
    lam = knockdown_rate_per_hour(p, hs, TP, WIND) * HOURS
    print(f"{hs:4d} | {cells[0]} | {cells[1]} | {sink:6.1%} | {1 - math.exp(-lam * sink):6.1%}")

print(
    "\nSaved 31 ft cruiser replays: knockdowns expected from the voyage's own hourly sea and wind, and shown"
)
for f in sorted(glob.glob("sea3d/public/voyages/voyage_31-ft-cruiser_*.json")):
    v = json.loads(Path(f).read_text())
    n = len(v["h"])
    expected = 0.0
    for i in range(n):
        dt = v["h"][i + 1] - v["h"][i] if i + 1 < n else 1.0
        expected += (
            knockdown_rate_per_hour(
                p, v["hs"][i], v["tp"][i], math.hypot(v["wind_u"][i], v["wind_v"][i])
            )
            * dt
        )
    shown = sum(int(e["detail"].split()[0]) for e in v["events"] if e["kind"] == "capsize")
    print(
        f"{v['start'][:10]}: expected {expected:5.2f}, shown {shown}, highest sea {max(v['hs']):.1f} m"
    )
