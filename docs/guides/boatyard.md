# The Boatyard

The Boatyard (`boatyard.html`, `sea3d/src/boatyard.ts`, `sea3d/src/yard/`)
is where a player builds their boat: pick a starting boat, swap parts, hull
shapes and paint, watch the chance-to-finish gauge move, then press "Test it"
to sail it. Two deeper documents cover the details:

- [../boatyard.md](../boatyard.md): the precomputed odds grid's file format.
- [../sandbox.md](../sandbox.md): the simulator running in the browser.

## The data

| File | What | Kept by |
| --- | --- | --- |
| `sea3d/public/parts-catalog.json` | Every slot (thrusters, solar, battery, electronics box, beacon, paint...) and its options, with weights and power figures. Prices stay in the file but are never shown | the parts plan |
| `sea3d/public/sim-slots.json` | Slots and as-built options for the Randolph bases and the stock boats | simulator side |
| `src/boatsim/sandbox/catalog.py` | Maps each option onto a change to the design file: `wired` (changes the simulation), `no effect yet` (shown greyed), or `fixed` | simulator side |
| `sea3d/src/yard/shapes.ts` | Hull shapes, with the same sizes as `catalog.py` `SHAPES` and `blender/build_shapes.py` | shared |

A design is plain data: one option per slot plus the cruise power in watts
(`yard/design.ts`). It travels as a URL hash, so it can be shared as a link,
and is remembered as "my boat" (`src/myboat.ts`).

## Where the odds come from

Finish odds need 100 voyages over ten years, too much for a browser, so:

1. **The grid.** The "Boatyard grid" workflow (`boatsim.mc.boatyard`) runs a
   set of builds ahead of time and writes `sea3d/public/boatyard/` (an index
   plus replays per build). A build on the grid shows its measured odds.
2. **The estimate.** For a build not on the grid, `yard/estimate.ts` starts
   from the planned build's odds and adds each changed part's measured effect
   in log-odds, with overlap inside related groups. It is labelled as an
   estimate, never as a nearby build's odds.
3. **Test runs.** "Test it" sails the build for real in the browser
   (`yard/launch.ts` `SandboxLauncher`, workers in `yard/sim.worker.ts`), on
   2020 weather, labelled as such.

## The 3D boat

`yard/dress.ts` (and `dressRandolph.ts`) makes every swap show on the 3D
boat: parts appear, change size or colour, the inside shows in "see inside",
and the keel and motors show when the boat is lifted out. This is cosmetic;
the numbers come only from the catalog.

## Rules

- **No money.** `yard/nomoney.ts` decides what a player sees: what a part
  does, never what it costs.
- A part that changes nothing in the simulator is shown as "no effect yet",
  not hidden and not faked.
- Default choices are exactly `configs/v4_kayak.yaml` (a test checks that the
  default build patches nothing).

## Adding a part

1. Add the option to `parts-catalog.json` with its real weight and power.
2. Map it in `src/boatsim/sandbox/catalog.py` (what it changes in the design),
   with a test in `tests/test_boatyard.py` or a neighbour.
3. Show it on the boat in `yard/dress.ts` if it is visible.
4. If its effect matters to the odds, add a build to the grid
   (`catalog.GRID`) and rerun the "Boatyard grid" workflow.
