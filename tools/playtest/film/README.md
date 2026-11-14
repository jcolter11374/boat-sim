# Film contact sheet from the live site (M5 piece 3, Iris, 14 Nov 2026)

For Nina's manual "film-sheet" check. Five film sequences, each at a real moment of the kayak's own
voyage with nothing forced (John's rule C4: the film shows now and never moves the clock). Elena signs
off the sheets.

Run once PR #561 is live, so the sheets show the build players get.

## The script
`live_sheet.mjs <boat> <sequence> <when> <outdir> [secs=60] [fps=8]`, with `BASE` set to the site.
It opens the sailing screen at High quality, sets sail on the default launch day, sails on at 6 hours a
second (clicking the first choice on any "Your call" card) until the voyage reaches the moment asked
for, pauses the clock, starts the film on that sequence and steps the page clock 1/8 s a frame. So it
films in the page's own time, not wall-clock time: a slow runner only takes longer.

- `SHEET_ONLY=1` saves only the twelve stills the sheet uses (one every 5 s of film), which is what a
  job log can hold. All 480 frames are still rendered, so a part takes as long either way.
- `VW`/`VH`: window size, default 960x540 (the sheet maker's percentages assume 960 wide).
- Writes `<outdir>/fNNNNN.jpg`, `<outdir>.boxes.json` (which shot each frame is, and the boat's box) and
  `<outdir>.info.json` (voyage hour, speed, sun height, wind and waves at the moment filmed).
- Exit 3 with "NEVER REACHED THE MOMENT" if the voyage ends or 25 minutes pass first.

## The five commands (one part each)
```
export BASE=https://jcolter11374.github.io/boat-sim/ SHEET_ONLY=1
node live_sheet.mjs kayak passage   day              out/passage
node live_sheet.mjs kayak storm     hour:209.5       out/storm
node live_sheet.mjs kayak knockdown after-knockdown  out/knockdown
node live_sheet.mjs kayak golden    golden           out/golden
node live_sheet.mjs kayak night     night            out/night
```
What each moment is, from my local runs of the same voyage (default launch, 23 Apr 2020):
- passage: some hours out, by day (sun more than 15 degrees up), making about 2 knots.
- storm: voyage hour 209.5, the roughest hour I found: about 33 knots of wind, 5.3 m waves.
- knockdown: just after the first knockdown the voyage records, about hour 123.5 (28 knots, 4.0 m).
  The script stops the clock there, waits for the knockdown's own camera move to finish, then starts the film.
- golden: the first hour after 6 with the sun 1 to 6 degrees up.
- night: the first hour after 6 with the sun more than 12 degrees under the horizon (about hour 13).

If the live voyage differs from my local one (it should not: same launch day, same choices), storm
still films whatever hour 209.5 holds; check `out/storm.info.json` says a gale.

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
