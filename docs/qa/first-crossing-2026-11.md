# A first crossing, guided (24 Nov 2026)

John, 24 Nov 2026: "This game isn't streamlined at all. New players will have no idea what to do."

## What a first visit was like (measured on main at f1d10dc)

Played in a headless browser with nothing saved, from the title to the results (pictures and the
words on screen at each step were recorded; the script that replays it is below).

| Step | What a new player met |
| --- | --- |
| Title | Four equal choices (Set sail, Boatyard, Practice, More) and nothing that says where to start. |
| Set sail | A second screen also called Set sail, asking for a boat, a place and a "launch day" (Calm 23 Apr 2020, Rough, Pick a day) before anything has been seen. Then Set sail again. |
| First 8 s at sea | "Beat the autopilot to Portugal." Good, but it never says what you will be doing. |
| From 8 s | The orders drawer opens by itself: a compass with four coloured lines, three order buttons, a power slider, a forecast paragraph, three jump-ahead buttons and a share link, next to eight instruments, a chart, a history tab and a key line: more than 30 separate pieces of text on screen. "The ghost" is used in five places and explained in none. |
| About 27 s | The first "Your call" card. Nothing says that this is the game: time has stopped and it wants a choice. |
| The ending | Clear: one headline, the two times, one orange Play again. Left as it is. |
| Practice | Clear: "1 of 3 · Steer: hold Left or Right". Left as it is. |

## What changed

A browser where the game has never been played (no saved voyage, finished crossing, chosen boat or
earlier tip: `isNewcomer` in `sea3d/src/helm/guide.ts`) now gets this:

1. **Title.** Set sail carries one line, "Start here. Your first crossing takes about five minutes.",
   and goes to `helm.html?sail`: straight to casting off on the defaults (our kayak, the Atlantic,
   the calm day). No Set sail card. The line and link are set before the first paint, so the menu
   does not move when the scripts load.
2. **The goal card** says what the game is: "Get your boat across the Atlantic. It is 5,256 km to
   the finish line off Portugal, and she sails herself, day and night. A second boat, the ghost,
   makes the same crossing on autopilot. Your job is to get there before it." It stays 15 s, or
   until a click or a key.
3. **The orders drawer stays shut** until the player opens it. In its place, one small tip at a
   time at the top left, each shown once ever:
   - "Nothing to do yet." Time runs by itself; the game stops and asks when there is a decision.
   - "Your first decision." Shown beside the first Your call card: time has stopped, pick one, the
     ghost always takes the autopilot's choice.
   - "You can steer her yourself, any time." The arrow keys and Space (or Orders, on a touch
     screen), shown once the first decision is made, with the key line. Steering ends it.
4. **Tooltips** on the heading, speed, equipment and "vs the ghost" instruments say what each means.

A returning player sees none of this: the Set sail card, the 8 s goal card, the drawer with its
coach line and the key hint, as before. `?guide=1` forces the first-time tips and `?guide=0` turns
them off, for testing.

Nothing in the simulator changed, and nothing loads earlier or in addition: the tips are a few
hundred bytes of text in the helm page's own script.

## How it is checked

- `sea3d/tests/guide.test.ts`: the newcomer rule, the words, and that the title's early copy in
  `index.html` has the same rule and words.
- `sea3d/tools/qa/first-crossing.mjs [picture folder]`: plays the first visit on a desktop and a
  phone window and a returning player's start, and a reload at sea. 36 checks; all pass on this branch (cloud sandbox, software graphics).

## Independent review (24 Nov), and what was fixed

- A reload of a first crossing (its address keeps `?sail`) would have set sail again over the voyage at sea. Now `?sail` only starts by itself when no voyage is saved; otherwise the card comes up with Continue.
- The tips stopped for good after a reload or Continue. Now the ones not yet shown still come (`isLearning`).
- The steering tip named the up and down keys, which do nothing while the autopilot has her. It now names left and right only, and says they take her off the autopilot.
- "Bow" in a tooltip is now "the front of the boat".
- A returning player's goal card could be cut short by a decision; that is back as it was. The short wait for the harbour to be drawn is for a first visit only.
- If no decision comes, the steering tip still appears about 40 s after "Nothing to do yet" goes.

Known and left: at window widths under about 1,150 px a note at the top centre can overlap the tip for a few seconds.

The older smoke test (`tests/smoke.mjs`) was run in a cloud sandbox against this branch and stopped at its Boatyard launch step (30 s timeout on software graphics with the full weather file present), which this change does not touch.

## Not done here

- The Set sail card itself, the dock launch and the saved-voyage prompt belong to the thread
  "Make the game feel finished".
- The decision cards' own words ("Stronger wind 30° further south. Chase it?" on a motor boat) come
  from the simulator's calls and were left alone.
- The Boatyard is a dense screen for a first visit; the "Start here" line steers a newcomer past it.
