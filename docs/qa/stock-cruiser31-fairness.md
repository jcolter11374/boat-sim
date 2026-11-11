# QA: the 31 ft cruiser (stock vessel, #221), fairness check

Ravi (QA), 11 Nov 2026, on main at d2d0e01.

## Can it be mixed into the kayak rankings? No

- **Boatyard and race view.** The cruiser is not a Boatyard build (`boatyard.BUILDS`), so the page, the grid, the race view (#209) and `pick()` can't select it. `pick()` refuses unknown ids.
- **Leaderboard.** The default entries are an explicit list of drone builds. The board now also records each entry's class: "stock vessel" if the design has a `stock:` block, otherwise "small autonomous boat". `check_board` fails a board that mixes classes (rule 7). A test checks that no Boatyard build is a stock vessel, so adding the cruiser to the grid later trips it.

## Is its physics honest? Mostly, with three things to fix before it races anything

1. **Its power runs out, and then it sails unsteered.**
   - The budget: the yaml's hotel load is 960 Wh a day (autopilot about 30 W average). Two 100 W panels behind the boom (×0.75 shading) make about 600 Wh a day in good May sun. Nothing else charges the batteries: the diesel has no alternator in the model, and there's no hydro-generator.
   - The test: constant weather (westerly 7 m/s, 1.5 m sea, 220 W/m² sun all day, which is generous), hazards off, 20 days.
   - With 200 W of solar, the battery is at 29% by day 6 and 2% by day 12, then cycles near empty. The boat ends at 61.3W **34.6N**, sagging south off the route, because the autopilot keeps cutting out.
   - With 400 W it stays at 100% and ends at 55.6W 41.5N.
   - This isn't a cheat, but it would make the stock boat look bad for a GUESS reason. A real single-handed ocean yacht carries a towed hydro-generator, more solar, or charges from the engine. Pick one and mark it GUESS.
2. **Its breakdown odds are the kayak's, by default.** The yaml sets only knockdown damage. Everything else falls back to the kayak's table:
   - **Two independent electronics boxes** (`electronics_boxes: 2`). That redundancy is worth about 18 points on the kayak. A stock yacht has one autopilot computer unless we fit a spare. Set it to 1, or say on the card that we fitted a second.
   - **Leaks never sink it.** The kayak is foam-filled, so a leak only wets a tub. A holed 31 ft yacht with no crew to pump can sink. At least `p_lost_given_strike` and the leak effect need a keelboat value (GUESS).
   - **Capture by fishermen near land**: 1% a day, the kayak's figure. An empty yacht near land gets salvaged or reported at least as often. Keep the figure, but mark it GUESS on the card.
   - Fishing-line wraps use the kayak's rates and its ×4 drag. That's plausible for a prop and keel; leave it.
3. **The speed fit is in-sample.** "Within 4.3% of the ORC certificate" is measured on the same points the four free numbers were fitted to (cl_max, cd0, wave-making size, wave resistance). That's fine for a stock boat, but say "fitted to" rather than "checked against" anywhere John reads. The 0.93 autopilot factor is a GUESS, and downwind is honestly slower (no spinnaker).

What's honest already:
- The gust capsize is immune by construction for a ballasted keel.
- Knockdowns are sized by its own 9.5 m length.
- It uses the same dice block (thruster slots it doesn't have), so paired races stay in step.
- Its badges would be: breaks the race's 2.4 m cap, and a diesel engine (30 L).

## Verdict

- It is **fine as a free-sail stock boat** in the 3D view now.
- It is **held from any odds, race or board result** until items 1 and 2 are set in its yaml. Item 3 is wording only.
