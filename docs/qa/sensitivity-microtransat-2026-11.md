# Sensitivity study under the Microtransat rule (#21, rerun)

Ravi (QA), 9 Nov 2026. [Run 42556820831](https://github.com/jcolter11374/boat-sim/actions/runs/42556820831), code f2d0ab1 (main with #87, #91 and #92 merged).

## What was run

- **Launches.** 100 per row: every 10 days from 1 April to 30 June, 2012 to 2021. Real weather (ERA5) and real currents (GLORYS12). Ship traffic is on.
- **Paired comparison.** Every row sails the same launches with the same random dice. A difference between rows therefore comes from the change itself, not from luck.
- **Length.** Voyages run up to 180 days. A second column counts the ones that finished by day 150.
- **Finish rule.** The Microtransat rule (CLAUDE.md): a voyage counts only if the boat gets within 25 km of the target off Lisbon (39.5°N 13.5°W). Landfall anywhere, the Azores included, doesn't count.
- **Silence.** A boat that goes silent for more than 10 days in a row, or more than 15 days in total, is disqualified.
- **Shakedown assumed.** Every row assumes the planned 14-day shakedown: two weeks of trial sailing near home before the real drop, to find early faults. The one exception is the row that drops it.
- **Unknown-failure hazard.** It is off in the runs and added back in the two "with unknown" columns, as in #60.

## Short version

- **The route matters more than anything else.** The current default route bends south to pass below the Azores. On it, the boat finishes 56 of 100. A straight route to the same target finishes 72 of 100.
  - 27 voyages finish with the straight route but not the bent one, and 11 the other way round. The chance that this split is luck is about 1%.
  - Maya's #98 makes the straight route the default. The old bent route stays as a comparison row.
- **The new rule costs a lot against the old one.**
  - Under the old rule (any landfall in Europe or the Azores counts, on the old route via the Azores): 82 of 100.
  - Under the new rule on the straight route: 72.
  - Under the new rule on today's bent default: 56.
- **The 14-day shakedown is worth too little to measure.** With it, 56 finish. Without it, 54. Five voyages flip one way and seven the other, which is noise.
  - This is what our planning failure rates assume. If early faults turn out to be more common than they assume, the shakedown would be worth more.
- **Failure rates fitted to the real Microtransat record drop the odds from 56 to 38.** That is the biggest single risk in the model. Our planning rates assume a better-built boat than the historical entrants. That is a hope, not a measurement.
- **One thruster is very bad: 26 against 56.** It is worse than in the old study, where it was 75 against 93.
- **Cruise power matters both ways.**
  - At 25 W: 66 of 100, about 24 days faster. Not quite past the noise line: the chance it is luck is 14%.
  - At 10 W: 35 of 100. That is clearly worse.

## Results

All rows below assume the 14-day shakedown, except the one that drops it.

**How to read the columns.**
- **Gained / Lost.** Voyages that finish with the change but not without it, and the other way round.
- **Chance.** How likely that split is if the change did nothing. Above about 5%, treat the difference as noise.
- **Odds (95%).** The range the true finishing rate probably lies in, given only 100 launches.
- **Median days.** The typical voyage length.

### The rule, the route and the target

| Row | Finished (by day 180) | By day 150 | Odds (95%) | Gained / lost | Chance | Median days |
|---|---|---|---|---|---|---|
| Today's default (bent route south of the Azores, target off Lisbon) | 56 | 46 | 56% (46–65%) | | | 129 |
| Old rule, old route via the Azores | 82 | 82 | 82% (73–88%) | 34 / 8 | <1% | 77 |
| Straight route, target 51N 16W (west of Ireland) | 60 | 60 | 60% (50–69%) | 19 / 15 | 61% | 100 |
| Straight route, target 46N 11W (Bay of Biscay) | 71 | 68 | 71% (61–79%) | 26 / 11 | 2% | 107 |
| Straight route, target 44.5N 13.5W (off NW Spain) | 74 | 72 | 74% (65–82%) | 29 / 11 | 1% | 104 |
| **Straight route, target 39.5N 13.5W (off Lisbon, today's target)** | **72** | **69** | **72% (63–80%)** | 27 / 11 | 1% | 110 |
| Straight route, target 37N 13.5W (off SW Portugal) | 70 | 70 | 70% (60–78%) | 24 / 10 | 2% | 116 |

- **Where the targets differ.** The four southern targets (46N to 37N) are all within a few voyages of each other: 70 to 74. Off Lisbon is as good as any of them. Off Ireland is worse, at 60. Its losses are mostly dead electronics on the longer, colder northern track (21 against 17).
- **Why the bent route is slow.** Its median voyage is 129 days, and 10 of its finishers need more than 150 days. On the straight route that drops to 110 days, and only 3 finishers need more than 150. A 150-day limit would cost the bent route 10 points and the straight route 3.

### Shakedown and failure rates

| Row | Finished | By day 150 | Odds (95%) | Gained / lost | Chance |
|---|---|---|---|---|---|
| Today's default (14-day shakedown) | 56 | 46 | 56% (46–65%) | | |
| No shakedown | 54 | 45 | 54% (44–63%) | 5 / 7 | 77% |
| Failure rates fitted to the Microtransat record | 38 | 32 | 38% (29–48%) | 5 / 23 | <1% |

With the record's failure rates, there are more of both of these losses:
- electronics dying offshore: 27 against 15;
- the boat being taken or snagged by fishing gear near land: 18 against 11.

### Messages from the base (route corrections)

| Row | Finished | Gained / lost | Chance | Ran aground |
|---|---|---|---|---|
| Today's default (base re-plans the route from forecasts) | 56 | | | 7 |
| Base never changes the route (still sends a daily "all well") | 51 | 15 / 20 | 50% | 10 |
| Base sends nothing at all | 45 | 15 / 26 | 12% | 28 |
| Boat checks for base messages on a separate daily call | 48 | 17 / 25 | 28% | 9 |

- None of these rows is past the noise line on finishes.
- "Base sends nothing" quadruples the groundings, from 7 to 28. Under the new rule, a boat that wanders ashore on the Azores or in Spain is a failure, so steering from home now does visible work.
- This is on the bent route. It should be rechecked on the straight route after #98.

### Hardware and settings

| Row | Finished | Gained / lost | Chance | Median days | Lowest charge |
|---|---|---|---|---|---|
| Today's default | 56 | | | 129 | 65% |
| Half the battery (640 Wh) | 48 | 12 / 20 | 22% | 126 | 37% |
| Half again the battery (1920 Wh) | 57 | 2 / 1 | 100% | 129 | 77% |
| Smaller panels (150 W) | 45 | 11 / 22 | 8% | 126 | 39% |
| Bigger panels (350 W) | 58 | 3 / 1 | 62% | 131 | 75% |
| Slower cruise (10 W) | 35 | 11 / 32 | <1% | 147 | 78% |
| Faster cruise (25 W) | 66 | 24 / 14 | 14% | 105 | 35% |
| One thruster instead of two | 26 | 8 / 38 | <1% | 137 | 65% |
| Stop motors earlier (below 30%, restart at 40%) | 57 | 1 / 0 | 100% | 129 | 65% |
| Never slow down on low battery | 54 | 1 / 3 | 62% | 128 | 65% |

- **Battery and panels.** A bigger battery or bigger panels change nothing. A smaller battery or smaller panels lean the wrong way (48 and 45), but neither is past the noise line.
- **Low-charge rules.** The rules for what to do at low charge make no difference.
- **One thruster.** It loses 38 voyages for 8 gained. It also leaves 19 boats still at sea at day 180, against 9 with two thrusters. The second thruster is the boat's backup steering. Keep it.

## Caveats

- **Only 100 launches per row.** Differences under about 10 voyages are usually noise. The gained/lost columns say which are not.
- **Failure rates are assumptions.** Every row uses the planning rate set (#91). The row fitted to the real record shows how much that choice is worth: 18 points.
- **Storms are understated.** ERA5 understates hurricane winds, so storm losses are optimistic.
- **Build cost isn't priced yet.** It waits for the parts catalogue (#25).
- **Next run.** Once #98 makes the straight route the default, I'll run the baseline alone on main to confirm the 72. The message-from-base rows should also be rerun on the straight route.
