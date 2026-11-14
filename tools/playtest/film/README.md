# Film contact sheet from the live site (M5 piece 3, Iris, 14 Nov 2026)

For Nina's manual "film-sheet" check. Five film sequences, each at a real moment of the kayak's own
voyage with nothing forced (John's rule C4: the film shows now and never moves the clock). Elena signs
off the sheets.

Run once PR #561 is live, so the sheets show the build players get.

## The script
`live_sheet.mjs <boat> <sequence> <when> <outdir> [secs=60] [fps=8]`, with `BASE` set to the site.
It opens the sailing screen at High quality, sets sail on the default launch day, sails on (a day a
second while an hour target is far off, then 6 hours a second, then 1 hour a second near the moment) (clicking the first choice on any "Your call" card) until the voyage reaches the moment asked
for, pauses the clock, starts the film on that sequence and steps the page clock 1/8 s a frame. So it
films in the page's own time, not wall-clock time: a slow runner only takes longer.

- `SHEET_ONLY=1` saves only the twelve stills the sheet uses (one every 5 s of film), which is what a
  job log can hold. All 480 frames are still rendered, so a part takes as long either way.
- `VW`/`VH`: window size, default 960x540 (the sheet maker's percentages assume 960 wide).
- Writes `<outdir>/fNNNNN.jpg`, `<outdir>.boxes.json` (which shot each frame is, and the boat's box) and
  `<outdir>.info.json` (voyage hour, speed, sun height, wind and waves at the moment filmed).
- Exit 3 with "NEVER REACHED THE MOMENT" if the voyage ends or `MAX_MIN` minutes (default 25) pass first. On a runner set `MAX_MIN=120`.

## The five commands (one part each)
```
export BASE=https://jcolter11374.github.io/boat-sim/ SHEET_ONLY=1 MAX_MIN=120
node live_sheet.mjs kayak passage   day              out/passage
node live_sheet.mjs kayak storm     gale             out/storm
node live_sheet.mjs kayak knockdown after-knockdown  out/knockdown
node live_sheet.mjs kayak golden    golden           out/golden
node live_sheet.mjs kayak night     night            out/night
```
Two more, once #585 (Landfall and Company) is live; on an older build the sequence name is unknown:
```
node live_sheet.mjs kayak landfall  coast            out/landfall
node live_sheet.mjs kayak company   ship             out/company
```
- coast: land within 40 km (the film's own `land` test, the same one #585 picks Landfall from), sun over
  10 degrees up, no storm. Read from `__helm.cine.host.moment().land`. Most likely in the first hours, near the start.
- ship: another ship within 5 km (#585's COMPANY_KM), sun over 10 degrees up, no storm. Read from
  `__helm.cine.host.moment().ship.km`. The run drops to 1 hour a second while any ship is within 6 km.
What each moment is, from my local runs of the same voyage (default launch, 23 Apr 2020):
- passage: some hours out, by day (sun more than 15 degrees up), making about 2 knots.
- storm: the first daylight hour with 27 knots of wind or more (sun over 10 degrees up). Not hour 209.5 as
  first written: that hour is at night, so the sheet would have been black.
- knockdown: just after the first knockdown the voyage records, about hour 123.5 (28 knots, 4.0 m).
  The script stops the clock there, waits for the knockdown's own camera move to finish, then starts the film.
- golden: the first hour after 6 with the sun 1 to 6 degrees up. Locally this was the next sunrise (hour 22.4):
  the first evening went by between two looks at 6 hours a second.
- night: the first hour after 6 with the sun more than 12 degrees under the horizon (about hour 13).

Each `.info.json` records the hour, sun height, wind and waves actually filmed; check them against the above.

## The sheets
```
FR=out OUT=out/sheets python3 sheet.py passage   # and storm, knockdown, golden, night
```
(needs Pillow and numpy; `mkdir -p out/sheets` first). Each sheet is 12 stills in 3 rows with the
shot's name and how much of the frame the boat fills under each.

## What to send back
The five sheets, the five `.info.json` files and the stills, in a folder for Elena and me.

## Not tried
I could not run this against the live site (my machine cannot reach it). Locally, against my own build,
the night command ran clean for 12 s of film; the other four moments were reached by the same loop
in my knockdown and gale proofs, but not by this exact script.

## Changes after the first live run (14 Nov, Nina's run 43598778218)
- The page now checks for the moment and stops its own clock in the same step, and the script drops to 1 hour a
  second when the sun gets low (golden, night) or an hour target is near, so a slow runner cannot sail past it.
- `MAX_MIN` sets the cap; hour targets far off start at a day a second (storm at hour 209.5 was still at 158 after 25 min).
- The knockdown wait steps the page's own time until the knockdown's camera move ends, instead of waiting in real time.
- storm now uses `gale` (a daylight gale found by the wind reading), since the roughest hour I had named is at night.
- golden now also needs a fairly clear sky (cloud cover 0.5 or less, as the film's own rule after #576), so the sheet
  shows a golden hour the film would really choose, not an overcast one.

## Landfall and Company in Practice at Annapolis (Elena, 14 Nov)
On a crossing these two almost never come up (the start is offshore; the finish is 350 km off Lisbon), so they
are filmed in Practice, where land and the Bay's traffic are near. `PRACTICE=1` opens `helm.html?practice` at a
practice hour, takes the first course, sails by hand in real time, and films when the moment comes; if it doesn't
within `WAIT_S` seconds (default 90) it tries the next hour in `HOURS` (default 8, 8.5, ... 17: ships are placed by the hour).
```
PRACTICE=1 node live_sheet.mjs kayak landfall coast out/landfall
PRACTICE=1 node live_sheet.mjs kayak company  ship  out/company
```
The boat is Practice's own (the Pearson), not the kayak. Locally: coast can't be tried (no land files in a local
build); ship found no ship within 5 km at ten hours (nearest 14 km), so exit 3 is possible: widen HOURS or WAIT_S.
