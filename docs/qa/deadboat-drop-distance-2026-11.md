# How far out should the drop be? Dead-boat drift, 2019 to 2023 (#90)

Ravi (QA), 9 Nov 2026. [Run 42558851387](https://github.com/jcolter11374/boat-sim/actions/runs/42558851387), code acdbeb0 (merged as #94).

**Short version.**
- Suppose the boat dies right after the drop. From today's drop point it drifts back ashore half the time (15 of 30), usually within 3 to 4 days.
- Each step further out helps:

  | Drop distance | Ran ashore |
  |---|---|
  | 50 km | 30% |
  | 100 km | 17% |
  | Shelf edge, about 120 km | 10% |

- From 100 km or further out, the Gulf Stream picks up 80 to 90% of dead boats.
- The drop distance is John's call. This page gives the numbers only, not a recommendation.

## Setup

- **The boat.** A "dead boat" is the v4 kayak with motors off and no steering. Only three things push it:
  - the ocean current (GLORYS12);
  - the wind (ERA5) pushing on its hull;
  - the slow push that waves give anything floating at the surface.
- **Start points.** There are four, on one line running east-south-east from Cape Henry (the south side of the Bay mouth) through today's drop point:
  - today's drop, 29 km (15.6 nautical miles) out;
  - 50 km out;
  - 100 km out;
  - about 120 km out, near the edge of the continental shelf, where the shallow coastal seabed drops off to deep ocean.
- **Launch dates.** The 1st and 15th of April, May and June, 2019 to 2023. That gives 30 drifts per start point.
- **Length.** Each drift lasts 30 days. It stops early if the boat touches land on the shared 2 km coastline map.
- **"Into the Gulf Stream".** The boat was carried east of 72°W. That is the issue's test, about 230 km past the shelf edge.
- **"Days near land".** Time spent within 150 km of a coast. On the crossing record, mission-ending events happen about nine times as often there as in open ocean (#89).

## Results

| Start | Ran ashore (95% range) | Median days to ashore | Into the Gulf Stream (95% range) | Median days to Gulf Stream | Median days near land |
|---|---|---|---|---|---|
| Today's drop (29 km) | 15/30, 50% (33–67%) | 3.5 | 10/30, 33% (19–51%) | 13.2 | 6.5 |
| 50 km | 9/30, 30% (17–48%) | 4.0 | 15/30, 50% (33–67%) | 13.0 | 8.8 |
| 100 km | 5/30, 17% (7–34%) | 5.5 | 24/30, 80% (63–90%) | 8.9 | 5.7 |
| Shelf edge (about 120 km) | 3/30, 10% (3–26%) | 6.2 | 27/30, 90% (74–97%) | 6.5 | 3.2 |

The 95% ranges come from only 30 drifts per point. They overlap between neighbouring start points, so treat the trend as solid and each single number as rough. The drop and the shelf edge don't overlap: 33–67% against 3–26%.

How many ran ashore, by year and by launch month:

| Start | 2019 | 2020 | 2021 | 2022 | 2023 | April | May | June |
|---|---|---|---|---|---|---|---|---|
| Today's drop | 2/6 | 3/6 | 3/6 | 3/6 | 4/6 | 5/10 | 4/10 | 6/10 |
| 50 km | 1/6 | 2/6 | 1/6 | 2/6 | 3/6 | 1/10 | 4/10 | 4/10 |
| 100 km | 0/6 | 2/6 | 1/6 | 0/6 | 2/6 | 0/10 | 3/10 | 2/10 |
| Shelf edge | 0/6 | 1/6 | 1/6 | 0/6 | 1/6 | 0/10 | 3/10 | 0/10 |

Where the ones that ran ashore landed:
- **From the drop and 50 km.** Mostly the beach between Cape Henry and the North Carolina line (36.4–36.9°N), or the barrier islands off Virginia's Eastern Shore (37.1–37.4°N). One went north and landed near Ocean City, MD, on day 29.
- **From 100 km and the shelf edge.** All on the Outer Banks, from Kitty Hawk down to Cape Hatteras (35.2–36.2°N), after 2 to 12 days.
- **Inside the Bay.** None got far in. Two touched Cape Henry itself.

## Ravi's read

- **Today's drop point is a coin flip for a boat that dies early.** Half the drifts from 29 km come ashore, and the median is three and a half days. That is too fast for anything to be done about it, even if anyone wanted to.
- **Every extra kilometre out helps, but the gain is not even.**
  - Going from 29 to 100 km cuts the share that runs ashore by about two-thirds, from 50% to 17%.
  - Going from 100 to 120 km cuts it from 17% to 10%. Those two numbers are close enough to be noise.
- **Further out also gets a dead boat off the coast sooner.** Median days within 150 km of land are 6.5 from the drop and 3.2 from the shelf edge. This is the stretch where #89 says the boat is most likely to die.
  - The column flatters the drop point, because a boat that runs ashore on day 3 stops counting on day 3.
- **The danger moves south as you go out.** Boats that die further out stop washing up near Virginia Beach. When they do come ashore, it is on the Outer Banks. The Gulf Stream passes close to Cape Hatteras, and anything that misses it gets pushed onto the beach there.
- **May is the worst month further out.** May caused 6 of the 8 groundings from 100 km and the shelf edge, but that is 6 out of only 8. April had none from 100 km or further.
- **How this fits with the Randolph team.** They found that dead boats drifted ashore from 25 km and moved their drop to 100 km. These runs agree with both halves of that.

## Caveats

- **Only a boat that dies at the drop.** These runs assume the boat dies the moment it is dropped. The real risk depends on how often it dies in the first days, and that is what the 14-day shakedown in the sensitivity study is about. Multiply the two to get a real number.
- **Windage is a guess.** How hard the wind pushes the hull is still a guess until the tow test. More windage would mean more onshore drift in an easterly wind.
- **One weather source.** Five years of a single reanalysis (ERA5 weather plus GLORYS12 currents) is all we have here.
- **The earlier single run (#73) agrees once the coastline is the same.** On 15 May 2023, #73's run went into the Bay and grounded on day 9.6. This run grounds on the Eastern Shore barrier islands (37.33°N 75.73°W) on day 3.5.
  - #73's own track was at 37.33°N 75.79°W on day 4, the same spot as this run's grounding. The two tracks agree.
  - #73 used the coarse 9 km GLORYS land test, which doesn't see those islands. It let the boat carry on past them into the Bay.
  - A rerun of 2023 launched at midnight (as #73 was), not noon ([run 42566337848](https://github.com/jcolter11374/boat-sim/actions/runs/42566337848)), grounds at 37.34°N 75.74°W on day 3.9. So the start hour isn't the cause.
  - Across 2023, 8 of the 10 noon groundings also happen at midnight, and midnight adds none of its own. Two flip to staying at sea: 1 April from the drop, and 15 June from 50 km. That is the kind of noise a 12-hour shift brings near the coast. It is one more reason to read the table as rough.
