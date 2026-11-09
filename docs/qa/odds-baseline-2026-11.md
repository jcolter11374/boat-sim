# Odds baseline with forecast error, with and without spread (9 Nov 2026, closes #20)

Two runs on the same code (534c637, after Priya's forecast error #58), 240
voyages each: launches on the 1st and 15th of every month, 2012 to 2021, real
weather (ERA5) and currents (GLORYS12), safe mode, Theo's hazards (#52).

- **Baseline, no spread:** [run 42536847837](https://github.com/jcolter11374/boat-sim/actions/runs/42536847837)
- **With spread** (each boat's drag, solar loss and fouling rate varied, #57):
  [run 42536849734](https://github.com/jcolter11374/boat-sim/actions/runs/42536849734)

Both runs' reports still say "perfect forecast until #12 lands". That line is
stale: these runs did use #58's forecast error. #60 fixes the wording.

## Chosen launch window: April to June

| | Arrived (unknown failures off) | 95% range | With unknown-failure guess 3% / 10% / 25% / 50% / 84% |
|---|---|---|---|
| **Baseline (no spread)** | **56 of 60 (93%)** | 84 to 97% | about 90 / 82 / 67 / 41 / 11% |
| With spread | 55 of 60 (92%) | 82 to 96% | about 89 / 81 / 65 / 40 / 10% |
| Old run (perfect forecast, #56) | 58 of 60 (97%) | 89 to 99% | about 93 / 85 / 69 / 43 / 12% |

(Sweep values are averages of the April, May and June rows below.)

## Ravi's read

- **The honest baseline for an April to June launch is about 93% before
  unknown failures, and between about 90% and 11% once they're counted.**
  Which end is right depends on how often a real boat meets a fatal surprise
  we haven't modelled. Only sea time can settle that.
- **Spread changes almost nothing:** 189 vs 186 of 240 overall, 56 vs 55 of
  60 for April to June. Our guessed uncertainty in drag, solar loss and
  fouling isn't what decides the voyage. Weather, season and hazards are.
- **Forecast error didn't measurably hurt.** The only simulator change between
  the old run and this baseline is #58. The old run got 182 of 240 (76%) and
  58 of 60 in April to June. This one got 189 of 240 (79%) and 56 of 60. Both
  differences are inside the noise. That suggests the base station's course
  corrections are worth little either way, which matters for airtime cost
  (an output to minimise): worth testing in #21 whether a simpler, cheaper
  base policy does as well.
- **Season still dominates:** September and October launches arrive 40 to 50%
  of the time against 90 to 100% from February to June.
- **Still optimistic:** no ship traffic yet (#13).

## Full reports

### Baseline (no spread)

| Launch month | Voyages | Arrived | Odds (95% range) | Median days if arrived | Sun kWh/m²/day | Solar Wh/day | Avg drive W | Lowest charge |
|---|---|---|---|---|---|---|---|---|
| Jan | 20 | 17 | 85% (64% to 95%) | 99 | 2.97 | 451 | 11.9 | 14% |
| Feb | 20 | 19 | 95% (76% to 99%) | 84 | 3.87 | 553 | 13.8 | 24% |
| Mar | 20 | 20 | 100% (84% to 100%) | 85 | 4.81 | 746 | 15.0 | 42% |
| Apr | 20 | 18 | 90% (70% to 97%) | 82 | 5.45 | 848 | 15.0 | 63% |
| May | 20 | 18 | 90% (70% to 97%) | 83 | 6.01 | 934 | 15.0 | 61% |
| Jun | 20 | 20 | 100% (84% to 100%) | 74 | 6.08 | 939 | 15.0 | 72% |
| Jul | 20 | 17 | 85% (64% to 95%) | 82 | 5.02 | 774 | 15.0 | 56% |
| Aug | 20 | 19 | 95% (76% to 99%) | 85 | 4.27 | 659 | 14.8 | 34% |
| Sep | 20 | 9 | 45% (26% to 66%) | 102 | 2.36 | 369 | 9.7 | 12% |
| Oct | 20 | 8 | 40% (22% to 61%) | 101 | 1.89 | 297 | 8.2 | 11% |
| Nov | 20 | 12 | 60% (39% to 78%) | 119 | 1.85 | 292 | 8.0 | 11% |
| Dec | 20 | 12 | 60% (39% to 78%) | 110 | 2.01 | 293 | 7.9 | 12% |

## Odds as a range: the 'unknown failure' guess

The odds above have the catch-all hazard for failures we haven't modelled (unknown_p_by_60_days) switched off. This table puts it back at several values, from the design doc's 3% up to 84%, which on synthetic weather brings the odds down to about 15%, inside the 3-20% of the Microtransat record and the Randolph team's own estimate. Each arrival is weighted by its chance of surviving that hazard for as long as it took.

| Launch month | Voyages | unknown 3% by day 60 | unknown 10% by day 60 | unknown 25% by day 60 | unknown 50% by day 60 | unknown 84% by day 60 |
|---|---|---|---|---|---|---|
| All | 240 | 76% | 69% | 55% | 33% | 8% |
| Jan | 20 | 82% | 74% | 58% | 34% | 8% |
| Feb | 20 | 91% | 83% | 67% | 40% | 10% |
| Mar | 20 | 96% | 88% | 71% | 43% | 11% |
| Apr | 20 | 87% | 79% | 64% | 39% | 10% |
| May | 20 | 87% | 79% | 64% | 40% | 11% |
| Jun | 20 | 97% | 89% | 72% | 45% | 13% |
| Jul | 20 | 82% | 75% | 60% | 37% | 9% |
| Aug | 20 | 92% | 83% | 67% | 41% | 10% |
| Sep | 20 | 43% | 39% | 31% | 19% | 5% |
| Oct | 20 | 38% | 35% | 27% | 16% | 3% |
| Nov | 20 | 58% | 52% | 41% | 23% | 5% |
| Dec | 20 | 58% | 52% | 41% | 24% | 5% |

How voyages ended:

| Ending | Voyages |
|---|---|
| arrived | 189 |
| still at sea | 23 |
| stuck inverted or keel lost | 14 |
| both electronics boxes dead: silent and uncontrolled | 13 |
| left the weather box | 1 |

### With spread

| Launch month | Voyages | Arrived | Odds (95% range) | Median days if arrived | Sun kWh/m²/day | Solar Wh/day | Avg drive W | Lowest charge |
|---|---|---|---|---|---|---|---|---|
| Jan | 20 | 16 | 80% (58% to 92%) | 100 | 2.94 | 428 | 11.5 | 15% |
| Feb | 20 | 17 | 85% (64% to 95%) | 84 | 3.76 | 560 | 13.8 | 22% |
| Mar | 20 | 18 | 90% (70% to 97%) | 93 | 4.96 | 753 | 15.0 | 43% |
| Apr | 20 | 18 | 90% (70% to 97%) | 84 | 5.73 | 921 | 15.0 | 65% |
| May | 20 | 18 | 90% (70% to 97%) | 87 | 5.93 | 952 | 15.0 | 67% |
| Jun | 20 | 19 | 95% (76% to 99%) | 83 | 6.08 | 942 | 15.0 | 69% |
| Jul | 20 | 16 | 80% (58% to 92%) | 78 | 5.16 | 796 | 15.0 | 58% |
| Aug | 20 | 16 | 80% (58% to 92%) | 92 | 3.84 | 598 | 13.8 | 25% |
| Sep | 20 | 10 | 50% (30% to 70%) | 107 | 2.42 | 355 | 9.3 | 12% |
| Oct | 20 | 9 | 45% (26% to 66%) | 114 | 1.92 | 297 | 8.1 | 11% |
| Nov | 20 | 13 | 65% (43% to 82%) | 102 | 1.85 | 279 | 7.7 | 12% |
| Dec | 20 | 16 | 80% (58% to 92%) | 120 | 2.34 | 330 | 9.2 | 12% |

## Odds as a range: the 'unknown failure' guess

The odds above have the catch-all hazard for failures we haven't modelled (unknown_p_by_60_days) switched off. This table puts it back at several values, from the design doc's 3% up to 84%, which on synthetic weather brings the odds down to about 15%, inside the 3-20% of the Microtransat record and the Randolph team's own estimate. Each arrival is weighted by its chance of surviving that hazard for as long as it took.

| Launch month | Voyages | unknown 3% by day 60 | unknown 10% by day 60 | unknown 25% by day 60 | unknown 50% by day 60 | unknown 84% by day 60 |
|---|---|---|---|---|---|---|
| All | 240 | 75% | 68% | 54% | 32% | 8% |
| Jan | 20 | 77% | 70% | 55% | 32% | 7% |
| Feb | 20 | 82% | 75% | 60% | 36% | 9% |
| Mar | 20 | 87% | 79% | 62% | 37% | 9% |
| Apr | 20 | 87% | 79% | 63% | 39% | 10% |
| May | 20 | 87% | 79% | 63% | 39% | 10% |
| Jun | 20 | 92% | 84% | 68% | 42% | 11% |
| Jul | 20 | 77% | 71% | 57% | 36% | 10% |
| Aug | 20 | 77% | 70% | 56% | 34% | 8% |
| Sep | 20 | 48% | 43% | 34% | 20% | 4% |
| Oct | 20 | 43% | 39% | 31% | 18% | 4% |
| Nov | 20 | 62% | 56% | 44% | 26% | 6% |
| Dec | 20 | 77% | 69% | 54% | 32% | 7% |

How voyages ended:

| Ending | Voyages |
|---|---|
| arrived | 186 |
| still at sea | 27 |
| stuck inverted or keel lost | 16 |
| both electronics boxes dead: silent and uncontrolled | 11 |
