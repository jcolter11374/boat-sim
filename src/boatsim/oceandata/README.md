# oceandata: real weather and ocean for the simulator

Owner: Priya (Ocean Data). Everything here runs in the cloud (thread sandboxes,
GitHub Actions). Nothing is bulk-downloaded: each voyage fetches only the days
it uses, cropped to the route box (25°N to 60°N, 82°W to 5°E), and caches them
under `data/` (ignored by git). Set `BOATSIM_DATA` to put the cache elsewhere.

```python
from boatsim.oceandata import ReanalysisEnvironment, ERA5Source, GlorysSource

env = ReanalysisEnvironment(ERA5Source(), GlorysSource())
env.sample(datetime(2020, 10, 15, 12), 37.0, -70.0)  # -> EnvState
```

```
python -m boatsim.oceandata fetch-era5 2020-10-01 2020-12-31   # pre-warm the cache
python -m boatsim.oceandata fetch-glorys 2020-10 2020-12       # needs Copernicus login
python -m boatsim.oceandata sample 2020-10-15T12:00 37 -70 --no-currents
```

## Sources

| Field | Source | Grid | Account |
|---|---|---|---|
| Wind at 10 m, wave height, peak period, wave direction, sunlight (GHI), cloud, air temp | ERA5 hourly reanalysis (Hersbach et al. 2020, doi:10.1002/qj.3803) via Google's public ARCO-ERA5 Zarr, `gs://gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3` | hourly, 0.25° (waves are 0.5° model output regridded) | none |
| Surface current (top level, 0.49 m) | Copernicus Marine GLORYS12, product GLOBAL_MULTIYEAR_PHY_001_030 (doi:10.48670/moi-00021), datasets `cmems_mod_glo_phy_my_0.083deg_P1D-m` then `..._myint_...` from mid-2021 | daily mean, 1/12° | **free login needed** |
| Second-opinion surface current (`SmocSource`, for checks only) | Copernicus Marine SMOC, product GLOBAL_ANALYSISFORECAST_PHY_001_024 (doi:10.48670/moi-00016), dataset `cmems_mod_glo_phy_anfc_merged-uv_PT1H-i`: `kind="model"` = daily mean of uo/vo; `kind="total"` = hourly utotal/vtotal (adds tides and Stokes drift) | daily mean or hourly, 1/12°, Gulf Stream box 33-46N 78-40W, from 1 Nov 2020; about 5 MB (model) or 115 MB (total) a month | **same free login** |

ERA5 coverage in the store (checked 8 Nov 2026): final data 1940 to 30 Jun 2026,
preliminary ("ERA5T") to 2 Nov 2026. GLORYS starts 1993, so voyages that need
currents can launch from 1993 on.

## Conventions and conversions

- Wind and current are (east, north) components in m/s. Wave direction is
  where waves come FROM, degrees true (ERA5's own convention, same as `EnvState`).
- Sunlight: ERA5 stores the energy that fell in the hour ending at each time
  stamp (J/m²). We divide by 3600 to get mean W/m² and treat it as valid at the
  middle of that hour. This is sunlight on a flat horizontal surface, before
  any panel losses (the vessel model applies those).
- GLORYS daily means are stamped 00:00; we move them to 12:00, the middle of
  the day they average, before interpolating.
- Interpolation: bilinear in space, linear in time; wave direction averaged as
  a unit vector. Land points (NaN) are skipped, so a boat near the coast uses
  the sea-side grid points. A point with no sea data around it reads 0.
- Cache files are packed to 16-bit integers. Kept resolution: wind 0.01 m/s,
  wave height 1 mm, current 1 mm/s, sunlight 0.05 W/m², air temp 0.01 °C.

## Measured sizes (8 Nov 2026, this sandbox, 4 parallel workers)

ARCO-ERA5 keeps each hour as one global chunk, so reading our box still pulls
the whole globe for that hour. That sets the transfer cost.

| What | Measured |
|---|---|
| Pulled from the cloud per hour of data (8 fields, compressed) | 18.0 to 18.2 MB |
| Pulled per cached day (26 hours, to cover midnight) | 473 MB |
| Cached on disk per day (route box, packed) | 10.1 to 10.4 MB |
| Oct to Dec 2020 (92 days): fetch time / disk | 114 s / 936 MB |
| One year of ERA5 cache (extrapolated from the above) | about 3.7 GB, about 8 min |
| 1993 to 2025 (all launch years with currents) | about 120 GB, about 4 to 5 h |
| 90-day voyage with a warm cache (stub boat) | 15 s |

GLORYS12, measured in GitHub Actions on Oct 2020: 25 MB per month on disk
(about 0.3 GB per year). Gulf Stream peak that month: 2.51 m/s at 37.2N 71.7W.

## Ship traffic (traffic.py, issue #13)

`EnvState.ship_density` is the number of ships per km² at any moment. The
vessel's ship-strike odds use it directly (vessel/hazards.py).

* **EMODnet vessel density** (Europe, Azores, part of the eastern Atlantic):
  hours of ship presence per km² per month, 2022 and 2023 averaged.
  Hours per km² per month ÷ 730.5 hours in an average month = ships per km²
  at any moment. This is an exact identity, no assumption.
* **World Bank / IMF global AIS counts** (everywhere else, including the US
  side and open ocean): AIS position reports per 0.005 degree pixel, Jan
  2015 to Feb 2021. About 7.5% of the pixels in our box are corrupt (values
  of ~1.7 million or ~25 million where real counts stop near 100); they are
  masked. The corrupt pixels are mostly the busiest ones: the share of
  corrupt pixels in a 0.1 degree cell rises steadily with EMODnet's traffic
  (2.7e-6 ships/km² under 2% corrupt, 7.7e-4 over 40%). So outside EMODnet
  we look up the EMODnet median for the cell's (corrupt share, remaining
  count) band, from a table fitted where both maps exist. Holdout test
  (fit on alternate 1 degree columns, test on the rest): typically within a
  factor of 1.6 of EMODnet, 90% within a factor of 3.9 (one plain scale
  factor: 1.6 and 5.5).
