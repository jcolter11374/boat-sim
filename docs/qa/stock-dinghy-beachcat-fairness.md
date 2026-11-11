# QA: 14 ft dinghy and 16 ft beach cat (stock vessels, #224), fairness check

Ravi (QA), 11 Nov 2026, on main at fb9ba49. I used the boats' own `step()`, with 40 seeds per cell, the boat on a beam reach, and constant weather.

## Does the capsize rule fire only on squalls and breaking seas? Yes, in the simulator on the server

Each cell gives boats knocked flat out of 40 within 24 h, in a 0.3 m sea (too small to break):

| Wind | Rain | Dinghy | Beach cat | Cruiser |
|---|---|---|---|---|
| 4–16 m/s | dry | 0 | 0 | 0 |
| 8 m/s | 1 mm/h | 5 | 1 | 0 |
| 12 m/s | 1 mm/h | 18 | 0 | 0 |
| 4–12 m/s | 3 mm/h | 40 | 40 | 0 |
| 16 m/s | any | 0 (sails down above 15 m/s) | 0 (sails down above 13 m/s) | 0 |

Breaking seas, dry, 48 h:

| Wind, sea | Dinghy | Beach cat | Cruiser |
|---|---|---|---|
| 8 m/s, 2 m | 0 | 0 | 0 |
| 12 m/s, 3 m | 20 (median 26 h) | 0 | 0 |

Steady wind alone never flips them, the cruiser never flips, and a capsize always ends the voyage (`stays_over: 1`). Rain does the work, as described.

Plain notes:
- The gust model is relative: gusts are a spread around the mean wind. So 3 mm/h of rain flips a crewless dinghy even in an 8-knot breeze (52% an hour). Its sail is trimmed close to its limit already (18° of heel).
- The beach cat needs a much bigger breaking crest than the dinghy. It survives the 3 m sea that sinks the dinghy, so "1,000 times the cruiser's rate" holds for the dinghy, not the cat.

## Three things to fix or say

1. **No rain in the browser, so no squalls there.** The sandbox weather bundle (`forcing_2020.npz`, what Take the helm and the Boatyard sail on) has no rain field. On the page these two boats would only ever capsize in breaking seas. On the server they also capsize in every shower. Their odds would differ hugely between the page and the grid, and not by chance.
   - Fix: add rain to the bundle (one more int16 plane) before either boat sails in the browser. Until then, the page should not offer them, or should say "no squalls in this weather".
2. **The capsize odds depend on the rain field's resolution.** The odds rise steeply with rain: 1 mm/h gives 4% an hour for the dinghy at 12 kn, and 3 mm/h gives 99%. A coarser or smoother rain field (6-hourly, 1°) gives far fewer capsizes than hourly 0.25° ERA5. Report these boats' odds from one data source only, and name it.
3. **The breakdown odds default to the kayak's,** the same as the cruiser (see stock-cruiser31-fairness.md): two independent electronics boxes. A tiller pilot is one box. Set `electronics_boxes: 1`.

What's fine already:
- Power budgets are small but positive: the dinghy has 50 W for 120 Wh/day, the cat 100 W for 150 Wh/day.
- Sails come down in storms.
- The cruiser is unchanged.
- Both boats are "stock vessel" class, so the leaderboard won't rank them against the kayak (rule 7).

## Verdict

- They are **fair to sail and compare on the server** (CPython, ERA5 with rain), once electronics_boxes is set.
- They are **not ready for the browser** until the sandbox bundle carries rain.
