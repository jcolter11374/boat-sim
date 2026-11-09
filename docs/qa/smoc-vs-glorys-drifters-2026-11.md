# Do SMOC or GLORYS currents move things more like the real ocean? (#116)

Ravi (QA), 9 Nov 2026. [Run 42631289084](https://github.com/jcolter11374/boat-sim/actions/runs/42631289084), drifter check in "smoc" mode. Asked for by the Randolph team in #50.

**Short version.**
- **Neither source is clearly better.** On 40 real drifters in the stretch both teams cross, the two do about equally well.
  - Typical score: 0.53 for SMOC and 0.50 for GLORYS, on a scale where 1 is perfect.
  - Typical gap after 10 days: 132 km for SMOC and 150 km for GLORYS.
  - Each one is the closer of the two for about half the drifters.
- **Both beat "stay put" on 29 of 40 drifters.** "Stay put" means assuming the float doesn't move at all. Both are good enough for statistics over many voyages, and neither can be trusted for one track. This matches #19 and #85.
- **There are hints, but they're not proven.**
  - SMOC does better on drogued floats, which carry an underwater sail and follow the water: it scores higher on 12 of 19.
  - GLORYS plus our wave push does better on undrogued floats, which sit at the surface: SMOC scores higher on only 5 of 18.
  - Neither hint passes a significance test (p = 0.36 and p = 0.10).
- **For us: keep GLORYS.** It runs from 1993. SMOC only starts in Nov 2020, so it can't drive our 2012–2021 launch years at all, and it shows no measurable gain to make up for that.
- **For the Randolph team:** their SMOC-based drift is no worse than our GLORYS-based one in this stretch.

## Setup

- **Which drifters.** SMOC only starts on 1 Nov 2020, and the NOAA drifter archive (GDP, hourly) ends in Oct 2022. So only 2 of the 20 shared cases (#73) overlap SMOC. Instead I took every 10-day stretch of drifter track in the shared box (36–42°N, 75–50°W) from 2 Nov 2020 on. Each stretch had to:
  - start at midnight UTC inside the box;
  - have no gap in the track over 1.5 hours;
  - keep the same drogue state throughout (the drogue is the underwater sail; it can come off);
  - stay inside the area we download SMOC for.

  That gave 245 stretches from 49 drifters. I kept all 21 drogued drifters (one stretch each, including the two shared cases), plus 19 undrogued ones spread over the west, mid and east bands. The undrogued ones are all from Nov–Dec 2020 and Aug–Sep 2021, which kept the SMOC download small. The list is `SMOC_CASES` in `src/boatsim/mc/drifters.py`.
- **Like with like** (Priya's mapping):
  - *Drogued floats* follow the water at about 15 m down, so they are scored on the plain current: the GLORYS daily mean against SMOC's daily mean of its hourly model current. Neither includes the wave push.
  - *Undrogued floats* also feel the waves, so they are scored on GLORYS plus our ERA5 wave push (Stokes drift) against SMOC's hourly total current, which already has the wave push and the tides built in.
- **Wind and waves** are ERA5 for both. Scores are as in #19 and #85:
  - Liu–Weisberg skill: 1 is perfect, 0 means the gaps are as big as the distance the float travelled.
  - The gap after 1, 3, 5 and 10 days.
  - Whether the model beats "stay put".

## Results

| Group | Drifters | Skill GLORYS | Skill SMOC | Gap day 10 GLORYS (km) | Gap day 10 SMOC (km) | Beat stay put (GLORYS / SMOC) | SMOC closer at day 10 |
|---|---|---|---|---|---|---|---|
| All | 40 | 0.50 | 0.53 | 150 | 132 | 29 / 29 | 19 of 40 |
| West band | 14 | 0.46 | 0.49 | 162 | 105 | 11 / 10 | 6 of 14 |
| Mid band | 11 | 0.57 | 0.55 | 151 | 136 | 7 / 6 | 6 of 11 |
| East band | 15 | 0.41 | 0.52 | 126 | 137 | 11 / 13 | 7 of 15 |
| Drogued | 21 | 0.27 | 0.52 | 183 | 120 | 14 / 15 | 12 of 21 |
| Undrogued | 19 | 0.61 | 0.55 | 149 | 151 | 15 / 14 | 7 of 19 |

Median gap by day (km):

| Source | Day 1 | Day 3 | Day 5 | Day 10 |
|---|---|---|---|---|
| GLORYS | 19 | 54 | 83 | 150 |
| SMOC | 21 | 52 | 74 | 132 |

Paired over the same drifters, counting which source scores higher (ties left out):

| Group | SMOC scores higher | Chance, if neither were better |
|---|---|---|
| All 40 | 17 of 37 | 74% |
| Drogued (21) | 12 of 19 | 36% |
| Undrogued (19) | 5 of 18 | 10% |

**The two shared cases from #73:**

| Drifter | Score GLORYS | Score SMOC | Gap day 10 GLORYS | Gap day 10 SMOC |
|---|---|---|---|---|
| 300534061650930 (Apr 2022, east, drogued) | 0.26 | 0.52 | 183 km | 92 km |
| 300534061551770 (Aug 2022, west, drogued) | 0.27 | 0.55 | 48 km | 39 km |

SMOC does better on both, which fits the drogued hint. Two drifters are not evidence.

## Why the hints might be real

- **Drogued floats.** SMOC is an operational forecast that takes in satellite sea-height data within days. GLORYS from mid-2021 on is its "interim" extension. SMOC may place eddies better in real time. We'd need more drogued drifters, or a longer period, to tell.
- **Undrogued floats.** SMOC's total current includes tides and its own wave push. Our ERA5 wave push might suit floats at the very surface better, or SMOC's built-in push may be too weak or too strong. Again, this isn't proven.

## Caveats

- 40 drifters over two years is a small sample. Several drifters were picked up in the same eddy at the same time, so they aren't fully independent.
- The undrogued drifters come from only 4 months.
- All the scores are over 10 days. Over a whole voyage, current errors partly average out, and that is what the Monte Carlo relies on.

Full per-drifter table: the run's job log, or `drift_report.md` in the run's artifact.
