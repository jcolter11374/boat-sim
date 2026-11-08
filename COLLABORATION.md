# Working with other drone teams

We're happy to work alongside other teams sending small autonomous boats
across the Atlantic. Right now that's the Randolph team
([sheltonr2/drone-boat](https://github.com/sheltonr2/drone-boat)). This page
sets out how we keep in touch. It's short on purpose.

## Where we talk

- **The standing thread** is one pinned issue on this repo, labelled
  `collab`. Use it for general news and questions, and tag the other team's
  GitHub account so they get notified.
- **One issue per topic** when something needs its own discussion: a bug
  either side spotted, a data source, or a comparison run. Label it `collab`
  and link it from the standing thread.
- **Discussions** on this repo, once they're switched on, can replace the
  pinned issue. We'll say so in the thread if we move.
- **Your repo:** if your team prefers to talk on your repo, say so and we'll
  watch for it there. Right now our tooling can only post on this one, which is
  why our notes to you live here.

## What we share

- **Findings:** bugs we spot in each other's simulators, with the file and
  line, why we think it's wrong, and a suggested fix.
- **Data sources:** what works and what doesn't, with links. We use ERA5 wind
  and waves (ARCO-ERA5 public Zarr) and GLORYS12 currents (Copernicus Marine).
- **Validation:** checks against the real world. Our drift check against NOAA
  Global Drifter Program buoys is in `src/boatsim/mc/drifters.py`.
- **Comparison runs:** both simulators fed the same start point and date, so
  we can see where they disagree and why.
- **Lessons from tests:** tank, lake and coastal trial results, once either
  team has them.

We don't share anything secret or personal: no API keys or account details,
no personal names, emails or jobs beyond what someone already shows publicly
on GitHub, and no files we don't have the right to share.

## Dividing up shared work

Some work helps both teams equally, so it makes sense for each side to take
the parts it's already set up for. This is a starting offer. Change it as
you like.

| Work | Who | Why them | What the other team gets |
| --- | --- | --- | --- |
| **Drift check against real buoys.** Run our NOAA drifter check on buoys from the Nova Scotia / Newfoundland to Ireland corridor as well as off the US coast. | boat-sim | We've already built it and it runs in our CI | A score for how well the reanalysis currents move things along your route, which tells you whether your current data is good enough there too |
| **Current data side by side.** Compare GLORYS (ours) and Open-Meteo / SMOC (yours) at the same points and times along both routes. | boat-sim | We have both feeds working | A short table of how far the two sources disagree, and where |
| **Failure rates with sources.** One shared table of hazard rates per day (leaks, steering, fishing line and weed, capture near land, electronics, software hangs, fouling), each with a source or marked as a guess. | Randolph team, we'll review | Your `failures.py` already covers more hazards than ours | We fill a known gap in our model; you get a second pair of eyes on the rates |
| **Crossing history.** The record of past small-robot Atlantic crossings (Microtransat and others): who tried, what boat, how far they got, and what ended each attempt. | Randolph team, we'll add what we find | You've already gathered the start of it | A base rate both teams can check their odds against |
| **Comparison runs.** Both simulators fed the same start point, date and a "dead boat" drifting with no power, to see where the physics disagree. | Both, each runs its own | Each team knows its own code | A sanity check neither team can do alone |

Results go in a `collab` issue here, or in a file in whichever repo makes
sense, linked from the standing thread. Nobody has to buy anything for any of
this: it all uses free public data and free CI.

## How often

We post when there's something useful, not on a schedule, so no status spam.
We try to answer a question within a few days. Neither team owes the other a
reply or a fix: it's all optional and friendly.

## Licences and credit

Both repos are MIT licensed. If you reuse code from the other repo, keep its
copyright notice and say where the code came from in the commit or PR. Ideas
and bug reports are free to use with no credit needed, though credit is nice.

## Ground rules

- **Each team runs its own plan.** We swap knowledge, not decisions. Neither
  team changes its boat, route or timeline just to keep up with the other.
- **Different boats, different numbers.** Their boat is a 1.5 m wing-sail
  drone launching from Atlantic Canada. Ours is a solar-electric kayak launching
  from the Chesapeake. So when we compare odds or speeds, we say which boat a
  number is for.
- **No money changes hands** and neither side asks the other to buy anything.
- Be kind. Point out bugs the way you'd want yours pointed out.
