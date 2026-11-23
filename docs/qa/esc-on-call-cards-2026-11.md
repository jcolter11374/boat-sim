# Esc on the "Your call" cards (issue #654), 21 Nov 2026

## What was wrong

The live play-through of 21 Nov found that pressing Esc on the big-waves card left the boat at 10%
power for the rest of the crossing (1,456 km behind the ghost at day 53; the Orders panel read
"about 583 days to go at that pace"). The card's foot said "Esc for the autopilot".

Three separate faults:

1. **Esc picked by the words on the button.** It looked for a button with "autopilot" in its text
   and, finding none, pressed the last button. On the storm cards (big waves, gale) no button says
   "autopilot" ("Hold course (same as the ghost)"), so Esc pressed the last one: "Slow down to 10%
   power", or "Turn south-east" on a boat with no motors.
2. **"Ride it out" never ended.** Slowing down set 10% power and left it there. Only a tooltip said
   to turn the motors back up.
3. **The Results card's "Your calls" list said "ahead of" for a gain.** Each line gives the change
   in the lead since that call, but worded it as a position: "Day 8.2 · Kept 10% power · 122 km
   ahead of the ghost" for a boat that was 122 km behind at the call and level at the finish.

## Every card, checked

What Esc pressed before, and what it presses now (`sea3d/src/helm/escChoice.ts`):

| Card | Options | Esc before | Esc now |
|---|---|---|---|
| Big waves or gale, on the autopilot | hold course, (turn away), slow down | last: slow down to 10% (**wrong**) | 1, hold course: she stays on the autopilot |
| Big waves or gale, steering yourself | hold course, (turn away), slow down | last: slow down to 10% (**wrong**) | 1, hold course: nothing changes |
| Navigator's check (route), on the autopilot, when the best line is about the autopilot's | "Take 095° (about what the autopilot does)", stay on the autopilot | 1: took her off the autopilot onto a fixed heading (**wrong**) | 2, stay on the autopilot |
| Navigator's check (route), steering yourself, same case | "Take 095° (about what the autopilot does)", keep yours | 1: a new heading (**wrong**) | 2, keep yours |
| Navigator's check (route), other cases | take it, keep yours, the autopilot | the autopilot | the same |
| Navigator's check (more power) | push, stay or keep your power | last: stay or keep (right, by luck of the order) | the same, by rule |
| Night battery | ease off, keep the power up, the autopilot | the autopilot | the same |
| Gulf Stream | ride it, cut across, the autopilot | the autopilot | the same |
| First chase | bend, the autopilot | the autopilot | the same |
| A challenge's big call | the challenge's own options | "autopilot" in the text, else the last | the autopilot option if there is one, else the first |

The rule now uses what each option does, not its words: the option that puts her on the autopilot;
if the card has none, the option that changes nothing; if neither, the first. The card's foot names
the option by number: "Keys 1-2, or Esc for the autopilot (1)." or "Esc to carry on as you are (2)."

## "Ride it out" now ends

