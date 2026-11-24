# The on-board view, 24 Nov 2026

## Why

John, 24 Nov 2026: "maybe we could add being on the actual boat and controlling it from a first
person perspective?"

The game had no such view on a crossing. "Take the wheel" has a chase camera and a "deck view",
but the deck view is the ordinary camera that circles the boat, and the wheel is only offered on
boats that can be sailed by hand. On the default boat, our kayak, there was no way to see from
the boat at all.

## What changed

**V**, or the new person button beside the cinematic button, puts the camera on the boat in any
crossing, on every boat.

- The camera rides her. It heaves, rolls and pitches as she does, and looks along her bow, with
  her own deck in the bottom of the picture.
- On a boat that carries a person the eye is at the helm, aft (a rower's seated eye on the ocean
  rowing boat). On an unmanned boat (our kayak, the Randolph drone, the 7 m sail drone) it is a
  camera on her stern mast, looking forward over her deck. The note on screen says which.
- Drag to look around (up to 170 degrees each way, 50 up, 40 down). The mouse wheel widens or
  narrows the lens (40 to 80 degrees; it opens at 62).
- The steering is unchanged: the arrow keys steer and set the power as in any other view, and the
  orange line of your order lies on the water ahead.
- V again steps off, and the camera goes back beside her where it was.
- The wheel's own cameras, the cinematic, the finish scene and the result cards take the camera
  back for themselves. A knockdown is lived through from the deck, not cut away from.
- With "reduce motion" set, the horizon stays level: the view turns with her heading only.

Display only. Nothing reaches the simulator. No new shaders and nothing new to load.

## Where the code is

- `sea3d/src/helm/onboard.ts`: where the eye is on each boat, how a drag turns the head, the words.
- `sea3d/src/helm.ts`: `setOnboard`, `onboardCamera`, the V key, the drag and wheel listeners, and
  one branch in the frame loop.
- `sea3d/helm.html`: the button (`#boardbtn`), the key list and the key hint.
- `sea3d/tests/onboard.test.ts`: three unit tests, over every boat.
- `sea3d/tools/qa/onboard-view.mjs`: plays it in a headless browser on any boat, saves five
  pictures, and checks the camera is on the boat, that the arrow keys still steer, and that
  stepping off puts the camera back.

## Checked

Cloud sandbox, Chromium with software graphics, 1280x800, Low, a local build (boats drawn in code,
not the Blender models).

| Boat | Camera to her middle, beside her | On board | Arrow key steers on board | Back where it was |
|---|---|---|---|---|
| Our kayak | 7.8 m | 2.0 m | yes (Autopilot to Steer 070°) | yes |
| 9.5 m yacht (stock_cruiser31) | 44.1 m | 4.1 m | yes (to Steer 095°) | yes |

Pictures: `docs/qa/screens/onboard-kayak-cloud.png`, `docs/qa/screens/onboard-yacht-cloud.png`
(blurry: the cloud has no graphics card).

Unit tests: 673 pass (668 before, 5 new).

**Not checked yet:** how the eye sits on the Blender models on a real graphics card (the kayak's
aerial is 25 cm behind the eye and should be out of the picture; a yacht's boom and sail fill the
left of the frame on one tack, as they would for a person at the helm). To look at on the live
site.

## After an independent review (24 Nov)

A fresh reviewer read the change. Fixed from its findings:

- **On board, then the cinematic, then out of it: the drag was dead and the lens stuck wide.** The
  cinematic saves the camera it finds and puts it back when it ends, and it found the deck's, with
  the circling controls off. Now the view steps off board before the cinematic starts. The
  play-through script checks it: after the cinematic a drag circles her again.
- **Watching a voyage, on board, then "Look up at the sky"** gave a broken view. Looking up now
  steps off board first.
- **Finishing while on board** lost the turn towards the coast behind the results card. The finish
  scene now steps off board before it composes its shot.
- **Two fingers on a touch screen made the view judder.** One finger (or the mouse) turns the head;
  a second is ignored.
- **A trackpad slammed the lens to its limit.** The lens now changes with how far the wheel or pad
  moved (a mouse notch is about 3 degrees).
- **The 7 m sail drone is unmanned** but got a helm 2 m up. It now gets a mast camera like the
  other unmanned boats, and the ocean rowing boat a seated eye at 1.3 m.

Left alone: after a big change of course on board, stepping off puts the camera on the same compass
side as before, not the same side of the boat. There is no pinch to change the lens on a touch screen.
