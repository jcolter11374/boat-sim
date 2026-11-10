# Boatyard grid: file format for the yard page

The browser can't run the simulator, so every build the yard offers is simulated
ahead of time by `boatsim.mc.boatyard` (workflow "Boatyard grid") and written to
`sea3d/public/boatyard/`. The page looks a build up by its id and plays a replay.

## Builds

The v4 kayak, with four knobs (2 × 5 × 3 × 2 = 60 builds):

| Knob | Values | Id part |
|---|---|---|
| Motors | 1 or 2 (one motor: 50 W burst; two: 100 W) | `m1`, `m2` |
| Cruise power | 10, 15, 20, 25, 30 W | `p10` ... `p30` |
| Battery and panels (together) | small 640 Wh + 150 W, current 1280 Wh + 250 W, large 1920 Wh + 350 W | `es`, `em`, `el` |
| Electronics boxes | 1 or 2 | `b1`, `b2` |

Id: `k-m{motors}-p{cruise W}-e{s|m|l}-b{boxes}`. The design as it stands is
`k-m2-p25-em-b2`, and its index entry has `"current": true`. With one box, a
box failure stops the autopilot and the Iridium radio. The Globalstar beacon
keeps reporting while the boat drifts, until it fails too.

Two more builds use our model of the Randolph Rev B. These are for display only
and are not their numbers:

- `revb`: as published.
- `revb-spar`: a stronger wing spar. This is a GUESS: a tenth of their published
  wing damage per knockdown, standing in for the 30–32 mm spar they are moving to.

## `index.json`

```jsonc
{
  "schema": 1,
  "options": {
    "motors": [1, 2], "cruise_w": [10, 15, 20, 25, 30],
    "energy": [{"id": "s", "label": "small", "battery_wh": 640, "solar_wp": 150}, ...],
    "boxes": [1, 2],
    "id_pattern": "k-m{motors}-p{cruise_w}-e{energy id}-b{boxes}",
    "rev_b": ["revb", "revb-spar"]
  },
  "stride_h": 6,                 // hours between replay rows
  "units": {"h": "hours since launch", "lat": "deg N", ...},
  "odds_source": {"years": [2012, 2021], "months": [4, 5, 6], "voyages_per_build": 100, "note": "..."},
  "commit": "abc1234",           // code the grid was run on
  "builds": [
    {
      "id": "k-m2-p25-em-b2",
      "boat": "v4 kayak",        // or "Randolph Rev B": which model to draw
      "label": "2 motors, 25 W cruise, current battery and panels (1280 Wh, 250 W), 2 electronics boxes",
      "options": {"motors": 2, "cruise_w": 25, "energy": "current", "boxes": 2},  // Rev B: {"wing": ...}
      "current": true,
      "odds": {
        "voyages": 100, "finished": 78,
        "odds": 0.78, "low95": 0.69, "high95": 0.85,   // Wilson 95% range
        "within_150": 78, "median_days": 75.0,
        "odds_unknown_10": 0.74,   // with a 10% "unknown failure" chance by day 60 put back
        "endings": {"arrived": 78, "lost at sea": 12, ...}
      },
      "replays": [
        {"file": "k-m2-p25-em-b2/2020-04-01.json", "start": "2020-04-01T12:00", "outcome": "arrived", "days": 71.7},
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

The seeds are the voyage replays' seeds, so `k-m2-p25-em-b2` replays the same
voyages as `sea3d/public/voyages/voyage_<date>.json`, thinned.
