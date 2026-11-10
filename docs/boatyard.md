# Boatyard grid: file format for the yard page

Finish odds need 100 voyages over ten years each, too many for the browser
sandbox (docs/sandbox.md), so a grid of builds is simulated ahead of time by
`boatsim.mc.boatyard` (workflow "Boatyard grid") and written to
`sea3d/public/boatyard/`. The page looks a build up by its id, shows its odds and
plays a replay; a sandbox run shows the nearest grid build's odds.

## Builds

Eighteen builds of the v4 kayak, picked from Sam's parts catalog
(`boatsim.sandbox.catalog.GRID`): the kayak as it stands at 25 W cruise; 10, 15,
20 and 30 W cruise; each modelled option changed on its own (one thruster, solar
200 and 300 W, battery 640 and 2560 Wh, one electronics box, no beacon, no AIS,
no antifouling); one box with no beacon; the big-energy build (300 W, 2560 Wh) at
25 and 30 W; and everything cheapest at 15 W.

Ids are `k-p{cruise W}` plus each non-default modelled choice as
`-{slot}.{option}`, e.g. `k-p25-thr.one-t200` (`catalog.grid_id`). Options with
no effect yet in the simulator are left out of the id. The design as it stands
is `k-p25`, and its index entry has `"current": true`. With one box, a box
failure stops the autopilot and the Iridium radio. The Globalstar beacon keeps
reporting while the boat drifts, until it fails too.

Two more builds use our model of the Randolph Rev B. These are for display only
and are not their numbers:

- `revb`: as published.
- `revb-spar`: a stronger wing spar. This is a GUESS: a tenth of their published
  wing damage per knockdown, standing in for the 30–32 mm spar they are moving to.

## `index.json`

```jsonc
{
  "schema": 2,
  "slots": {"thr": ["two-t200", "one-t200"], ...},       // catalog option ids per slot
  "defaults": {"thr": "two-t200", ..., "cruise_w": 25},  // the kayak as it stands
  "current": "k-p25",
  "stride_h": 6,                 // hours between replay rows
  "units": {"h": "hours since launch", "lat": "deg N", ...},
  "odds_source": {"years": [2012, 2021], "months": [4, 5, 6], "voyages_per_build": 100, "note": "..."},
  "commit": "abc1234",           // code the grid was run on
  "builds": [
    {
      "id": "k-p25",
      "boat": "v4 kayak",        // or "Randolph Rev B": which model to draw
      "label": "25 W cruise, kayak as it stands",
      "options": {"thr": "two-t200", ..., "cruise_w": 25},  // every slot; Rev B: {"wing": ...}
      "current": true,
      "odds": {
        "voyages": 100, "finished": 78,
        "odds": 0.78, "low95": 0.69, "high95": 0.85,   // Wilson 95% range
        "within_150": 78, "median_days": 75.0,
        "odds_unknown_10": 0.74,   // with a 10% "unknown failure" chance by day 60 put back
        "endings": {"arrived": 78, "lost at sea": 12, ...}
      },
      "replays": [
        {"file": "k-p25/2020-04-01.json", "start": "2020-04-01T12:00", "outcome": "arrived", "days": 71.7},
        ...                        // the 1st and 15th of April, May and June
      ]
    }
  ]
}
```

`odds` is null for a build the odds batch didn't run. The odds come from April
to June launches every 10 days over ten years of real weather and currents. Every
build gets the same seeds, so a difference between two builds comes from the
change, not the weather. Voyages are scored by the Microtransat rules on our
target, with the "unknown failure" guess off. Headline `odds`, and show
`low95`–`high95` beside it.

## Replay files (`<id>/<date>.json`)

These use the same schema as `sea3d/public/voyages/*.json` (`replay/data.ts`
loads them), made smaller:

- One row every `stride_h` hours, plus the last row. Interpolate between rows,
  as the voyage page already does.
- No `ghi`, `current_u` or `current_v` columns (sunlight sampled every 6 h
  aliases day and night). `lat` and `lon` are given to 0.001 deg.
- No `units`; they are in the index.
- The routine satellite-traffic events (`message_sent`, `message_received`,
  `mission_updated`) are left out. Every notable event stays. The gear light
  won't flash on reports.
- Extra keys: `build` (the id) and `stride_h`.

The seeds are the voyage replays' seeds, so `k-p25` replays the same
voyages as `sea3d/public/voyages/voyage_<date>.json`, thinned.
