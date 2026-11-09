# Sensitivity study, first results: what changes the odds for April to June launches? (#21)

Ravi (QA), 9 Nov 2026.

**Short version.** Within the April to June window, only two things moved the odds:

1. **Cruise power.**
   - Slowing to 10 W loses voyages: 88% against 97%, with 12 lost and 3 gained (a 4% chance of that split by luck).
   - Speeding up to 25 W arrives just as often and about 11 days sooner (median 68 days against 79).
   - The faster boat also costs $19 less airtime per voyage and holds up better once unknown failures are put back.
2. **Thrusters.** One thruster instead of two costs a lot: 75% against 93%, with 22 lost and 4 gained (under a 1% chance of that by luck).

Everything else was a wash in this window: course corrections from base, battery size, panel size and the safe-mode battery rules.

## Runs

Both runs used the same setup:
- launches every 10 days from April 1 to June 30, 2012 to 2021, so 100 launches per variant;
- real ERA5 weather and GLORYS12 currents;
- base station working from a forecast with realistic error (#12);
- the "unknown failure" guess switched off in the run and put back in the "with unknown" columns.

Every variant sails the same launches with the same random dice, so a difference comes from the change, not the weather.

- **Main run.** [Run 42543791381](https://github.com/jcolter11374/boat-sim/actions/runs/42543791381), code c25d989, 11 variants. No ship traffic yet, and no thruster wear-out yet.
- **Thruster run.** [Run 42545699251](https://github.com/jcolter11374/boat-sim/actions/runs/42545699251), code 43ff092, baseline plus one thruster.
  - This run includes thruster wear-out (#65), which is why its baseline is 93% rather than 97%.
  - Compare one thruster only with this run's baseline.
  - No ship traffic yet.

How to read the columns:
- **Gained** and **lost** count voyages that arrive with the change but not without it, and the other way round.
- **Chance** is how likely that split is if the change did nothing (a sign test). Above about 5%, treat it as noise.

## Main run (c25d989)

| Change | Arrived | Odds (95% range) | Gained | Lost | Chance | Median days | With unknown 10% | With unknown 50% | Airtime $ | Lowest charge |
|---|---|---|---|---|---|---|---|---|---|---|
| The design as it stands | 97/100 | 97% (92% to 99%) |  |  |  | 79 | 86% | 43% | 95 | 65% |
| Base never changes the route (still sends a daily 'all well') | 96/100 | 96% (90% to 98%) | 2 | 3 | 100% | 79 | 85% | 43% | 95 | 66% |
| Base sends nothing; boat follows its stored route, then heads east | 96/100 | 96% (90% to 98%) | 3 | 4 | 100% | 78 | 85% | 43% | 94 | 66% |
| Half the battery (one 50 Ah pack, 640 Wh) | 95/100 | 95% (89% to 98%) | 2 | 4 | 69% | 80 | 84% | 42% | 95 | 38% |
| Half again the battery (1920 Wh) | 97/100 | 97% (92% to 99%) | 0 | 0 | 100% | 79 | 86% | 43% | 95 | 77% |
| Smaller panels (150 W) | 99/100 | 99% (95% to 100%) | 2 | 0 | 50% | 80 | 87% | 44% | 95 | 43% |
| Bigger panels (350 W) | 97/100 | 97% (92% to 99%) | 0 | 0 | 100% | 79 | 86% | 43% | 95 | 75% |
| Slower cruise (10 W motor power) | 88/100 | 88% (80% to 93%) | 3 | 12 | 4% | 98 | 77% | 37% | 106 | 81% |
| Faster cruise (25 W motor power) | 97/100 | 97% (92% to 99%) | 3 | 3 | 100% | 68 | 86% | 46% | 76 | 36% |
| Stop motors earlier: below 30% charge, restart at 40% | 97/100 | 97% (92% to 99%) | 0 | 0 | 100% | 79 | 86% | 43% | 95 | 65% |
| Never slow down on low battery; only stop at 15% | 97/100 | 97% (92% to 99%) | 0 | 0 | 100% | 79 | 86% | 43% | 95 | 65% |

How voyages ended:

| Change | Arrived | Both electronics boxes dead | Still at sea after 150 days |
|---|---|---|---|
| The design as it stands | 97 | 2 | 1 |
| Base never changes the route | 96 | 2 | 2 |
| Base sends nothing | 96 | 2 | 2 |
| Half the battery | 95 | 3 | 2 |
| Half again the battery | 97 | 2 | 1 |
| Smaller panels (150 W) | 99 | 1 | 0 |
| Bigger panels (350 W) | 97 | 2 | 1 |
| Slower cruise (10 W) | 88 | 4 | 8 |
| Faster cruise (25 W) | 97 | 3 | 0 |
| Stop motors earlier | 97 | 2 | 1 |
| Never slow down | 97 | 2 | 1 |

## Thruster run (43ff092)

| Change | Arrived | Odds (95% range) | Gained | Lost | Chance | Median days | With unknown 10% | With unknown 50% | Airtime $ | Lowest charge |
|---|---|---|---|---|---|---|---|---|---|---|
| The design as it stands | 93/100 | 93% (86% to 97%) |  |  |  | 78 | 82% | 42% | 94 | 66% |
| One thruster instead of two (same 15 W cruise, 50 W burst) | 75/100 | 75% (66% to 82%) | 4 | 22 | under 1% | 82 | 66% | 33% | 102 | 64% |

Endings: baseline 93 arrived, 4 still at sea, 3 with both electronics boxes dead. One thruster: 75 arrived, 20 still at sea, 5 with both boxes dead.

## Ravi's read

- **Course corrections from base are worth nothing measurable in this window.**
  - "Never change the route" lost 3 and gained 2. "Send nothing at all" lost 4 and gained 3. Same median days.
  - This is the test Maya asked for, and it backs up the hint from the forecast-error runs.
  - It doesn't mean two-way comms are useless. The report still tells us where the boat is, and base can still step in after damage. The simulator's base doesn't do that yet.
  - Airtime barely changed ($94 against $95), because the boat still paid for its daily mailbox check. #77 now collects the mailbox with the report, and the `mailbox_scheduled` variant (#79) will measure that saving.
- **Cruise power matters, and faster looks better.**
  - At 10 W the boat is too slow: 8 still at sea at day 150, and 12 voyages lost.
  - At 25 W it is 11 days faster, cheaper on airtime, and better once unknown failures are back in (46% against 43% at the 50% guess).
  - The catch is that its lowest charge falls to 36%. April to June has sun to spare, so this probably won't hold in a cloudy month.
  - Worth a follow-up: try 20 W and 30 W, and a month-dependent cruise setting.
- **Battery, panels and safe mode don't matter in April to June.**
  - The battery never drops below about 65%, so the safe-mode rules never kick in.
  - Half the battery or 150 W panels look fine on odds (95% and 99%, both within noise). But the lowest charge falls to about 40%, which leaves less room for a damaged panel or a cloudy spell.
  - That is a possible saving, but it needs the parts catalogue (#25) to price it and a check on damaged-panel voyages before anyone acts on it.
- **Keep two thrusters.**
  - One thruster loses 18 points.
  - The likely main reason: with two, the boat can still steer by running one harder than the other if the rudder fails. With one, a rudder failure leaves it drifting.
  - The rudder failure rate (0.002 a day, more in rough seas) gives about a 1 in 5 chance of a rudder failure over an 80-day crossing. That roughly matches the extra 18 voyages still at sea.
  - This is inferred from the hazard rates, not traced voyage by voyage.
- **Wear-out cost.** Thruster wear-out (#65) took the two-thruster baseline from 97 to 93 of 100.

## Still optimistic

- No ship traffic in these runs. It's in from 7856a64 (#68), and the next run will include it.
- ERA5 understates hurricane winds.
- One boat design and one route, with every hazard size a guess.

## Next

- **Re-run every variant on one commit** with ships, wear-out and the new mailbox handling, including `mailbox_scheduled` (#79). That will be the single baseline for #21.
- **Follow-ups:**
  - cruise power at 20 W and 30 W;
  - smaller battery or panels combined with panel damage;
  - the same variants in September, where power is tight and safe mode matters.
