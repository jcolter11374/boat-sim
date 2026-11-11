# Glossary: one name for each thing (#319)

Every page (helm, Boatyard, voyage, race, leaderboard, index) uses the **Name**
column, written as shown. The first time a page uses a name, it adds the plain
explanation after it. Names in the **Not** column are the ones we've been mixing
up; replace them when you touch that text. Code identifiers (`kayak`,
`stock_cruiser31`, `ghost`) don't change, only the words a player reads.

## The boats

| Name | Plain explanation (first use on a page) | Not |
|---|---|---|
| **our kayak** | the 3 m solar-electric kayak with two small motors and no sail, as we plan to build it | the v4 kayak, the plan kayak, the kayak as it stands, the drone (it is one, but "drone" is taken below) |
| **your build** | the boat as you set it up in the Boatyard; when unchanged it *is* our kayak | your design, the design, my boat (only "My boat" as the button that reopens it) |
| **the planned build** | our kayak's parts list as planned, for comparing a changed build against | baseline, default build, the design as it stands |
| **Rev B**, **Rev C** | Randolph's team's boats, as we model them: always "our model of Randolph's Rev C" on first use | Randolph Rev C, the Randolph boat, the Randolph team's Rev C |
| **the 31 ft cruiser** | a 9.5 m sailing yacht with a keel and a small diesel engine | the cruiser (fine after first use), a yacht, the sailboat |
| **the wind-powered ocean drone** | a 7 m uncrewed sailing drone, on published sail-drone specs | the ocean drone, the sail drone, the drone (fine after first use) |
| **the ocean rowing boat** | an 8.6 m boat rowed by a crew of four, with a sea anchor (a parachute in the water that holds the bow into storms) | the rower, the rowing boat |
| **the 14 ft dinghy**, **the 16 ft beach cat** | small day sailboats, in the fleet for fun | the dinghy and beach catamaran on first use |
| **stock boats** | the generic boats above that aren't ours or Randolph's | stock vessels, the fleet |

## The voyage

| Name | Plain explanation | Not |
|---|---|---|
| **the drop point** | where the support boat leaves our kayak, 100 km out from the Chesapeake Bay mouth | the drop, our drop, the launch point |
| **launch day** | the date a voyage starts (the helm's 2020 launches, the Boatyard's start dates) | start date, launch date |
| **the finish** | a 25 km circle on the race's finish line, about 330 km west of Lisbon | the target, the finish line (that's the whole line), Lisbon |
| **the race rules** | the Microtransat Challenge rules we follow: finish in the circle; any landfall ends the voyage; silent over 10 days in a row or 15 in total is disqualified | the Microtransat (fine after first use) |
| **silent** / **the silence rule** | days with no position report home | dark, off the air, lost contact |
| **weather challenge** | a voyage through one real storm's weather (Dorian, Sandy…) | challenge mode, storm mode |

## Steering and reporting

| Name | Plain explanation | Not |
|---|---|---|
| **the autopilot** | the boat's own steering, which follows the route base sends | the AI, the bot |
| **the ghost** | the autopilot sailing the same boat through the same weather and luck beside you; it never shows what's ahead of your clock | the autopilot ghost, the rival |
| **base** / **the base station** | us at home, sending routes by satellite; "Real base station" is the helm mode where your orders go this way | home, mission control, base mode (except as the mode's label) |
| **check-in** | the boat's daily satellite report home, when orders reach it | report (fine in "last report"), ping |
| **the backup beacon** | the separate tracker that sends positions every 6 hours if the main satellite link dies | the Globalstar, the pinger, the spare tracker |
| **breakdowns** | parts failing at random, the same luck for both boats in a game | failures, damage (except for a named broken part) |

## Results

| Name | Plain explanation | Not |
|---|---|---|
| **odds** | the share of launches that finish, from many simulated voyages, e.g. "the simulator gives it 78% over 100 launches" | chance of success, win rate, success rate |
| **likely range** | the 95% range around the odds | confidence interval, CI, error bars |
| **the leaderboard** | the published ranking of builds on the same fixed launches, shown only when its fairness check passes | the board (fine after first use), rankings |
| **group** | builds the leaderboard can't tell apart on its launches: "the top of 3 groups" | tier (code only), rank, league |
| **one voyage** | a single game or replay: one roll of the dice, not the odds | a run, a sim |

## How pages use it

- A first use on each page gets the plain explanation, once. Later uses on the same page use the name alone.
- Nautical words follow CLAUDE.md: explain them plainly on first use (keel, reef, sea anchor, tack).
- When a new thing needs a name, add a row here in the same PR that introduces it.
