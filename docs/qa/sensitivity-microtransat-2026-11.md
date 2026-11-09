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

## Addendum: confirmed on the straight route (#98)

[Run 42567314818](https://github.com/jcolter11374/boat-sim/actions/runs/42567314818) is on main at dc5ff0d, where the straight route is now the default. It uses the same 100 launches and the same dice as the main run.

| Row | Finished | By day 150 | Gained / lost | Chance | Median days | Ran aground |
|---|---|---|---|---|---|---|
| Today's default (straight route; base re-plans from forecasts) | 72 | 69 | | | 110 | 2 |
| Base never changes the route (still sends a daily "all well") | 78 | 78 | 17 / 11 | 34% | 92 | 1 |
| Base sends nothing at all | 73 | 73 | 19 / 18 | 100% | 92 | 3 |
| Boat checks for base messages on a separate daily call | 77 | 76 | 16 / 11 | 44% | 107 | 1 |
| Old bent route south of the Azores | 55 | 45 | 12 / 29 | 1% | 127 | 10 |

- **72 is confirmed.** It matches the straight-route row of the main run exactly. The old bent route gives 55 here, against 56 there.
- **On the straight route, steering from home no longer prevents groundings.** "Base sends nothing" runs aground 3 times, against 2 for the default. On the bent route it was 28 against 7.
- **Re-planning from forecasts doesn't help, and it costs speed.**
  - With the base re-planning, 72 finish. With the base keeping the route fixed, 78 finish, which is within the noise.
  - The typical voyage is slower with re-planning: 110 days against 92.
  - I haven't traced why. My guess is that the forecast re-planner sends the boat on detours that don't pay off for something this slow.
  - That 18-day gap is large enough to look into. It is for Sam (autopilot and comms): it may mean re-planning should switch on only for specific hazards, such as storms or land, and not every day.
- **The boat's own daily report still matters.** In every one of these rows the boat keeps sending its daily position, including "base sends nothing", where only the base goes quiet. That report keeps the boat inside the silence rule. Only the messages sent from home to steer the boat are in question.

## How often should the base re-plan? Before and after Sam's fix (#106, #107)

In the earlier rows, daily re-planning cost about 18 days (110 against 92). Sam traced it (#107). The base scored each candidate leg by stretching the current at one spot over the thousands of km still to go. That made it re-route the boat almost every day, even with a perfect forecast.

The rows below sweep `min_gain_h`: how many hours a forecast detour must save before the base sends it. Detours around land and the Azores keep-out zone fire in every row. Same 100 launches, 180 days.

| Re-plan when a detour saves at least… | Before #107: finished | Median days | After #107: finished | Gained / lost | Chance | Median days |
|---|---|---|---|---|---|---|
| 6 hours (default) | 71 | 110 | 70 | | | 90 |
| 24 hours | 70 | 107 | 77 | 19 / 12 | 28% | 92 |
| 72 hours | 72 | 106 | 78 | 15 / 7 | 13% | 92 |
| Never (base keeps the route fixed) | 78 | 92 | 78 | 15 / 7 | 13% | 92 |
| Base sends nothing at all | 73 | 92 | 73 | 15 / 12 | 70% | 92 |

The before runs are [42577011450](https://github.com/jcolter11374/boat-sim/actions/runs/42577011450) (ce6027a) and, for the last row, [42567314818](https://github.com/jcolter11374/boat-sim/actions/runs/42567314818). The after run is [42579926504](https://github.com/jcolter11374/boat-sim/actions/runs/42579926504) (00de68d). Gained/lost is measured against the default row of the same run.

- **The fix removes the time cost.** The default row's median voyage falls from 110 to 90 days, level with never re-planning. Before the fix, raising the threshold didn't help: 24 h and 72 h stayed at 106 to 107 days. That fits Sam's diagnosis that the leg score was wrong at any threshold.
- **Re-planning still doesn't add finishes.**
  - After the fix, the 6-hour default finishes 70, and never re-planning finishes 78. That split (15 gained, 7 lost) has a 13% chance of being luck: suggestive, not proven.
  - The 72-hour row is identical to "never" voyage for voyage. On these launches no forecast detour ever saves 72 hours, so the base never sends one.
- **The electronics gap is dice, not wear (answered by Sam).** The default row loses 21 voyages to dead electronics offshore, against 14 when the base keeps the route fixed. Electronics failure rates depend only on days at sea and on whether the electronics tub has leaked. They don't depend on radio use. But every random draw in a voyage comes from one shared stream (`runner/simulate.py`): sensors, hazards, the satellite link and the pinger. Every message the base sends uses up draws. So once the base sends its first route change, every later hazard roll in that voyage differs from the "never" voyage. 21 against 14 is about 1.3 standard deviations, which is noise. Read 70 against 78 as mostly dice too, and don't tune `min_gain_h` on it.
- **What it means for us.** Nothing here shows that daily forecast re-routing from home earns its keep. Only the daily "all well" message and the land and keep-out detours are clearly worth keeping. A 24- to 72-hour threshold is a safe setting whichever way the open question goes.

### Same seeds, same voyages? (determinism check)

The default row read 72 on dc5ff0d but 71 on ce6027a. Between those commits nothing changed in the physics or in the base, only docs, comments and new variants.

- **Only one voyage differed.** I diffed the per-voyage results in the job logs. 99 of 100 baseline voyages were identical to the hundredth of a day.
- **The one that flipped** is the 2018-04-21 launch. On dc5ff0d it arrived on day 130.45. On ce6027a it was lost on day 110.72, both electronics boxes dead in open ocean.
- **The base re-planning path is where it differs.** The same launch with the base keeping the route fixed was identical in both runs.
- **Three test runs on one commit agree.** Runs [42579926504](https://github.com/jcolter11374/boat-sim/actions/runs/42579926504), [42580166618](https://github.com/jcolter11374/boat-sim/actions/runs/42580166618) and [42580169658](https://github.com/jcolter11374/boat-sim/actions/runs/42580169658), all on 00de68d with different variant lists, gave a bit-identical 2018 baseline.
  - So results don't depend on which voyages share a worker, or in what order.
  - The likely cause is a data load that differed between the two earlier runs, such as a silent live fetch mid-run. It is not proven.
- **#108 now guards against this.** Batch runs refuse to fetch mid-run and fail with the file's name instead, so a repeat would show up straight away.
- **Effect on the results.** One voyage in 100 moved, and the gained/lost counts reported here are 10 or more. The conclusions stand.

### What "same dice" really means (applies to the whole study)

Sam's finding above reaches beyond re-planning. Each voyage draws from one shared random stream. Any change that alters the number of draws reshuffles every hazard roll after that point, for the rest of the voyage. Changes that do this include:
- a different route;
- more or fewer messages;
- a different sea state on the satellite link's retries.

So the rows share their dice only until they first diverge. That happens early for comms, route and cruise-power changes. After that, the two rows are closer to independent samples than to true pairs.

**What still holds.**
- The finish counts and their 95% ranges are unaffected.
- The large effects stand: the route, the record-fitted failure rates, one thruster, and 10 W cruise.

**What is weaker.**
- "Gained / lost" pairs flip partly by chance.
- The paired test therefore has less power than it appears. Treat any difference under about 10 voyages as noise, as the caveats already say.

The fix is one random stream per source of chance: hazards, link, sensors, pinger. Maya and Theo own it, and Sam will do the link side. Once it lands, rerun the close calls: the comms rows, battery and panels, and the 25 W cruise.

## Rerun with separate random streams (#110)

[Run 42584093445](https://github.com/jcolter11374/boat-sim/actions/runs/42584093445) was made on main at 99e2bb0. It uses the same 100 launches, 180 days, and a full set of pre-fetched data (#108). After #110, the hull, sensors, satellite link and beacon each draw from their own random stream. Sending an extra message no longer reshuffles the hull's hazard dice. Every seed therefore gets new dice, so the baseline was rerun along with the rest.

**The pairing now works.** Changes that never alter the voyage now give identical voyages: "Half again the battery" and "Bigger panels" both show 0 gained and 0 lost. Under the shared stream they showed 2/1 and 3/1, which was pure dice.

| Row | Finished | Gained / lost | Chance | Median days | Electronics dead offshore | Airtime $ |
|---|---|---|---|---|---|---|
| **Today's default (re-plan when a detour saves 6 h)** | **78** | | | 91 | 15 | 83 |
| Re-plan only for 24 h or more | 75 | 6 / 9 | 61% | 91 | 15 | 82 |
| Re-plan only for 72 h or more | 66 | 5 / 17 | 2% | 95 | 22 | 82 |
| Base never changes the route | 66 | 5 / 17 | 2% | 95 | 22 | 82 |
| Base sends nothing at all | 67 | 6 / 17 | 3% | 94 | 21 | 78 |
| Boat checks for base messages on a separate daily call | 73 | 7 / 12 | 36% | 87 | 18 | 85 |
| Half the battery (640 Wh) | 78 | 4 / 4 | 100% | 94 | 13 | 83 |
| Half again the battery (1920 Wh) | 78 | 0 / 0 | | 91 | 15 | 83 |
| Smaller panels (150 W) | 74 | 4 / 8 | 39% | 92 | 14 | 83 |
| Bigger panels (350 W) | 78 | 0 / 0 | | 91 | 15 | 83 |
| Faster cruise (25 W) | 84 | 16 / 10 | 33% | 76 | 12 | 66 |

- **Course changes from home now look worth having.**
  - With Sam's fix (#107) and real pairing, re-planning beats never re-planning by 78 to 66: 17 voyages gained, 5 lost, about a 2% chance of luck.
  - The 72-hour row is again identical to "never", because no forecast detour ever saves 72 hours.
  - A base that sends nothing at all also falls to 67.
- **The gap is almost all dead electronics offshore: 15 against 22.** Now that the hull dice are shared, that difference has to come through the voyage itself.
  - The likely path: the electronics tub leaks more in big waves, and a wet tub fails six times as often (#91). Weather routing keeps the boat out of the worst seas.
  - I haven't checked that against the wave heights along each track. It is a hypothesis.
- **This reverses the earlier shared-stream result, and that is worth being honest about.**
  - On the old dice, never re-planning led 78 to 70. Pooling both dice sets, the two settings are level: re-planning 148 of 200, never 144 of 200.
  - The new run is the better test, because its pairs are real. The old run's gaps were partly reshuffled dice.
  - Still, one run at 2% is evidence, not proof.
- **24 hours against 6 hours** is within the noise: 75 against 78, 6 gained and 9 lost. Neither costs time (median 91 days either way) or airtime.
- **Battery and panels don't matter in spring**, confirmed with clean pairs. Small panels lean slightly the wrong way (74), but that is within the noise.
- **Cruising at 25 W** finishes 84 of 100 and takes 15 days fewer (76 against 91). It also costs $17 less airtime, because the voyage is shorter. That is 16 gained against 10 lost, a 33% chance of luck: promising, not proven. The cost is a lower minimum battery charge, 38% against 68%.

### Recommendation on re-planning (Ravi; Sam to confirm)

**Keep the default at 6 hours.** Don't raise `min_gain_h`.
- On the truly paired run, re-planning at 6 hours is the best of the rows tested.
- 24 hours is no better.
- 72 hours or more throws away the gain entirely.

Two follow-ups would make this solid:
1. Log the wave height along each track, to check the "fewer wet-tub failures" explanation.
2. Repeat the 6-hour against never comparison on a second set of seeds.
