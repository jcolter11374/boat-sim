# Bluewater: the game in one page

A short version of the team's design document, for developers. The full
document is a private team doc; where the two differ, the full document wins.

**Bluewater** is one sailing game: pick your boat, set sail on a real sea in
real past weather, and see what happens, in real time if you like. It started
as an engineering simulator for one real boat (a 3.05 m solar-electric kayak
drone meant to cross the Atlantic on its own), and that simulator is still the
heart of it.

## The five pillars, in order

1. **It looks real and it looks cool.** Believable sea, sky, light and
   weather. Every default view should be a frame someone would want to post.
2. **It sails for real.** Wind, waves, currents and the boat's design decide
   what happens. Real time (1x) is always on offer.
3. **The boat is yours.** A deep Boatyard of parts, hull shapes and paint. The
   boat you build is the boat you sail everywhere.
4. **It is fun, not just easy.** Something to decide every minute or so, a
   clear goal on screen, stars and medals, big moments you see happen.
5. **It is one game.** One title, one boat, one way to set sail, one sailing
   screen, one results card, one look.

## The core loop

**Choose a boat, set sail, sail it, see how it went, change something, go
again.**

```
Title -> Your boat -> Set sail -> SAILING -> Results
             ^            ^                      |
             |            +--- Play again, Race it
             v
         Boatyard (parts, hulls, paint)
```

## Modes (all on the one sailing screen)

| Mode | What you do |
| --- | --- |
| Ocean crossing | Cross the Atlantic from the Chesapeake Bay to a target west of Lisbon, steering yourself or giving orders, with an autopilot "ghost" sailing the same weather beside you |
| Take the helm | Steer and trim the sails by hand on boats that can be hand-sailed |
| Practice | Short courses off Annapolis: a triangle and a run to Thomas Point Light, with medals |
| Weather challenges | Get through a real past storm by a deadline, for 1 to 3 stars |
| Race it | Two boats on the same launch |
| Watch a voyage | The autopilot sails, you watch; opens in real time |
| Cinematic | A button on any mode: composed camera shots of what is happening now |

## Rules the code must keep

- **Real time is always first on every speed bar.** No change may remove it.
- **The crossing follows the Microtransat Challenge rules**
  (`src/boatsim/runner/arrival.py`): start by crossing their western line;
  finish within 25 km of our target on their eastern line (39.5N 13.5W);
  reaching land anywhere, the Azores and Europe included, is not a finish;
  silent more than 10 days in a row or 15 in total is disqualified. Our kayak
  breaks the race's 2.4 m length limit on purpose.
- **One set of numbers.** The same launch gives the same answer on every
  screen. If two screens use different weather detail, the screen says so.
- **No money anywhere a player sees.** Prices stay in the data files, hidden.
- **Plain words.** Sailing terms are explained, and internal names never show.
- **No new separate pages.** New features live inside the one path.

## Plain sailing terms used in the code

See [glossary.md](glossary.md) for the full list. The ones you will meet first:

- **Heading:** the compass direction the bow points (0 = north, 90 = east).
- **Knockdown:** a wave knocks the boat flat on its side.
- **Leeway:** sideways slip caused by the wind.
- **Polar:** a table of a sailboat's speed for each wind speed and wind angle.
- **Reef:** make the sail smaller for strong wind.
- **Sheet:** the rope that pulls a sail in.
- **Point of sail / wind angle (TWA):** the angle between the bow and where
  the wind comes from.
