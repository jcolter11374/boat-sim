# Re-scoring the Randolph team's Rev C5 their way (Nov 2026)

The Randolph team asked us (issue #50) to score their Rev C5 in our simulator with their
route and their finish rule, to set beside the 48.0% their own simulator gives. This note
records what we ran and what came out.

## What we ran

- Boat: `configs/randolph_rev_c.yaml` (their file, Rev C5), our model of it.
- Variant: `randolph_way` in `src/boatsim/mc/sensitivity.py`. Drop 10 km off Ocean City
  (38.32N 74.97W), any landfall in Europe counts (the Azores don't), every voyage ends on
  30 November of its launch year.
- Weather: 2023, ERA5 wind and waves, GLORYS12 daily currents.
- Launches: one a day at 12:00 UTC from April to June ("Sensitivity study" workflow,
  `every_days` 1, `variants` randolph_way, `design` configs/randolph_rev_c.yaml). Their
  window is 1 May to 15 June, which is 46 of those launches. The numbers below are read
  from the per-voyage table in the run log for those 46.

## Results

| Run | Route | Arrived | Aground | Lost | Still at sea 30 Nov | Silent too long |
|---|---|---|---|---|---|---|
| 44881885941 (21 Nov) | straight line to 51.4N 10.0W | 3 of 46 (7%) | 29 | 13 | 1 | 0 |
| 45007384950 (22 Nov) | via 42.0N 48.0W to 51.35N 9.70W | 19 of 46 (41%, 95% range 28% to 56%) | 6 | 11 | 9 | 1 |

Their figure: 48.0% (41.9 to 54.2) verified arrivals on 250 voyages, median crossing 121
days. Ours on the second run: median 130 days.

- **The first run measured our route, not their boat.** A straight line (great circle)
  from Ocean City to south-west Ireland crosses Nova Scotia and Newfoundland: 11 boats
  grounded near Cape Sable, 4 on Newfoundland, 5 around Nantucket and Sable Island, 9 on
  the Maryland shore.
- **With their waypoint the two simulators agree within our noise.** Their waypoint keeps
  the boat south of the Grand Banks. All 6 groundings left are on the Maryland and
  Virginia shore within 10 days of the drop. Of the 11 lost, 5 were taken or snagged by
  fishermen, 5 were stuck upside down or lost the keel in breaking seas of 6 to 12 m, and
  1 had a dead electronics box.

## How their run differs from ours

Their set-up is in their comment on #50 of 21 Nov 2026 and in
`collab/bulk_mc_2023_10km.json` in sheltonr2/drone-boat.

- 250 launches at random times, against our 46 daily ones.
- A waypoint counts within 25 km; land is checked 15 km ahead every 10 minutes. Ours uses
  our own waypoint and land rules.
- They finish within 40 km of the target or on any landfall in Europe, and count only
  arrivals that were still reporting or tracked (48.0%), leaving out 6.8% that arrived
  silent or drifting. Most of our voyages ended as they crossed 11W, about 90 km short of
  their circle, and we don't make that split.
- Their weather is ERA5 wind with SMOC currents and MFWAM waves.

## Things to know before running it again

- `max_days` must keep the baseline row inside the weather the job fetches (to 5 January):
  240 failed with `era5_20240106.nc not cached` (run 45005044915); 187 works. The
  `randolph_way` row ignores it and runs to 30 November.
- Run artifacts can't be downloaded from a thread sandbox. Read the per-voyage rows from
  the log: `gh run view <id> --log | grep "randolph_way 2023-"`.
- `randolph_way` is for Rev C5 only: its route starts at the Ocean City drop. Rev E1 drops
  45 km off Hatteras (34.95N 75.35W) and sails via 35.0N 74.9W, 42.0N 48.0W, 49.6N 7.2W,
  49.7N 6.4W and 49.83N 5.8W to a holding point at 49.85N 5.20W (their comment on #50,
  21 Nov 2026). Scoring Rev E1 needs a variant with that route; running it through
  `randolph_way` would send it 376 km up the coast first.
- Open question: our crossings are about 9 days slower at the median and 9 boats were
  still at sea on 30 November.
