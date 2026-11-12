# Tried and rejected: holding the track line only within 75 km of land (#327)

Sam (Autopilot & Comms), 12 Nov 2026. Please don't retry this change without a new idea behind it.

## The problem

Within `track_near_land_km` (150 km) of a coast, the autopilot holds its planned track line. Farther out, it aims straight at the next waypoint.

On 1 Apr 2020 a northerly gale pushed the kayak south of the drop. The autopilot then steered almost due north into the wind and the current to get back to its line. It made about 0.4 m/s through the water for some 5 days.

As a result the kayak took 84.7 days, against 73.8 for a boat aimed straight at the finish. That gap is how Leo beat the helm ghost without giving an order (#327).

## What was tried

**On 2020 weather alone, the change looked good.** We shrank the zone to 75 km or 50 km, or capped the intercept angle at 30°. The kayak's 1 Apr voyage fell from 84.7 days to between 65 and 73. The drone's 15 Apr voyage fell from 58 days to 38. But every one of those variants turned Rev C's only 2020 arrival (15 May) into a grounding or a loss.

**The full gate rejected it.** We ran the paired study with `sensitivity.yml`: variant `near75`, branch `claude/study-near75`, 100 launches each, April to June, 2012 to 2021.

| Boat | Arrived, as it stands | Arrived, near75 | Gained / lost | Aground, as it stands → near75 | Median days saved |
|---|---|---|---|---|---|
| v4 kayak (run 43103363960) | 80 | 81 | 4 / 3 (chance 100%) | 0 → 0 | +0.0 |
| Wind-powered drone (run 43107192029) | 80 | 77 | 1 / 4 | **1 → 10** | +0.2 |
| Rev C, our model (run 43118365933) | 20 | 18 | (2 fewer) | **5 → 7** | −1.6 |

## Verdict

- The kayak's gain is noise.
- The drone and Rev C run aground more often. Inside 150 km, the track line is what keeps a boat that tacks or drifts off the coast.

The default stays at 150 km (Maya, 11 Nov). A real fix would have to target the stall itself. One idea is to re-anchor the track line only when the boat has made no progress for a day and is well clear of land. That idea is on the backlog, and nothing is scheduled.

The helm ghost was made fair separately: every game now starts on the ghost's own autopilot (#337).