* Built in GitHub Actions ("Build ship density" workflow; tick "commit" to
  commit the result) into a 0.1 degree map, `data/traffic/ship_density_v1.nc`.
  This is the one data file kept in git; both sources are CC BY 4.0
  (credits in THIRD_PARTY_NOTICES.md). The runner uses it when present.
  If it's missing, the runner warns and runs with no ships, except in the
  batch workflows, which set `BOATSIM_REQUIRE_SHIPS=1` and fail.
* Spot values (build of 9 Nov 2026), ships per km²: drop point off the Bay
  mouth 1.2e-3, Gulf Stream at 38N 70W 1.2e-5, mid-ocean at 40N 45W 2.0e-5,
  Azores 2.7e-4, off Lisbon 2.4e-3.
* Limits: one average map, no seasons; ships that don't carry AIS (many
  fishing boats and yachts) are missing from both sources; the table is
  fitted on European water and applied to American water.

## Storm check (storms.py, issue #13)

"Check storms against IBTrACS" compares ERA5's highest wind within 200 km of
each storm centre with NOAA's best-track maximum wind, for every 6-hourly
point inside the route box. ERA5's 25 km grid is known to understate
hurricane cores; this measures by how much on our route.

Result, 2012 to 2021 (121 storms, 2,607 best-track points in the route box,
run on 9 Nov 2026; 637 ERA5 days, 11 minutes in Actions). Ratio is ERA5's
peak within 200 km ÷ best-track 1-minute wind; 0.93 would be perfect:

| Storm class | Points | Best track (median) | ERA5 peak (median) | Ratio p25 / median / p75 |
|---|---|---|---|---|
| Below storm strength or post-tropical | 1354 | 18.0 m/s | 13.8 m/s | 0.70 / 0.78 / 0.85 |
| Tropical storm (34-63 kt) | 713 | 23.1 m/s | 16.2 m/s | 0.61 / 0.70 / 0.78 |
| Hurricane, category 1-2 | 455 | 38.6 m/s | 24.1 m/s | 0.53 / 0.64 / 0.71 |
| Major hurricane, category 3-5 | 85 | 56.6 m/s | 27.6 m/s | 0.41 / 0.48 / 0.54 |

So ERA5 gives about three quarters of a tropical storm's true peak wind and
about half of a major hurricane's (worst case: Dorian, 1 Sep 2019, 82 m/s in
the best track, 25 m/s in ERA5). Wave heights will be understated near storm
cores too. Voyages that meet a hurricane are therefore safer in the simulator
than at sea. Not corrected yet: see PR #62 for the options.

## Our currents against the Randolph team's (currents_check.py, issue #73)

"Compare currents with SMOC" puts GLORYS12 (ours) beside SMOC on 36-42N,
75-50W, the Gulf Stream stretch both teams' routes cross. SMOC is Mercator's
hourly current and is what Open-Meteo serves to the Randolph team: at 5
points, Open-Meteo's daily mean matched SMOC's total current to within
0.14 m/s. Both are daily means on a 0.25 degree grid, averaged over 6 dates
in 2023 (run of 9 Nov 2026):

| Band | Mean speed GLORYS / SMOC | Mean eastward GLORYS / SMOC | RMS vector difference | Speed correlation | Direction difference (median, where > 0.2 m/s) |
|---|---|---|---|---|---|
| 75-70W | 0.38 / 0.37 | 0.10 / 0.09 | 0.38 | 0.74 | 16° |
| 70-65W | 0.39 / 0.41 | 0.13 / 0.12 | 0.40 | 0.74 | 20° |
| 65-60W | 0.46 / 0.48 | 0.16 / 0.15 | 0.47 | 0.67 | 25° |
| 60-55W | 0.46 / 0.48 | 0.16 / 0.15 | 0.46 | 0.63 | 26° |
| 55-50W | 0.43 / 0.45 | 0.13 / 0.13 | 0.41 | 0.63 | 24° |
| all | 0.43 / 0.44 | 0.135 / 0.132 | 0.43 | 0.69 | 22° |

