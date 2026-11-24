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
- On a boat that carries a person (3.5 m and longer) the eye is at the helm, aft. On a small
  unmanned boat (our kayak, the Randolph drone) it is a camera on her stern mast, looking forward
  over her deck. The note on screen says which.
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

Unit tests: 671 pass (668 before, 3 new).

**Not checked yet:** how the eye sits on the Blender models on a real graphics card (the kayak's
aerial is 25 cm behind the eye and should be out of the picture; a yacht's boom and sail fill the
left of the frame on one tack, as they would for a person at the helm). To look at on the live
site.
