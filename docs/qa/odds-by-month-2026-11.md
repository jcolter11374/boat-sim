# Odds by launch month: ten years, 8 Nov 2026 (issue #20, first batch)

Run: [Odds by launch month, 2012 to 2021](https://github.com/jcolter11374/boat-sim/actions/runs/42529365758),
code at ec95c22. 240 voyages: the v4 kayak dropped off the Bay mouth at noon on
the 1st and 15th of every month, through each year's real weather (ERA5) and
currents (GLORYS12), with safe mode, Iridium, base-station course corrections,
and Theo's hazards from #52. The HTML report (Iris's `viz.html`) is the
`odds-by-month` artifact on the run page.

## Ravi's read

- **Launch month matters more than anything else we've tested.** April to July
  launches arrived 19 or 20 times out of 20 (95 to 100%). September to November
  launches arrived 7 to 10 times out of 20 (35 to 50%).
- **The autumn problem is sunlight.** Sep to Feb launches got 1.8 to 3.4 kWh/m²
  of sun a day, so the panels made 280 to 530 Wh/day against 840 to 940 in
  spring and summer. Safe mode cut the motors to 8 to 14 W on average, and
  the battery bottomed out at 11 to 22%. Slow boats spend longer at sea, where
  every other hazard keeps rolling the dice.
- **Overall: 182 of 240 arrived (76%, 95% range 70 to 81%)** with the
  "unknown failure" catch-all switched off.
- **How the 58 failures ended:** 26 still at sea after 150 days, 19 stuck
  upside down or lost the keel, 13 had both electronics boxes die.

## Don't read 76% as the real chance

The single biggest unknown is the catch-all for failures nobody has modelled
yet (`unknown_p_by_60_days`). Putting it back gives:

| Unknown-failure guess (chance of a fatal surprise by day 60) | 3% | 10% | 25% | 50% | 84% |
|---|---|---|---|---|---|
| Overall odds | 73% | 67% | 53% | 33% | 8% |
| Best month (April) | 96% | 88% | 71% | 44% | 12% |
| Worst month (October) | 33% | 30% | 23% | 13% | 3% |

3% is the design doc's figure. The Microtransat record (about 2 finishes in
30+ attempts) and the Randolph team's own 10 to 20% estimate both sit at the
pessimistic end. Nothing in our simulator can tell us which end is right; only
real hardware time at sea can (the Bay trial, then a long shakedown).

These odds are also still **optimistic** because:

- The base station sees a perfect forecast (#12 not merged yet).
- No ship traffic yet (#13), so no collisions.
- Every boat is built exactly to the design numbers (no spread on drag,
  solar derate or fouling yet: the rest of #20).

## What would change the odds most (for #21)

- **Launch in April to July.** It costs nothing and gives about three times the odds of an
  autumn launch in every row of the table above.
- Anything that makes surprises less likely: bench and sea testing of the
  electronics, a long shakedown before the real launch.

## Full report (from the run)

| Launch month | Voyages | Arrived | Odds (95% range) | Median days if arrived | Sun kWh/m²/day | Solar Wh/day | Avg drive W | Lowest charge |
|---|---|---|---|---|---|---|---|---|
| Jan | 20 | 15 | 75% (53% to 89%) | 103 | 3.12 | 430 | 11.2 | 15% |
| Feb | 20 | 14 | 70% (48% to 85%) | 84 | 3.40 | 526 | 13.8 | 22% |
| Mar | 20 | 19 | 95% (76% to 99%) | 96 | 4.99 | 769 | 15.0 | 45% |
| Apr | 20 | 20 | 100% (84% to 100%) | 76 | 5.40 | 842 | 15.0 | 60% |
| May | 20 | 19 | 95% (76% to 99%) | 81 | 6.04 | 936 | 15.0 | 66% |
| Jun | 20 | 19 | 95% (76% to 99%) | 74 | 6.02 | 931 | 15.0 | 68% |
| Jul | 20 | 19 | 95% (76% to 99%) | 67 | 5.44 | 840 | 15.0 | 65% |
| Aug | 20 | 15 | 75% (53% to 89%) | 83 | 4.27 | 660 | 14.7 | 37% |
| Sep | 20 | 10 | 50% (30% to 70%) | 101 | 2.27 | 357 | 9.3 | 11% |
| Oct | 20 | 7 | 35% (18% to 57%) | 129 | 2.03 | 305 | 8.3 | 11% |
| Nov | 20 | 10 | 50% (30% to 70%) | 99 | 1.82 | 284 | 7.7 | 11% |
| Dec | 20 | 15 | 75% (53% to 89%) | 92 | 1.84 | 291 | 8.3 | 12% |

## Odds as a range: the 'unknown failure' guess

The odds above have the catch-all hazard for failures we haven't modelled (unknown_p_by_60_days) switched off. This table puts it back at several values, from the design doc's 3% up to 84%, which on synthetic weather brings the odds down to about 15%, inside the 3-20% of the Microtransat record and the Randolph team's own estimate. Each arrival is weighted by its chance of surviving that hazard for as long as it took.

| Launch month | Voyages | unknown 3% by day 60 | unknown 10% by day 60 | unknown 25% by day 60 | unknown 50% by day 60 | unknown 84% by day 60 |
|---|---|---|---|---|---|---|
| All | 240 | 73% | 67% | 53% | 33% | 8% |
| Jan | 20 | 72% | 65% | 51% | 30% | 7% |
| Feb | 20 | 67% | 62% | 49% | 30% | 8% |
| Mar | 20 | 91% | 83% | 66% | 40% | 10% |
| Apr | 20 | 96% | 88% | 71% | 44% | 12% |
| May | 20 | 92% | 84% | 68% | 42% | 12% |
| Jun | 20 | 92% | 84% | 69% | 44% | 12% |
| Jul | 20 | 92% | 85% | 69% | 44% | 13% |
| Aug | 20 | 72% | 66% | 53% | 33% | 9% |
| Sep | 20 | 48% | 44% | 34% | 20% | 5% |
| Oct | 20 | 33% | 30% | 23% | 13% | 3% |
| Nov | 20 | 48% | 44% | 34% | 20% | 5% |
| Dec | 20 | 72% | 65% | 52% | 31% | 7% |

How voyages ended:

| Ending | Voyages |
|---|---|
| arrived | 182 |
| still at sea | 26 |
| stuck inverted or keel lost | 19 |
| both electronics boxes dead: silent and uncontrolled | 13 |
