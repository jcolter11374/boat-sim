# Replay check: eight stale replays regenerated (24 Nov 2026)

**What was wrong.** The "Replay check" on main re-sails every saved voyage replay
(`sea3d/public/voyages/`) from its seed and fails if the simulator no longer produces the
same file. It was red on every push to main from 14 Nov (commit bb6b81d) to 24 Nov, always
on the same eight files. The Monday scheduled run shows green, but that run only keeps the
currents cache warm and checks nothing.

**Which changes made the replays drift.** Found from the check's own log on each push to main:

| Change (14 Nov) | Replays it made stale | What differs |
|---|---|---|
| #529, keelboats can be rolled by a breaking wave | 31 ft cruiser 2020-04-15 | She is knocked down three times in one gale (hours 97.3, 101.2 and 112.5, in 9.1, 10.1 and 7.2 m seas) with no damage. She arrives 8 hours later, mostly because of #552: she now rides that gale under storm sail at about 3.6 m/s where the old file had full sail at about 4.4 m/s. |
| #547, the results card says what rolled a boat and how big the sea was | Randolph Rev B 2020-04-01, Rev C 2020-05-01 | Only the wording of the loss: "stuck inverted or keel lost" now ends "(breaking seas, Hs 4.9 m)" and "(breaking seas, Hs 8.9 m)". Track, timing and outcome are unchanged. |
| #552, keelboats reef (carry less sail) by the wind, not only by how far they lean | all six 31 ft cruiser replays | She is slower in strong wind: the first difference on 2020-05-01 is 3.96 to 3.77 m/s through the water in a 12.4 m/s wind (about 24 knots). |

All three are meant changes to the simulator with their own tests. The check's numbers were
the same on 14 Nov and on 24 Nov, so nothing has drifted since. None of it is a simulator bug.

**What was done.** The "Voyage replays" workflow was run three times on the branch, for
`configs/stock_cruiser31.yaml`, `configs/randolph_rev_b.yaml` and `configs/randolph_rev_c.yaml`
(2020, months 4 5 6; runs 45439326814, 45443330796, 45446093914). Only the eight stale files
and `index.json` changed; the other ten replays of those boats came out identical.

**31 ft cruiser, before and after.**

| Launch | Before | After |
|---|---|---|
| 2020-04-01 | aground at the Azores (38.61N 28.08W), day 28.58 | lost near land ("taken or snagged by fishermen"), day 32.07 |
| 2020-04-15 | arrived, 16.70 days | arrived, 17.03 days, three knockdowns |
| 2020-05-01 | not finished after 150 days | not finished after 150 days (track differs) |
| 2020-05-15 | arrived, 22.42 days | arrived, 22.40 days |
| 2020-06-01 | lost near land, day 41.78 | lost near land, day 41.78 (track differs) |
| 2020-06-15 | arrived, 22.07 days | arrived, 22.03 days |

**To repeat.** Actions, "Voyage replays", Run workflow on a branch with the boat's design
file and "commit" ticked; one boat at a time, because runs on one branch cancel each other.
Then "Replay check" by hand on that branch.

**Left open.** Three knockdowns in about 15 hours on the 2020-04-15 cruiser looks high against the comment in `configs/stock_cruiser31.yaml` (a one-in-three chance of a roll in a 12-hour storm of 8 m seas; here the seas were 7 to 10 m). It is one launch, so it proves nothing, but the knockdown rate from #529 is worth a look. Separately: A change to the simulator can merge with the Replay check red, since the
check on main only reports. That is how this stayed red for ten days.
