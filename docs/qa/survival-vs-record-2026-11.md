# Does the simulated boat stay alive as long as real ones did? (#89, step 4)

Ravi (QA), 9 Nov 2026. Data: [run 42597360814](https://github.com/jcolter11374/boat-sim/actions/runs/42597360814) (the fully paired sensitivity run, 100 voyages per variant, April to June launches).

> **Correction (9 Nov, from Theo, #122): this compares the wrong endpoint, so the gap below is overstated, probably by most of its size.**
> - The record ends a boat at its **last report**. Here, "still working" means not lost, aground or disqualified. A boat whose Iridium dies carries on in our sim, reporting through the beacon only, so it still counts as working.
> - Theo's rough count for the historical set offshore gives Iridium-ending failures at about 0.0077 a day: the main box 0.0035, an uncleared software hang 0.001, and Iridium itself about 0.0032. The record, leaving out its rig failures, runs at 0.0080 a day. On the record's own yardstick, the two may roughly agree.
> - Sensitivity runs now log `last_report_day` per voyage (#122). The next batch scores three endpoints: last Iridium report, the boat lost or completely silent, and the boat lost. Read this page's numbers as "boat lost" survival until that batch is in.

**Short version (as first written).**
- No. Even with the "historical" failure rates switched on, our simulated boats keep working far longer than the real boats in the Microtransat crossing record.
- The gap is small in the first week and very large after it:

  | Still working at | Crossing record | Sim, historical rates | Sim, planning rates (today's default) |
  |---|---|---|---|
  | Day 7 | 76% | 89% (83–95%) | 95% (91–99%) |
  | Day 30 | 47% | 86% (79–93%) | 93% (88–98%) |
  | Day 60 | 29% | 78% (70–87%) | 87% (81–94%) |
  | Day 90 | n/a | 70% (62–80%) | 77% (69–87%) |

- So the 60% to 69% odds of finishing are an upper bound until #118 (wear-out) is in. A boat that fails at the record's pace would be lucky to reach the halfway mark.

## How it was counted

- "Still working" means the voyage has not ended in a loss, a grounding, or a disqualification for going silent. Arriving and running out of time (the 120-day cap) count as still working, because neither is a failure of the boat.
- The figures are Kaplan-Meier estimates, the standard way to count survival when some voyages end early for other reasons. The ranges in brackets are 95% ranges.
- The record figures are from #89: the share of past Microtransat entries still reporting their position by satellite.

## What the gap says

- **First week, near land.** The record loses about a quarter of boats in the first 7 days. Historical rates lose 11%, and today's planning rates lose 5%. Part of this is fair: our boat gets a 14-day trial in the Bay first, which the record boats mostly didn't, and that should catch the early faults.
- **Days 7 to 30, open ocean.** This is where the sim is plainly wrong. The record loses about 2% of the remaining boats per day there. Historical rates lose about 0.15% per day, around fourteen times less. From day 30 to day 60, the record's pace is about five times ours.
- **Why.** Our failure rates are constant: a boat on day 80 is no more likely to fail than on day 10. Real kit wears out (salt, chafe, seals, connectors), so failures pile up as the voyage goes on. Our two independent electronics boxes also hide most single failures, because the boat only dies when both go. Most record boats had one box.

## Where the losses happen in the sim

| Variant | Lost near land | Lost in open ocean | Ran aground | Silent too long |
|---|---|---|---|---|
| Planning rates | 7 | 12 | 3 | 3 |
| Historical rates | 11 | 18 | 2 | 4 |

Out of 100 voyages each. "Near land" is within 150 km of a coast, as in #89. Losses in the open ocean are the larger group in both, but the record suggests they should be several times larger still.

## What to do next

- **#118 (wear-out), next on my list.** Fit a failure rate that rises with days at sea to the Randolph team's crossing_attempts.csv, then rerun this table. That is the right fix, and it should close most of the day 7 to 60 gap.
- **A quick bound before that.** Rerun historical rates with `electronics_common_cause: 1.0` (one box's fault kills the boat, as on most record boats). That shows how much of the gap is our two-box design and how much is missing wear-out.
- **Don't drop the shakedown to close the gap.** It doesn't move these numbers (no_shakedown matches baseline here), and the early-week gap is the part we expect to be real.

## Caveats

- 100 voyages per variant, so each figure is good to about ±7 points.
- The record is a small set of mostly hobby boats over many years. It is the best we have, not a precise target.
- In the sim, a boat can go quiet for a few days and come back. The record counts a boat as gone from the last report. That makes the record look slightly worse than the sim for the same boat, but not by anything like this much.
