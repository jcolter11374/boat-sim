# Drift check results, 8 Nov 2026 (issue #19)

Run: [Drifter check on PR #44](https://github.com/jcolter11374/boat-sim/actions/runs/42520401442),
real ERA5 weather and GLORYS12 currents, 10 days, code at 3ad0088.
How it works: `src/boatsim/mc/drifters.py`. Re-run from the Actions tab ("Drifter check").

## Ravi's read

- **In the Gulf Stream the currents are good.** The five drifters that rode the
  Stream travelled 520 to 850 km in 10 days. The judged model followed with skill
  0.78 to 0.86 and ended 115 to 250 km away. Our ocean carries things the right
  way at about the right speed.
- **In slow, eddy-filled water off the Stream it fails.** Four drifters moved
  only 90 to 350 km and the model lost to "stay put" for all four. In Feb 2017 the
  model float ended 737 km from a drifter that only went 354 km from its start.
  That is the known weak spot of an ocean reanalysis: it puts eddies and the
  Stream's edge roughly, not exactly, where they really were.
- **Gaps are 7 to 54 km after one day and 115 to 740 km after ten.** So the
  simulator is fine for odds over many launches (statistics), but no single simulated track
  should be read as where the boat would really go. It also means the base
  station can't plan from currents alone; it needs fresh positions, which it
  gets daily.
- **Caveat:** GLORYS gives the current at 0.5 m; drogued drifters follow the
  water at 15 m. Some of their gap is that depth difference, not model error.
- **The dead kayak drifts differently from both kinds of drifter** (median
  skill 0.44), as expected: wind pushes it more. No real data checks that part
  yet; the Bay tow test (docs/tow-test.md) is where it gets measured.

Verdict: good enough to start the Monte Carlo (#20). Not good enough to trust
any one track.

## Full table (from the run)

| Drifter | When / type | Judged model | Skill | Gap day 1 | Gap day 3 | Gap day 5 | Gap day 10 | Stay put (gap, skill) | Kayak gap day 10 |
|---|---|---|---|---|---|---|---|---|---|
| 75152 | Mar 2008, off Cape Hatteras, drogued | water | 0.79 | 36 km | 160 km | 308 km | 181 km | 526 km, 0.32 | 314 km |
| 101722 | Aug 2013, 200 km east of Hatteras, drogued | water | 0.00 | 49 km | 164 km | 187 km | 193 km | 99 km, 0.18 | 375 km |
| 300234064018110 | Feb 2017, off Cape Hatteras, drogued | water | 0.00 | 48 km | 237 km | 345 km | 737 km | 354 km, 0.23 | 83 km |
| 300234067876670 | Jan 2020, off Cape Hatteras, drogued | water | 0.86 | 34 km | 64 km | 40 km | 140 km | 526 km, 0.11 | 611 km |
| 300234065703970 | May 2020, south-east of Hatteras, drogued | water | 0.15 | 54 km | 155 km | 251 km | 130 km | 90 km, 0.64 | 336 km |
| 28843 | Jan 2002, off the Bay mouth, undrogued | float | 0.00 | 15 km | 51 km | 89 km | 268 km | 185 km, 0.26 | 553 km |
| 300234066314510 | May 2019, south of Hatteras, undrogued | float | 0.81 | 7 km | 123 km | 192 km | 116 km | 846 km, 0.10 | 454 km |
| 300234065514430 | Jun 2019, off Cape Hatteras, undrogued | float | 0.78 | 24 km | 117 km | 144 km | 251 km | 744 km, 0.25 | 130 km |
| 300234066312890 | Jul 2019, south of Hatteras, undrogued | float | 0.81 | 23 km | 162 km | 117 km | 116 km | 810 km, 0.10 | 257 km |


**Summary over 9 drifters (judged model):** median skill 0.78, median gap after 10 days 181 km (drifters' median distance from start 526 km). The model's skill beat 'stay put' in 5 of 9.


Per model, all drifters:

| Model | Median skill | Median gap day 10 |
|---|---|---|
| water | 0.73 | 189 km |
| float | 0.69 | 247 km |
| kayak | 0.44 | 336 km |
