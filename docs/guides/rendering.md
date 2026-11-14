# Rendering: how the game draws the world

The 3D views use [three.js](https://threejs.org/) with TypeScript, built by
Vite. Everything here is **display only**: it reads the simulator's log (a
replay, or the worker's answers) and makes it look right, and never feeds
back. The quality bar is the screenshot test: the default view must be a
frame someone would want to post.

## The sea

| File | What |
| --- | --- |
| `waves.ts` | The big waves the boats ride (Gerstner trains from a JONSWAP spectrum) |
| `seaFFT.ts`, `seaFFT.worker.ts` | Short wind waves, an FFT ocean computed off the main thread |
| `seaSurface.ts` | The one sea height and normal shared by JavaScript and every shader |
| `water.ts` | The sea mesh and shader: a grid fine near the boat and stretching to the horizon, ripples, sun glitter, light through wave tops, whitecaps that follow the wind |
| `seaDetail.ts` | Runs the FFT worker and hands its results to every sea-reading shader |
| `seaTest.ts` | Test hook: fixed sea states and suns for before/after pictures (`?seatest=f8&sun=dusk`) |
| `storm.ts`, `spindrift.ts` | How a blow looks by Beaufort force (the 0-12 wind scale): foam streaks, spray off crests |
| `mirror.ts` | Reflections of land, town and boats in calm water |
| `wake.ts`, `boatWash.ts`, `contact.ts`, `boats/propwash.ts` | Wake, bow wave, foam collar at the waterline and spray |
| `boats/inWater.ts`, `boats/wet.ts` | The hull fades below the surface and shows a wet band above it |

## Sky, light and weather

| File | What |
| --- | --- |
| `sky.ts` | Where the sun, moon and stars really are for a time and place (almanac formulas), so you can steer by them |
| `atmosphere.ts` | Sky colour, sun, moonlight, stars, haze, storm overcast, glow |
| `clouds.ts` | Cloud cover read from the logged sunlight; fog banks by the conditions that make sea fog |
| `rain.ts`, `rainRings.ts`, `rainbands.ts` | Rain streaks, rings on the water, squall lines |

## Land, places and the world

| File | What |
| --- | --- |
| `land/place.ts` | Places with real land (Annapolis, the Azores, the Bay mouth, Lisbon) |
| `land/squares.ts` | The Chesapeake Bay as coast tiles, loaded as the boat sails |
| `land/town.ts`, `trees.ts`, `landmarks.ts`, `bayBridge.ts`, `coastLights.ts` | Buildings, trees, landmarks, the Bay Bridge, lights at night |
| `land/seamarks.ts`, `boats/buoys.ts` | Real channel buoys and beacons |
| `traffic.ts` | Other ships, placed from the real ship-traffic map |
| `pois.ts` | Points of interest cards (wrecks, history) as you pass |

Land data is baked by the "Land data" workflow into a release and copied into
`public/land/` by the site build.

## Cameras

| File | What |
| --- | --- |
| `framing.ts` | Composes a shot: the boat on a third, room ahead of the bow, a level horizon |
| `helm/chaseCam.ts` | The sailing camera, like a chase boat's view, easing after the boat |
| `cinema.ts` | Cinematic mode: planned sequences (Passage, Storm, Golden hour, Night, Knockdown) of what is happening now; never moves the clock |
| `focus.ts` | A short ease-in to a moment (a breakdown, a knockdown) and back |
| `titleHero.ts`, `backdrop.ts` | The title's golden-hour shot; the sea behind word pages such as the leaderboard |

## Quality levels

Low, Medium, High, plus an opt-in Ultra. `helm/autoQuality.ts` picks a starting level by
timing frames and steps down once if the computer can't keep up; a level the
player picks always wins. `ultra.ts` adds focus, colour grade, film look and
sun shadows on top of High. `?quality=low|high|ultra` pins it for tests.
The "Frame-time budget" workflow (`tests/fps_budget.mjs`) guards against lag.

## Models

`gltf.ts` is the one way a page loads a `.glb` model. The build compresses
model geometry with Draco (`scripts/draco_models.mjs`). Models come from
Blender; see [boats.md](boats.md).

## Sound

`sound.ts` makes the sea, wind, rigging and hull sounds in code from filtered
noise (no sound files), scaled to the weather. Nothing plays until the player
clicks; N toggles. The title screen's music and sounds are in `titleMusic.ts`,
`titleTrack.ts` and `titleSound.ts`, with the recorded track in `public/music/`.

## Words and UI

`topbar.ts` is the one top bar. Player-facing words follow
[../glossary.md](../glossary.md). Anything from a data file goes onto the
page with `textContent`, never `innerHTML`.

## Useful URL switches

`?quality=`, `?models=simple`, `?bar=0` (hide the top bar), `?title=0`
(skip the title menu), `?data=` and `?voyage=` (pick replay data on the
voyage page), `?place=` (land to show on the voyage page).
