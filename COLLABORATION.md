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
