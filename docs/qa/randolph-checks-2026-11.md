# Shared checks with the Randolph team: drifters on the shared stretch, and the dead-boat run (#73)

Ravi (QA), 9 Nov 2026. This covers items 1 and 3 of #73. Priya covered item 2, GLORYS against SMOC, in #78.

**Short version.**
- On the stretch of ocean both teams cross, our simulated currents track real drifters only about as well as a model that assumes the drifter never moves. They beat that baseline for 11 of the 20 drifters.
- In the dead-boat run, our kayak drifted into the Chesapeake Bay and hit land after 9.6 days. The Randolph simulator also had it aground in the Bay, after 8.9 days.

## 1. Drifters on the shared stretch (36–42°N, 75–50°W)

[Run 42547980954](https://github.com/jcolter11374/boat-sim/actions/runs/42547980954). Setup:
- code 218134e, 10 days per drifter;
- ERA5 weather and GLORYS12 currents;
- 20 NOAA GDP drifters whose first fix is in the box.

The drifters are split by where they start:
- west band: 75–65°W;
- mid band: 65–57°W;
- east band: 57–50°W.

They are also split by drogue. A drogued drifter has a sock that holds it 15 m down. An undrogued drifter floats at the surface.

The selection rule is in `SHARED_CASES` in `mc/drifters.py`. Scores are the same as in #19 ([drifter-check-2026-11.md](drifter-check-2026-11.md)).

| Drifter | When / type | Judged model | Skill | Gap day 1 | Gap day 3 | Gap day 5 | Gap day 10 | Stay put (gap, skill) | Kayak gap day 10 |
|---|---|---|---|---|---|---|---|---|---|
| 54421 | Jan 2006, west band (36.7N 69.4W), drogued | water | 0.43 | 43 km | 87 km | 100 km | 93 km | 190 km, 0.13 | 208 km |
| 79224 | Apr 2009, west band (36.7N 70.0W), drogued | water | 0.20 | 9 km | 15 km | 45 km | 225 km | 176 km, 0.06 | 755 km |
| 114599 | Oct 2013, west band (37.0N 67.2W), drogued | water | 0.21 | 37 km | 70 km | 14 km | 212 km | 268 km, 0.20 | 90 km |
| 300534061551770 | Aug 2022, west band (40.4N 68.2W), drogued | water | 0.19 | 9 km | 26 km | 41 km | 56 km | 82 km, 0.03 | 159 km |
| 9624914 | Apr 1997, west band (41.2N 67.9W), undrogued | float | 0.22 | 5 km | 13 km | 16 km | 48 km | 7 km, 0.71 | 161 km |
| 9624972 | Jun 1999, west band (41.9N 66.7W), undrogued | float | 0.06 | 2 km | 14 km | 38 km | 146 km | 97 km, 0.18 | 383 km |
| 71096 | Aug 2007, west band (41.6N 66.6W), undrogued | float | 0.18 | 13 km | 33 km | 45 km | 75 km | 79 km, 0.09 | 57 km |
| 300234066313020 | May 2019, west band (38.8N 70.6W), undrogued | float | 0.33 | 17 km | 74 km | 178 km | 157 km | 64 km, 0.59 | 172 km |
| 63129 | Nov 2006, mid band (38.1N 61.9W), drogued | water | 0.26 | 5 km | 27 km | 77 km | 189 km | 199 km, 0.19 | 395 km |
| 79326 | Apr 2009, mid band (36.5N 64.2W), drogued | water | 0.00 | 27 km | 80 km | 96 km | 221 km | 81 km, 0.64 | 201 km |
| 114896 | Jul 2013, mid band (41.1N 61.5W), drogued | water | 0.25 | 18 km | 50 km | 123 km | 396 km | 94 km, 0.40 | 219 km |
| 300234068347620 | Oct 2020, mid band (36.5N 60.4W), drogued | water | 0.35 | 38 km | 101 km | 120 km | 181 km | 163 km, 0.31 | 419 km |
| 72112 | Feb 2007, mid band (37.9N 63.9W), undrogued | float | 0.18 | 30 km | 35 km | 49 km | 298 km | 82 km, 0.34 | 619 km |
| 70825 | Apr 2007, mid band (37.3N 60.0W), undrogued | float | 0.52 | 22 km | 73 km | 173 km | 364 km | 465 km, 0.29 | 172 km |
| 300234068346830 | Oct 2020, mid band (36.5N 60.4W), undrogued | float | 0.33 | 45 km | 91 km | 136 km | 276 km | 149 km, 0.61 | 396 km |
| 300234066315370 | Oct 2020, mid band (36.5N 61.1W), undrogued | float | 0.49 | 87 km | 210 km | 117 km | 109 km | 173 km, 0.49 | 280 km |
| 18388 | Apr 2001, east band (40.0N 50.0W), drogued | water | 0.00 | 59 km | 182 km | 269 km | 509 km | 136 km, 0.57 | 398 km |
| 92865 | Jun 2010, east band (40.5N 55.8W), drogued | water | 0.58 | 35 km | 104 km | 203 km | 155 km | 345 km, 0.19 | 180 km |
| 118426 | Jun 2012, east band (39.2N 54.8W), drogued | water | 0.19 | 85 km | 118 km | 337 km | 673 km | 373 km, 0.58 | 446 km |
| 300534061650930 | Apr 2022, east band (36.8N 53.9W), drogued | water | 0.37 | 15 km | 61 km | 51 km | 153 km | 121 km, 0.19 | 356 km |

Across the 20 drifters, each judged against its fair model:
- median skill 0.23;
- median gap after 10 days 185 km, against a median of 143 km that the drifters actually travelled from their start;
- the model beat "stay put" in 11 of 20.

Per model, across all drifters: water had median skill 0.29 and a median day-10 gap of 154 km. Float had 0.27 and 162 km.

### Ravi's read

- **This is much worse than the #19 check.**
  - There, Gulf Stream riders off Hatteras scored 0.78 to 0.86.
  - Out here, most drifters start in the eddy field around and beyond the Gulf Stream, not in the jet itself.
  - An eddy that GLORYS places 30 km off, or a day early, sends the model the wrong way. That matches #19, where slow eddy water lost to "stay put" in all 4 cases.
- **Scores are bad in all three bands.** The east band has the two biggest gaps (509 and 673 km) and also the best skill (0.58). There's no clean west-to-east trend in 20 cases.
- **It doesn't matter much whether the drifter has a drogue.** Drogued drifters judged against the water model had a median skill of 0.23. Undrogued ones judged against the float model had 0.28.
- **What it means for us:**
  - Single tracks across this stretch can't be trusted, in our simulator or presumably in theirs, which uses a coarser current grid.
  - Monte Carlo odds are still usable, because the errors look like random eddy placement rather than a steady push in one direction.
  - I haven't tested that last point. A check of mean drift direction would confirm it.
  - The Randolph team's 1° to 0.25° grid result (86.3 against 101.8 days) fits this picture: the answer here depends on how the eddies are drawn.
- **Next check worth doing:** score SMOC on the same 20 drifters, now that Priya's #78 can read it. That shows whether either current source does better here.

## 3. Dead-boat run from our drop point, 15 May 2023

[Run 42547982733](https://github.com/jcolter11374/boat-sim/actions/runs/42547982733), code 218134e.
- The v4 kayak has its motors off, no steering and hazards off.
- It is pushed only by GLORYS12 current, ERA5 wind, and the waves' Stokes drift (the slow push waves give anything at the surface).
- The run stops where the track first reaches land. Land means GLORYS has no sea point around it, on a grid of about 9 km. That's a stand-in until the coastline check from #75, now merged, is wired into this tool.

**Result:**
- The boat first reached land after **9.6 days at 36.86°N, 76.58°W**, inside Hampton Roads near the mouth of the Nansemond River.
- Its path was 256 km. It ended 79 km from the start in a straight line.

Daily positions:

| Day | Lat | Lon |
|---|---|---|
| 0 | 36.85 | -75.70 |
| 1 | 36.89 | -75.78 |
| 2 | 37.23 | -75.52 |
| 3 | 37.34 | -75.39 |
| 4 | 37.33 | -75.79 |
| 5 | 37.35 | -76.24 |
| 6 | 37.23 | -76.34 |
| 7 | 37.08 | -76.25 |
| 8 | 37.03 | -76.30 |
| 9 | 36.93 | -76.52 |

**Compared with the Randolph simulator** ([their track](https://github.com/sheltonr2/drone-boat/blob/main/results/2026-11-08_dead_boat_2023-05-15_track.txt)):
- Theirs went aground near the York River (37.35°N, 76.40°W) after 8.9 days and 344 km.
- Both simulators move the dead boat north, then west into the Chesapeake Bay, and have it reach shore in about 9 days.
- Ours ends about 55 km further south, in Hampton Roads rather than at the York River.
- On day 5 our track passes 37.35°N, 76.24°W, about 15 km from their grounding point.
- So the two simulators broadly agree. The difference in the last few days is the size you'd expect from two wind-drift models that differ slightly.

**What it means for us:** a boat that dies near the drop point in mid-May tends to wash into the Bay within about 10 days, not out to sea. If a dead boat in the Bay is a problem (it could be found, or block a channel), the drop point should be further offshore or reached in a different wind. This is a single date, so it says nothing about how often that happens.

## Caveats

- These are 2023 weather and currents for the dead-boat run, and 1997 to 2022 drifters for item 1. The GDP hourly file ends in October 2022.
- The kayak's windage (how much the wind pushes it) is still a guess until the tow test.
- The land test is the GLORYS land mask, not a coastline.
