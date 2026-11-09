# Does the simulated boat stay alive as long as real ones did? (#89, step 4)

Ravi (QA), 9 Nov 2026. Data: [run 42597360814](https://github.com/jcolter11374/boat-sim/actions/runs/42597360814) (the fully paired sensitivity run, 100 voyages per variant, April to June launches).

## Results on the record's yardstick: read this first

[Run 42623431597](https://github.com/jcolter11374/boat-sim/actions/runs/42623431597), main at caf3a68 (after #122). The same 100 spring launches and the same dice as every other run. Theo spotted that the first version of this page compared the wrong thing, and this section fixes it.

**Short version.**
- The record ends a boat at its **last satellite report**. Scored that way, our simulated boats fail at close to the record's pace in the first week and offshore. They still last somewhat longer than the record overall.
- So most of the big gap in the first version came from how it was counted, not from failure rates that are far too kind. Some of the gap is real.
- About a third of our finishers arrive with Iridium already dead, and only the beacon still reporting. They still count as finishes under the race rules (see the step 5 section below).

**Still reporting by Iridium** (the record's yardstick; finishers count as surviving):

| Day | Record | Sim, historical rates | Sim, planning rates (today's design) |
|---|---|---|---|
| 7 | 76% | 81% | 92% |
| 30 | 47% | 63% | 83% |
| 60 | 29% | 49% | 69% |
| 90 | n/a | 31% | 49% |

- **Offshore loss rate**, counted as Iridium loss per day:
  - historical set: 1.1% from day 7 to day 30, and 0.8% from day 30 to day 60;
  - record: 1.3% offshore, or 0.8% without its rig and weather failures.
  - So on this yardstick the historical rates sit inside the record's range. Theo's estimate of 0.0077 a day was about right.
- **Where the historical set is still kinder than the record:** the near-land days, and boats lasting to day 60 (49% against 29%). The record's figures mix all directions and many years of hobby boats, so part of that gap may be the boats rather than our model.

**Three ways of scoring the same voyages** (share surviving at day 30 / day 60):

| Variant | Finished (of 100) | (a) Iridium still reporting | (b) still heard at all, by Iridium or beacon | (c) not lost | Arrived on beacon only |
|---|---|---|---|---|---|
| Planning rates (design as it stands) | 78 | 83% / 69% | 93% / 88% | 94% / 90% | 24 |
| Historical rates | 69 | 63% / 49% | 89% / 82% | 89% / 83% | 38 |
| Historical, electronics boxes rarely fail together (10%) | 69 | 61% / 46% | 92% / 81% | 92% / 82% | 40 |
| Historical, one fault kills both boxes | **51** | 59% / 39% | 76% / 58% | 76% / 59% | 24 |
| Historical, stuck upside down 10x as often | 66 | 60% / 46% | 86% / 79% | 86% / 80% | 38 |
| Historical, stuck upside down 30x as often | 64 | 60% / 45% | 86% / 77% | 86% / 78% | 37 |
| Planning, wear-out (best fit) | 79 | 86% / 72% | 95% / 90% | 96% / 92% | 23 |
| Planning, fast wear-out | 86 | 91% / 80% | 96% / 93% | 97% / 95% | 22 |
| Historical, fast wear-out | 76 | 85% / 68% | 94% / 88% | 94% / 89% | 30 |

What it says:
- **The two electronics boxes are worth about 18 finishes** under record rates: 69 with our design against 51 if one fault takes out both. Whether they fail together 10% or 30% of the time makes no difference.
- **Iridium is the weak link, not the boat.** Under historical rates, 38 of the 69 finishers arrive with Iridium dead. Our boat still counts as arriving because the beacon keeps reporting, and the race rules allow that (see the step 5 section below).
- **Capsizes that leave the boat stuck upside down** cost 3 finishes at 10x the guessed rate, and 5 at 30x. They are a small part of the gap.
- **Wear-out doesn't make things worse here.** The fitted curves keep the record's average rate, but move failures later. Since most of our voyages end around day 75, fewer of them meet the late failures, and the finish rate rises (79 and 86). That is an artefact of fitting the shape to the record's average. Report wear-out as a sensitivity, not as a correction.

**Bottom line for the odds.** The 78% headline uses planning rates. On the record's yardstick, the historical rates now match the record offshore, so 69% is a fair "record-like" figure, with a range of about 59 to 77%. We no longer have reason to think 69% is far too kind. The weak point is reporting, not survival: a third of the arrivals rely on the beacon alone.

## Finishing with Iridium alive, or on the beacon only (#89 step 5)

Under the race rules, a finish on the beacon alone still counts (Maya's reading, 9 Nov, of the 2021 rules John chose):
- B1: "Competitors are free to decide how this information is obtained and transmitted."
- D5: the boat finishes if it "add[s] at least one point to its GPS log or transmit[s] a position update" inside the target.

Our Globalstar beacon pings every 6 hours, which matches the rules' 6-hour reporting interval, and the silence check already counts those pings. So both kinds of arrival are finishes. They are still worth showing apart, because a boat on the beacon alone can't be sent new routes from home.

Same run (42623431597). "Beacon only" means Iridium's last report came 2 or more days before arrival.

| Variant | Finished | With Iridium working | Beacon only | Iridium died (median day) | Beacon-only days at arrival (median) |
|---|---|---|---|---|---|
| Planning rates (design as it stands) | 78 | 54 | 24 | 44 | 36 |
| Historical rates | 69 | 31 | 38 | 20 | 48 |
| Historical, one fault kills both boxes | 51 | 27 | 24 | 24 | 46 |

- With the design as planned, about 1 finisher in 3 sails the last month or so on its stored route, with no help from home. Under record-like rates it's more than half.
- Iridium is the part most worth making tougher. A second, independent Iridium path is the obvious idea, but it costs money, so that is a decision for John with an itemised plan, not something this page recommends.

## First version (kept for the record): the "boat lost" endpoint



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

- "Still working" means the voyage has not ended in a loss, a grounding, or a disqualification for going silent. Arriving and running out of time (hitting the voyage time limit) count as still working, because neither is a failure of the boat.
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
