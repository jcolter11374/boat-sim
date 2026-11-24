# Set sail card: what was left of issue #314

21 Nov 2026. Issue #314 listed four things from Nina's first-time player pass (11 Nov) that
the start-card rework did not cover. The card has been rebuilt since (#432 onward), so each
was checked on a local build of main (f596eba) at 1400x900.

| Item | State on main | What this change does |
|---|---|---|
| 3. Launch day and weather challenge fight each other | Gone. The card has one "Launch day" choice (Calm, Rough, Pick a day); nothing overrides it quietly. | Nothing needed. |
| 4. "Start from" reads like a data dump | Fixed on screen: the list shows port names only, and one line under it gives the distance after you pick. The old long label ("Annapolis, launched 233 km out by water at ...") was still in the code, used by nothing but its own tests. | Removed the unused `portLabel` so it can't come back; its tests now check the name and the one-line hint. |
| 6. The orders panel says the same thing three ways | Still there: the bold line said "Straight at the finish" beside a button "Aim at the finish", with nothing to say which was a label and which a button, and the compass's four coloured lines were only explained in a hover tip. | See below. |
| 9. The forecast panel is half-covered by the start card | Gone. Nothing shows behind the card before the start. | Nothing needed. |

## The orders panel now

- A small heading "Steering now" over the bold line, and "Change it" over the buttons, so the
  label and the buttons can't be mistaken for each other.
- The bold line uses the button's own words: "Aiming at the finish" (was "Straight at the
  finish") and "Following the route" (was "Following the autopilot's route"). "Steering 075°"
  and the autopilot line are unchanged.
- "Aim at the finish" has a hover tip like the other two: "Aims at the finish, and keeps
  re-aiming as she goes".
- A key under the compass names its lines: your order, the bow, the finish, the wind.
  When watching a recorded voyage the existing three-line key is used and this one is hidden.

## After an independent review (21 Nov)

A fresh reviewer read the change. Fixed from its findings:

- **"Steering now" was untrue when steering from home by satellite.** There the bold line is
  an order that reaches the boat at the next check-in, and only once sent. The heading now
  reads "Your order (not sent yet)" or "Last order sent" in that mode.
- **The key named a white "bow" line that can't be seen on the autopilot or the route**,
  where the order is wherever the bow points and the orange line covers the white one. The
  key drops "the bow" in those two states.
- **The first hover tip overclaimed** ("Points her straight at the finish line"): a sailboat
  tacks towards it, and from home the order is followed as a one-point route.
- The key now dims with the rest of the panel when the satellite link is cut.

Left alone: "Steering now / Steering 075°" says "steering" twice, but the playtest reads
"Steering 075°", so that wording stays. The panel is about 50 px taller; on a phone the
drawer scrolls, and that was not measured at phone size here.

![The orders panel](screens/set-sail-leftovers-2026-11-21/orders.png)

The Set sail card as checked:

![The Set sail card](screens/set-sail-leftovers-2026-11-21/set-sail-card.png)

## How it was checked

- `npm run test:unit`: 630 pass.
- By eye on a local build. The cloud build has no simulator files, so the panel was opened
  without a voyage running; the wording after pressing each button comes from the code, not
  from a played game.
- Words and layout only: no new drawing, so the speed guard's counts don't move.

## Still open on #314

Its "done when" is Nina playing it live as a first-timer. That needs a person on the live
site after the deploy.
