# QA: race view verdict against the server (#235, #209)

Ravi (QA), 11 Nov 2026. The race: our kayak (k-p25) against Randolph Rev C (our model), over the six 2020 season launches. Both boats leave from the kayak's drop, breakdowns are on, and the seeds are the grid's (`year * 1000 + i`).

| Launch | Page (Pyodide, browser bundle) | CPython, same bundle | Server grid (full ERA5 + GLORYS; Rev C from its own drop) |
|---|---|---|---|
| 1 Apr | kayak arrived d116.8 / Rev C out of time | kayak **aground** d75.8 / out of time | kayak lost d71.7 / out of time |
| 15 Apr | arrived d69.3 / out of time | same | arrived d71.4 / out of time |
| 1 May | lost d3.9 / out of time | same | lost d3.9 / out of time |
| 15 May | disqualified d64.3 / lost d138.5 | same | disqualified d64.5 / aground d11.9 |
| 1 Jun | arrived d57.6 / out of time | same | arrived d74.5 / lost d113.4 |
| 15 Jun | arrived d76.0 / arrived d144.6 | arrived d73.9 / arrived d144.6 | arrived d64.0 / aground d1.9 |
| **Finished** | **4 vs 1** | **3 vs 1** | **3 vs 0** |
| **Verdict** | too close to call | too close to call | (6 launches) too close to call; over 100 launches 78% vs 11%, clear |

## What this shows

1. **The page is the simulator, exactly.** A Node + Pyodide run of `race.season` on the published files gives the browser's numbers to the day: 4 vs 1, 1 April arriving on day 116.8.
2. **CPython and Pyodide disagree on 1 launch in 6** (1 April; 15 June finishes 2 days apart). This is the known last-bit chaos (#197, docs/sandbox.md), not a race-view bug. The same dice and the same weather, nudged in the 15th digit, send a 117-day voyage somewhere else.
3. **The page and the server grid use different weather.** The browser bundle is 1° and 6-hourly; the grid uses full ERA5 and GLORYS. The grid also drops Rev C from its own drop, off New Jersey. Per-launch outcomes differ for both reasons, and the 1 May day-3.9 loss shows the shared dice still agree.
4. **The verdicts agree where they should.** Every six-launch view says "too close to call", and the page says six launches are a hint, not a ranking. The 100-launch grid (78% vs 11%) is the real answer, and it is clear.

## Recommendations

- Leave the page's verdict as it is. It is honest because six launches never claim a winner unless they're lopsided.
- When the season finishes, add a line pointing to the leaderboard / grid odds for the 100-launch answer (for Iris's polish pass).
- The default drop is "same" (boat A's), which is the fairer head-to-head. The grid uses "own". Say which one a comparison used whenever page and grid numbers sit side by side.
