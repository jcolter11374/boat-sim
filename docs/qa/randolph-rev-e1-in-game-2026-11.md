# Rev E1 as a boat you can pick (Nov 2026)

The Randolph team's current design is Rev E1 (issue #50, 21 Nov 2026). They wrote
`configs/randolph_rev_e1.yaml` for us. This note records how it was made a boat in the
game, what is a guess, and how it was checked.

## What a player sees

- **Change boat (Set sail, title):** "Randolph Rev E1 (our model)" is the first of the
  Randolph team's boats: "their current 1.5 m wing-sail robot boat design".
- **Boatyard:** a "Rev E1" button beside Rev C5 and Rev B, with the same part slots as
  Rev C5. The "i" beside the intro says our model leaves out their bilge pump, tail detent,
  backup controller and weed-shedding manoeuvre, so their own odds are higher.
- **Races:** Rev E1 can be either boat (`?race=kayak,reve1`) and is in the rival picker.
- Everywhere it is named "(our model)", as their other boats are.

## How it is wired

Rev E1 is a third Randolph base, key `reve1`, beside `revc` and `revb`.

- Simulator (`src/boatsim/sandbox/catalog.py`): `BASES["reve1"]`, the same slots and
  as-built picks as Rev C5. As built it is their yaml untouched (a test checks this).
  A single rudder keeps Rev E1's sealed servos' halved failure rate (0.002 a day, against
  Rev C5's 0.004).
- `sea3d/public/sim-slots.json` gets a `reve1` entry made from `catalog.base_table()`,
  with the option names copied from Rev C5's.
- Game (`sea3d/src`): `yard/bases.ts` (`RANDOLPH_KEYS`, `isRandolphBase`), `myboat.ts`,
  the pickers, the race lists, the Boatyard page and `motion.ts` (`RANDOLPH_REVE1`).
- The simulator packed for the browser now carries the yaml (`sandbox/__main__.py`).

## What is a guess

- **How she rides** (`RANDOLPH_REVE1` in `motion.ts`): the weight (28.5 kg), waterline
  (106 mm) and GM (0.180 m) are theirs. They have published no Rev E1 righting-arm curve
  or inertias, so those are Rev C5's, scaled by the GMs and the weights.
- **How she looks:** the 3D model is the Rev C5 one. Rev E1's visible changes (the weed
  fairing between fin and bulb, a thicker tail boom) are not drawn. The team has offered a
  3D file of Rev E1; we asked for a `.glb` on 23 Nov.
- **The Boatyard's weight and cost of "the rest of their boat":** 28.5 kg is theirs; the
  cost is Rev C5's plus the $360 they quote for Rev E (no money shows in the game).

## Not done

- **No saved odds for Rev E1.** `sea3d/public/boatyard/` has no `reve1` builds, so the
  Boatyard shows "not tested yet" until a player presses "Test it", which sails her in the
  browser. The Boatyard grid workflow adds six `reve1` builds the next time it runs.
- **No recorded voyage replays or leaderboard entry.**
- **The old voyage replay page** (`voyage.ts`, no longer in any menu) has no Rev E1 lane:
  when Rev E1 replays are recorded, give `revOf` and the two `mine.base` mappings a Rev E1
  key first, or she will be shown there as Rev B. The helm's replays (`watchBase`) already
  know her.
- **Default rivals and "Race it" links** still point at Rev C5, on purpose: Rev C5 has saved
  odds and replays and Rev E1 has none yet.
- **Her start in the Boatyard runs** is the yaml's: 45 km off Hatteras. Our land map has no
  Diamond Shoals (they told us theirs didn't either), so groundings there are not counted.

## How it was checked

- `pytest tests`: 862 passed, 13 skipped (the as-built design equals the yaml; a race from
  her own drop; the grid and page-check tests).
- `npm run test:unit` in `sea3d`: 633 passed, with `tests/reve1.test.ts` new.
- In Chromium on the built site (software graphics, a thread sandbox): the Boatyard at
  `#base=reve1` shows the boat, 28.5 kg and her slots with no page errors; with Rev E1
  saved as "my boat", Set sail shows her name and draws her.
- Not checked here: sailing her in the browser, because a thread sandbox can't reach the
  Pyodide download. The playtest in CI does that for the kayak; the simulator side is
  covered by the Python tests above.
