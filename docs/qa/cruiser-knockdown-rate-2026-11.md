# The 31 ft cruiser's knockdown rate against what it was fitted to (24 Nov 2026)

**Why this was looked at.** The regenerated replay of the cruiser launched 2020-04-15 shows three
knockdowns (the boat thrown flat or past it by a breaking wave) in about 15 hours of one gale
(`docs/qa/replay-check-regenerated-2026-11.md`). The comment in `configs/stock_cruiser31.yaml`
says the model was fitted so that a 10 m yacht has a one-in-three chance of a roll in a 12-hour
storm with 8 m seas. Three in one gale looked high against that.

**How it was measured.** Not by a batch of voyages. The simulator draws knockdowns from one
formula, `knockdown_rate_per_hour` in `src/boatsim/vessel/hazards.py`, so the rate can be read
straight from it. `docs/qa/scripts/cruiser_knockdown_rate.py` does that for a range of sea
heights, and for each saved cruiser replay adds up the rate over the voyage's own hourly sea and
wind. Run: `PYTHONPATH=src python docs/qa/scripts/cruiser_knockdown_rate.py`.

**Result 1: the replay matches the model.** The 2020-04-15 gale reached 10.1 m seas (significant
wave height, Hs: the average of the highest third of the waves), not 8 m. Over that voyage the
formula expects 3.13 knockdowns; the replay shows 3. The other five replays expect 0.00 to 0.01
and show none. So the simulator does what the formula says. Nothing is broken in how knockdowns
are drawn.

**Result 2: the fit point is reproduced, for a 10 m yacht.** 12-hour storm, 11 s waves, 25 m/s
wind (the fit's storm), with only the sea height varied. In the real 2020-04-15 gale the wind
was 21 to 23 m/s at the 10 m peak, a little under the table's 25:

| Sea height Hs | 10 m yacht: expected knockdowns (chance of one or more) | The 9.5 m cruiser | Chance that storm sinks the cruiser |
|---|---|---|---|
| 6 m | 0.00 (0 %) | 0.01 (1 %) | 0.0 % |
| 7 m | 0.05 (4 %) | 0.11 (10 %) | 0.4 % |
| 8 m | 0.39 (32 %) | 0.77 (54 %) | 3.8 % |
| 9 m | 1.70 (82 %) | 2.93 (95 %) | 13.6 % |
| 10 m | 4.90 (99 %) | 7.60 (100 %) | 31.6 % |
| 11 m | 10.70 (100 %) | 15.37 (100 %) | 53.6 % |

The 32 % at 8 m is the one-in-three the comment promises.

**What is worth knowing.**

1. *The cruiser is not the yacht the fit used.* She is 9.5 m, and the critical breaker scales
   with length, so the same storm gives her a 54 % chance of a roll, not a third.
2. *The rate climbs very steeply with sea height.* From 8 m to 10 m seas the expected knockdowns
   go up twelve-fold for a 10 m yacht (0.39 to 4.90) and ten-fold for the cruiser (0.77 to 7.60).
   That steepness comes from the shape of the formula (the share of breakers taller than the
   critical height), not from any data above 8 m. The model has one fitted point, the 1979
   Fastnet storm, and that storm's 8 m is itself marked GUESS in the test.
3. *The config comment is easy to misread.* It says "33-43 % for Hs 7-9 m". That is not a
   chance of a roll. It is the critical breaker height, as a share of hull length, that the fit
   would give if the Fastnet sea was 7 to 9 m and not the guessed 8 m (solving for one-in-three:
   32.7 % at 7 m, 37.4 % at 8 m, 42.1 % at 9 m). So the comment agrees with the code. Read as
   odds, it suggests a much flatter response than the model has: the chance of a roll for a 10 m
   yacht is 4 %, 32 % and 82 % at 7, 8 and 9 m. A clearer wording would be "the fit would be
   33-42 % of length if the storm was Hs 7-9 m".
4. *In a 10 m sea the cruiser is close to doomed over 12 hours* (about a one-in-three chance
   of sinking, 7 or 8 knockdowns expected). Whether real 31 ft yachts fare that badly is not
   something this note can settle; there is no second storm in the fit to check against.

Each knockdown sinks her with a chance that grows with the sea and is capped at 5 % from 8 m up
(2.8 % at 6 m, 3.8 % at 7 m), so above 8 m the chance a storm sinks her follows the number of
knockdowns.

**Not measured.** How often a cruiser crossing meets 9 m or 10 m seas. One of the six saved
April to June 2020 launches did. A real answer needs a batch of cruiser crossings over several
years; the "Odds by launch month" workflow only runs the kayak today.

**Nothing in the simulator was changed.** Retuning this changes how the game plays, so it is
John's call. The options as they stand: leave it; soften the rate above the fitted 8 m (for
example a cap on knockdowns per storm, or a second fit point); or first run a cruiser batch to
see how much of her record this decides.
