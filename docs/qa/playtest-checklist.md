# Playtest checklist (Nina, Playtest QA)

Nothing is reported to John as done until its rows here pass on the live site.

Three gates, in order:
1. **Pre-release playtest** (`.github/workflows/prerelease-playtest.yml`, blocking): every PR
   that touches `sea3d/` or `src/boatsim/` builds the whole site from its own commit (page and
   simulator together, `tools/build_site.sh`, the same script the deploy runs), serves it on the runner, and plays it
   in Chrome and Firefox with both scripts below. A PR doesn't merge red.
2. **After each deploy** (`live-site-check.yml`, `playtest.yml`): the same scripts on the real
   site (https://jcolter11374.github.io/boat-sim/).
3. **John's PC, now and then** (not blocking): the day's main build in real Chrome and Firefox
   on a real GPU, Windows fonts and drivers. Nothing is left running on it.

Two automated layers run on GitHub's computers in a fresh browser profile:
- **Live site check** (Ravi, `tools/live_site_check.mjs`): every page starts, and
  every helm boat, a port, a weather challenge, base mode and a share link sail a day.
- **Playtest** (Nina, `tools/playtest/play.mjs`): the paths a player takes next,
  in **Chrome and Firefox**.

Then a person-style pass by eye over the screenshots both runs save: anything
confusing, ugly or overlapping gets an issue even if the checks passed.

Legend: A = automated (Ravi), P = automated (playtest, Chrome + Firefox), E = by eye from screenshots.

## Every page
| Path | How |
|---|---|
| Loads with no console or page errors, no "being updated" / "can't start" notice | A, P |
| The 3D picture draws: not blank, sea and sky there, no black or magenta patches | A, E |
| Panels don't overlap each other or run off a 1400x900 screen | E |
| Small windows (960x540, phone 390x844 and 844x390): the main button can be reached and clicked (#288) | A (helm-small-window), todo for other pages |
| Words are plain English (nautical terms explained) | E |

## Take the helm (`helm.html`)
| Path | How |
|---|---|
| Our kayak from the usual drop: start, Sail 6 hours, Sail 1 day | A, P |
| Each stock boat the picker offers (cruiser, sail drone, rower, dinghy, beach cat) sails a day | A |
| Start from a port (Norfolk), no instant "land" stop | A |
| Every port in the list starts (24 ports) | todo |
| A weather challenge (Dorian) starts and sails | A |
| Every weather challenge in the list starts | todo |
| "Sail until something happens" stops by 72 h with a known reason | P |
| Real base station: Send an order, it arrives about a day later | P |
| Silence warning at 7 days unheard / 12 total (breakdowns on) | todo |
| Sailing off the weather map ends with its own message | todo |
| Share link reopens at the same day in a fresh browser | A |
| An old share link shows the friendly message, not a blank page | todo |
| Cinematic mode: panels hide, picture moves, clock doesn't move, a key leaves | P |
| Results card at the end (finish, loss, draw) reads correctly | todo |

## Voyage replays (`voyage.html`)
| Path | How |
|---|---|
| A 2020 replay loads and plays | A |
| Annapolis view loads | A |
| Cinematic mode in a replay | P |
| Live tracker view (`?live`) | todo |

## Boatyard (`boatyard.html`)
| Path | How |
|---|---|
| Default design launches and gives voyages | A, P |
| Change hull, drive, material, parts; launch again | todo |
| Start from Randolph Rev B / Rev C | todo |

## Race view and leaderboard
| Path | How |
|---|---|
| Race starts and races a day | A, P (start only) |
| Leaderboard shows real rows, not the sample | A, P |

## Filing a failure
One GitHub issue per problem, labelled `playtest`, with: the page and the steps,
what happened vs what should, the browser, the deploy commit, and the screenshot
from the run's artifacts. Then tell Maya.
