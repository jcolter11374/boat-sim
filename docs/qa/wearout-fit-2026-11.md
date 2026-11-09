# Do failures pile up as the voyage goes on? Wear-out fit to the crossing record (#118)

Ravi (QA), 9 Nov 2026. Data: the Randolph team's `docs/data/crossing_attempts.csv` (MIT, not copied here). Script: [`docs/qa/scripts/wearout_fit.py`](scripts/wearout_fit.py).

**Short version.**
- **The record can't tell.** Ten boats in the record reached open ocean, and eight of them failed there. Those ten are consistent with failures getting likelier with time at sea, and just as consistent with a steady rate. The best fit leans towards wear-out, but not by enough to count (p = 0.25), and the simpler steady-rate model scores better on AIC.
- **Wear-out isn't what's wrong with our sim.** The steady rate the record gives in open ocean is about 1.3% of boats per day. #120 put our "historical" set at 0.15% to 0.3%, but that was on the "boat lost" endpoint. The record's endpoint is the last report. Measured that way, Theo's rough count puts our historical set at about 0.8% a day, roughly the record's rate without rig failures. See "The level" below.
- **What's in this PR.**
  - `wearout_multiplier()`, with a parameter table both teams can use.
  - A knob for it in our hazards, off by default. Today's results don't change.
  - Three sensitivity variants, so the next batch run shows what wear-out would cost.

## The data

Only boats that got past the near-land band (about 150 km from a coast) say anything about open ocean. The near-land and open-ocean split is the Randolph team's.

| | Count |
|---|---|
| Boats that reached open ocean | 10 |
| Failed there | 8: 3 rig or weather damage, 4 went silent (2 of them erratic first), 1 lost to an antenna fault and then picked up |
| Censored (still going when the record stops) | 2: one finisher (73 days offshore), one that crossed and was lost near land |
| Open-ocean exposure | 622 boat-days |

Failures came at 19, 27, 35, 41, 45, 66, 72 and 74 days offshore. Only five boats were still out after day 45, which is why the shape can't be pinned down.

## Fits

All fits are by maximum likelihood, with the two censored boats counted as surviving to their last day.

| Model | Result | Log-likelihood | AIC |
|---|---|---|---|
| Steady rate | 0.0129 per day (95%: 0.0055 to 0.0253) | -42.83 | **87.66** |
| Weibull (rate can rise or fall) | shape k = 1.41 (95%: 0.75 to 2.24) | -42.17 | 88.33 |
| Two rates, change at day 30 | 0.0070, then 0.0178 per day | | p = 0.22 |
| Two rates, change at day 60 | 0.0107, then 0.0192 per day | | p = 0.44 |

- Shape k above 1 means wear-out. The 95% range runs from 0.75 (failures getting rarer) to 2.24 (strong wear-out), so it includes "no change" (k = 1).
- The likelihood-ratio test of Weibull against a steady rate gives 1.33 on 1 degree of freedom, p = 0.25.
- The two-rate models tell the same story: a change at day 30 looks like wear-out, and a change at day 45 shows none.

## The parameter table

`rate(t) = base_open_ocean_rate × wearout_multiplier(t, params)`, where t is days in open ocean and `wearout_multiplier = (t / t_ref)^(k − 1)`.

| Row | k | t_ref (days) | Multiplier at day 10 / 45 / 90 | Use |
|---|---|---|---|---|
| none | 1.00 | — | 1.00 / 1.00 / 1.00 | What AIC picks; the default |
| central | 1.41 | 34.9 | 0.60 / 1.11 / 1.47 | Best fit |
| low | 0.75 | 22.7 | 1.23 / 0.84 / 0.71 | Bottom of the range |
| high | 2.24 | 48.6 | 0.14 / 0.91 / 2.15 | Top of the range: the stress test |

