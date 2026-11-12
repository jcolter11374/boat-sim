# Proof frames and clips

One way to make proof pictures for any branch, instead of each builder's own capture
script and two or three hours of waiting on software graphics.

## From a thread (the usual way)

1. Start the **Proof frames** workflow on your branch: Actions → Proof frames → Run
   workflow (branch, set, runners), or the GitHub API (`workflow_dispatch` on
   `proofs.yml` with `branch`, `set`, `shards`). On a pull request you can add the
   `proofs` label instead (standard set, 4 runners).
2. When it finishes, unpack it into the project folder:

   ```
   tools/proof/fetch.sh <branch>
   ```

   It lands in `/mnt/project-files/simulator/proofs/<branch, / as ->/`: every still as
   PNG, every clip as MP4 with a poster frame, `index.html` (the whole set, with the
   clips playing) and `contact-sheet.png` (one picture of everything, for review).

The standard set on 4 runners takes about 25 minutes end to end, 8 runners about 15.
The team budget is 8 proof runners at once across all proof runs (Kai): a run shrinks when
another is going, and waits (up to 20 min, then fails with "proof queue full") when two are.
Use `quick` while working.

## Sets (tools/proof/shots.json)

| Set | What | Pictures |
|---|---|---|
| `standard` | Kayak and Pearson; calm, force 5, force 8; midday, golden hour, darkest night, moonlit night; 7 views; an orbit at golden hour and a low run in the gale per boat | 168 stills, 4 clips |
| `quick` | Kayak, force 5, golden hour, 3 views | 3 stills |
| `sea` | Kayak; every sea at midday and dusk; chase, low, long lens | 18 stills |
| `sky` | Kayak in a calm, dawn to night (dark and moonlit); wide views | 18 stills |
| `boats` | Every boat at force 5, golden hour, close views | 20 stills |
| `cinematic` | The page's cinematic shots (skim, drone, sunset) on both boats | 10 clips |

Views, seas, times and clips are named in `shots.json`; add or tune them there (the
camera is placed from the bow: `az` degrees clockwise from the bow, so 180 is astern).
`--only <regex>` picks units by name, e.g. `kayak-f8`.

## On your own machine or sandbox

```
tools/build_site.sh                      # or: cd sea3d && npm run build
(cd sea3d/dist && python3 -m http.server 4180 &)
node tools/proof/capture.mjs --set quick --out /tmp/proofs
node tools/proof/sheet.mjs /tmp/proofs   # index.html + contact-sheet.png
```

Options: `--set`, `--only`, `--size 1920x1080`, `--quality low|high|ultra`, `--fps 24`,
`--shard 2/4`, `--list` (show the units and stop).

## How it works

- The voyage page (`voyage.html`) draws every shot. Proof hooks on `window.__replay`:
  `cam` (a camera held relative to the bow), `force.sea` (wave height, period,
  direction), `force.wind` and `force.cloud` (the looks), `sunAt(hour)` (to find a time
  of day), and `?drawas=` (draw a replay's boat as another model: the Pearson has no
  replays of its own yet, so it sails the 31 ft cruiser's).
- The page clock is held and stepped exactly 1/fps of page time per frame, however long a
  frame takes to draw (about 2 to 5 s at High on software graphics). So clips are smooth,
  and the waves, boat motion and wake in a still are the same on every run. `Math.random`
  is seeded, so the cinematic picks the same shots too.
- Before each unit the boat settles for 2.4 s of page time at a small window size (cheap),
  then the window goes to full size.
- Forcing the wind changes the sea and the looks, not the boat: heel, reefing and speed
  still come from the replay's own weather. A gale still with full sails up is the
  replay's sail plan, not the sea.
- Shards split the units by cost (a clip costs one unit per frame), the same way on every
  machine.