All in m/s, comparing ocean-model currents only (SMOC `uo/vo`). With SMOC's
tides and Stokes drift added (`utotal/vtotal`, daily mean), SMOC runs about
0.05 m/s faster, and its mean eastward current is 0.140 m/s.

What it means: on average both sources push a boat east by the same amount,
so neither should make crossings systematically faster. Point by point,
though, they differ by about as much as the current itself, because each
model puts its eddies and Gulf Stream meanders in different places. The
agreement gets worse going east. So one voyage can differ a lot between the
two simulators, while averages over many launches should agree.

## Waves and wind against NOAA buoys (buoys.py, issue #10)

"Check ERA5 against buoys" compares ERA5 with 9 moored NOAA (NDBC) buoys from
Delaware Bay to south of Bermuda, for every hour of 2020 and of 2023 (about
64,000 matched hours each year). "Wave height" here is significant wave
height: roughly the average height of the biggest third of the waves, which
is what a sailor would call "the sea is 2 m". Buoy wind is measured about
4 m above the water and is scaled up to ERA5's 10 m height (about +10%).
Bias = ERA5 minus buoy (run of 9 Nov 2026):

| | Year | Buoy mean | Bias | RMS error | Correlation | ERA5 / buoy, top 1% |
|---|---|---|---|---|---|---|
| Wave height (m) | 2020 | 1.66 | +0.01 | 0.27 | 0.96 | 0.97 |
| Wave height (m) | 2023 | 1.71 | 0.00 | 0.27 | 0.96 | 0.94 |
| Wind at 10 m (m/s) | 2020 | 7.18 | -0.16 | 1.49 | 0.91 | 0.95 |
| Wind at 10 m (m/s) | 2023 | 6.95 | -0.24 | 1.43 | 0.92 | 0.95 |

ERA5 wave height as a fraction of the buoy's, by how big the seas were:

| Buoy wave height | 1-2 m | 2-3 m | 3-4 m | 4-6 m | over 6 m |
|---|---|---|---|---|---|
| 2020 | 1.02 | 0.97 | 0.95 | 0.95 | 0.95 |
| 2023 | 1.02 | 0.97 | 0.95 | 0.93 | 0.90 |

What it means: in ordinary weather ERA5's waves and wind are as good as we
could ask for. Every buoy has a wave bias under 0.1 m. In big seas ERA5 runs
5-10% low (a 7 m sea comes out at about 6.3-6.6 m), and its strongest winds
about 5% low. The worst wind buoy is Diamond Shoals off Cape Hatteras, where
ERA5 is about 0.9 m/s low (it sits near the coast and the grid cell is
partly land). Out at sea (41001, 41048, 41049) the wind bias is 0.2-0.4 m/s.
No correction applied: the errors are small next to the
other unknowns, and slightly low big seas make the simulator a little
optimistic in storms, which the storm check above already flags. NDBC data
is US government work, public domain.

## Land map near the Bay mouth (coast_check.py, issue #11)

"Check land mask near the Bay" tests the runner's 2 km land map
(`data/land/land_mask_v1.npz`, built from Natural Earth 1:10m) on 36.5-37.6N,
76.6-75.4W, where a dead boat is most likely to go ashore in its first days.
It compares the map with GSHHG full resolution (Wessel and Smith 1996,
doi:10.1029/96JB00104, LGPL; since 2026 in NOAA's NCEI archive, accession
0304143), which for the US east coast comes from NOAA's World Vector Shoreline
(run of 9 Nov 2026):

- **Named points: all 11 correct.** The drop point, Thimble Shoal and
  Chesapeake channels, Hampton Roads, the lower James and York, and the lower
  Bay are water. Cape Henry, Cape Charles, Fisherman Island and the Virginia
  Beach shore are land.
- **Nothing is cut off.** Drifting cell by cell from the drop point, a boat
  can reach every one of those water points, including through the roughly 3 km
  gap at Hampton Roads.
- **Cell by cell, against GSHHG (3300 cells):** 159 cells are land in the map
  but mostly water in GSHHG. That is by design: the map marks any cell
  holding a piece of coastline as land, which moves the shore up to 2 km out
  to sea, so a drifting boat counts as aground slightly early. 39 cells go the
  other way (water in the map, mostly land in GSHHG). All of them are in marsh
  creeks and lagoons, such as Back Bay behind Sandbridge, the Eastern Shore
  barrier marshes and the Mobjack Bay shore. None is on a path from the drop.

No fix needed. The Chesapeake Bay Bridge-Tunnel is in neither coastline
(its four islands are about 300 m long), so the simulator lets a boat drift
through the bridge line. Between the islands that is open trestle, and a
kayak would pass under it.