- t_ref is the day the shaped rate equals the steady one fitted to the same record.
- With base = 0.0129 per day, the central row reproduces the fitted Weibull to within 1%.
- For a simulator whose own open-ocean rates differ, the multiplier carries only the shape. The level is a separate question (below).
- The function has no dependencies beyond the Python standard library, so it can be copied as is: `src/boatsim/vessel/wearout.py`.

## In our simulator

- **The knob.** `HazardParams.wearout_k` and `wearout_t_ref_days` default to 1 and 35, which switches it off.
  - Rate sets and YAML can each set their own value. Every set leaves it off for now, because the record doesn't justify switching it on.
- **What it multiplies.** The hardware rates (leaks, electronics boxes, Iridium, beacon, steering, thrusters), and only while the boat is beyond 150 km from land.
  - The clock is days spent offshore so far, kept in `KayakState.days_open_ocean`.
  - Capture and entanglement are unchanged.
- **Variants.** `wearout_central` and `wearout_high` on the planning set, and `historical_wearout_high` on the historical set. They join the next sensitivity batch run.
- **No change to today's results.** No new dice are drawn, so voyage-by-voyage pairing with earlier runs holds.

## The level, and which endpoint

- **First pass (#120): a level gap.** On the "boat lost" endpoint, our historical set loses about 0.15% of boats a day offshore from day 7 to day 30, and 0.3% from day 30 to day 60. The record loses 1.3%, or 0.8% without its three rig and weather failures (95%: 0.26% to 1.9%).
- **Theo's correction: wrong endpoint.** The record ends a boat at its last report. In our sim, losing Iridium leaves the boat sailing and reporting through the beacon only, so it isn't "lost". Here is how Theo maps the record's 8 open-ocean failures onto our boat:
  - 2 silent: the main box or Iridium. Either way, Iridium ends.
  - 2 erratic then silent: the main box or a software hang. Iridium ends.
  - 1 antenna fault then capture: Iridium.
  - 3 rig or weather: no rig to map them onto. The nearest thing is knockdown damage.
- **The rough count.** For the historical set offshore, after day 14, in 1.8 m waves:
  - main box: 0.0035 a day;
  - software hang that doesn't clear: 0.001 a day;
  - Iridium: about 0.0032 a day.
  - That is about 0.0077 a day of Iridium-ending events, against the record's 0.0080 without rig failures.
- **So the rates may be about right, and #120 compared the wrong thing.**
- **Next batch.** Sensitivity runs now log `last_report_day` and `last_heard_day` for each voyage. They will score three endpoints:
  - (a) last Iridium report: the record's yardstick, compared with 0.0129 and 0.0080;
  - (b) the boat lost, or Iridium and beacon both silent;
  - (c) the boat lost.
  - Plus `electronics_common_cause` at 0.1, 0.3 and 1.0 (1.0 is the record-like bound for (c), not our expected value), and knockdown damage x10 and x30 as a bound for the rig and weather share.
- Wear-out variants are reported as sensitivity only, since the range for k includes 1.

## Result of the endpoint batch (run 42623431597)

- **On the record's yardstick, the historical set matches the record offshore.** Counting the end as the last Iridium report, it loses 1.1% a day from day 7 to day 30, and 0.8% from day 30 to day 60. The record loses 1.3%, or 0.8% without its rig failures. Theo's estimate was right.
- **Wear-out variants raise finishes rather than lower them:** 79 and 86, against 78. They keep the record's average rate but push failures past day 45, after many boats have already arrived. Treat them as sensitivity only.
- **One fault killing both boxes (common cause 1.0)** drops finishes from 69 to 51. Capsizes that leave the boat stuck upside down cost 3 finishes at 10x and 5 at 30x.
- Details are in [survival-vs-record-2026-11.md](survival-vs-record-2026-11.md).

## Caveats

- Ten boats is very few. Treat every number here as rough.
- The near-land and open-ocean split is estimated from each boat's average speed, not from tracks.
- Record boats were mostly sailing boats from many years and builders. Our kayak's kit is different.
- The clock is days offshore, not total days at sea. Boats left the near-land band after 3 to 9 days, so the difference is small.