Once the blow has passed (the same test the "The big waves have passed" note uses), the order and
power from before the call come back, and the note says so: "She's back on the autopilot, as
before." or "Back to 40% power, as before." If the player has given an order of their own in the
meantime (a new heading, another power, another card's choice), that stands and nothing is changed.
This is the same behaviour as the night card's "ease off till sunrise"
(`sea3d/src/helm/stormCall.ts`, `afterBlow`). "Still the same order" is told by counting orders,
not by comparing power, because the night card's "ease off" is 10% too.

If a worse blow brings a second storm card while she is still slowed: holding course keeps her
slowed and carries the "give it back" over to the new blow; turning away sails the new heading at
the power from before, not at 10%. With no link to the boat, the hand-back waits for the link.

Nothing in the simulator changed: both are ordinary orders, sailed in the real weather.

## "Your calls" wording

"gained 122 km on the ghost", "lost 40 km to the ghost", "no gain or loss on the ghost"
(`sea3d/src/helm/story.ts`, `callLines`).

## How it was measured

`sea3d/tools/qa/esc-on-cards.mjs` plays the default crossing (23 April 2020, our kayak, "You"
steering) in a headless browser at a day a second for 12 days, pressing Esc on every card, and
prints each card, its foot, and the order before and after. Software graphics in a cloud sandbox;
the cards that come up vary a little from run to run with how far the simulator is ahead of the
picture, as they do for a player.

| | Before (main, 405fe39) | After (this change) |
|---|---|---|
| Esc on the big-waves card (day 4.3 to 4.7) | "Autopilot, 25% power" became "The route, 10% power" | stays "Autopilot, 25% power" |
| Next card | day 8.7: "At 50% power she'd go faster than at your 10%"; Esc kept 10% | none of that kind |
| Order at day 12 | The route, 10% power | Autopilot, 25% power |
| Script result | FAIL (exit 1) | pass |

With `--slow` (key 2, "Slow down to 10% power and ride it out", on the day 4.7 card): she slowed,
made 23 km in the next day (holding course made 51 km over the same day), and at day 5.7 the note read "The big waves have passed. You slowed
down to ride it out: you were knocked flat once, and made 23 km towards the finish since. She's
back on the autopilot, as before." Order at day 12: Autopilot, 25% power.

One thing to know: the order strip shows the simulator's order, and the simulator runs ahead of the
picture. So after "ride it out" the strip can read "Autopilot" again a moment before the "passed"
note appears. All orders have always shown this way; it is not new here.

Unit tests: `sea3d/tests/escChoice.test.ts` (the Esc rule for each card above, the foot's words,
the ride-it-out rule, and a check that `helm.ts` still uses them on each card) and the calls
wording in `sea3d/tests/story.test.ts`. 636 unit tests pass.

## Independent review

A fresh reviewer read the first commit and found the Esc rule right on every card, and three narrow
ways the ride-it-out hand-back could go wrong. Fixed in the second commit: turning away on a second
storm card stayed at 10%; the storm's and the night card's hand-backs could each take the other's
10% for its own; the note could promise a hand-back while the link was down. The unit test now also
pins the wiring in `helm.ts`.

Left for a follow-up issue (#657, fixed below): a page reload in the middle of a blow forgot that
she was only slowed for the blow (the save kept the order, not the reason), so she stayed at 10%
until the player turned the power up. The night card's "ease off" had the same gap from before.

Not measured: a real graphics card (not needed, no drawing changed) and a whole crossing to the
finish with Esc on every card.

## A reload while slowed (issue #657), 23 Nov 2026

**What was wrong.** "Slow down and ride it out" (storm card) and "Ease off to 10%" (night card)
give the old order back by themselves, but what to go back to was kept only in the page's memory.
Close or reload the page while slowed, press "Continue your voyage", and she stayed at 10% power
for good.

**What changed.** The saved voyage (`sea3d/src/helm/voyageSave.ts`) has a new optional part,
`back`: which card slowed her, the order and power to go back to, and when. The page writes it
with every save and when the page is left (`slowedFor` in `helm.ts`, `voyageKeeper.ts`). A
continued voyage takes the slow-down up again (`backOnResume`, `takeUpSlowdown`), but only if the
helm comes back with the very order the save was written with; any other order is the player's own
and stands. Older saves have no `back` and load as before. Like the saved order, `back` is not the
boat's state: it is an order the page gives later, and the simulator sails it in the real weather.

Also: giving the same order again (the Orders panel re-sending what it already shows) no longer
counts as a new order for the "is the slow order still the last one" test.

**How it was measured.** `sea3d/tools/qa/reload-while-slowed.mjs` plays the default crossing to the
first storm card, presses "Slow down to 10% power and ride it out", leaves the page while slowed,
opens the saved voyage as "Continue your voyage" does, and sails 6 more days.

| | Before (main with #656) | After |
|---|---|---|
| Saved with the voyage at day 4.4 | order "the route, 10%"; nothing to go back to | the same order, plus: go back to the autopilot at 25% |
| Just after the reload | The route, 10% power | The route, 10% power |
| When the waves had passed | no change; at day 9.4 a card: "At 50% power she'd go faster than at your 10%" | day 6.4: "The big waves have passed. You slowed down to ride it out ... She's back on the autopilot, as before." |
| Order at day 10.4 | The route, 10% power | Autopilot, 25% power |
| Script result | FAIL (exit 1) | pass |

Unit tests in `sea3d/tests/voyageSave.test.ts`: the record keeps and reads `back`, refuses a broken
one, loads an older save, takes it up only when the helm matches, and the page's wiring. 668 pass.

Not measured in a browser: the night card's "ease off" across a reload (same code path, covered by
the unit tests only), and a real "Continue your voyage" click on the title page (the script opens
the same link the button opens).
