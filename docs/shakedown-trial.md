# Shakedown trial: two weeks on the Bay before the drop

**Why:** new hardware fails most often in its first days. The Randolph team's
failure table, which the simulator now uses, puts the risk on day 1 at **4 times**
the long-run rate, fading over about a week. Two weeks of running the boat close to
home burns off most of that early risk while you can still pick the boat up and fix
it. Once it's dropped at sea, you can't. Every team that has finished a crossing like
this had long sea time first. The simulator's default ("planning") odds already
assume this trial (`shakedown_days: 14` in `vessel/hazards.py`).

**Decided:** John, 9 Nov 2026.

**Time:** 14 days in a row, plus a short visit every few days. **People:** one,
with the sailboat for the visits.

## Set-up

- The boat **exactly as it will launch**: the sealed equipment tubs, the
  same software, panels and battery. No laptop cable, and no lid you'll open
  "just once".
- **Moored, not loose.** Put the kayak on a mooring or a long anchor line in sheltered
  water you can reach easily (a creek or cove off the Bay). It should swing freely in
  the wind and get full sun. Check the local mooring rules with the harbourmaster
  first. The kayak's own navigation light covers the night-time light an unattended
  boat needs, but confirm that too.
- **Normal voyage settings:** the same daily report, mailbox checks and Globalstar
  beacon pings as at sea. That way the trial also tests the comms bill (the
  airtime is the same small per-message cost as at sea, about two weeks' worth).
- Once a day, from base, send a **short thruster test** (both thrusters, a few
  seconds) and one **course change**, so the steering servo and the mailbox get
  used, not just the radios.

## Pass: all of these, for 14 days in a row

| Check | How you know | Pass |
| --- | --- | --- |
| No unexplained restarts | The boat's own log (read it at the end; the daily report has no room for it) | No restart you didn't ask for |
| No water inside | Open both tubs at the end (and the leak sensors' log, if fitted) | Dry: no droplets, no rust, desiccant unchanged |
| Iridium keeps reporting | The daily report arrives at base | No missed day |
| Beacon keeps pinging | Globalstar track | At least one ping every day |
| Power keeps up | Battery % in the daily report | Steady or rising from day to day |
| Thrusters and steering | The daily test, and the heading in the next report | Every test runs and the course change shows up |

**If anything fails:** bring the boat in, find the cause and fix it, then **start the
14 days again from zero**. A fault you can't explain counts as a fail: the point is to
find the faults while the boat can still come home.

## Where the results go

Post the outcome in the project (a photo of the open tubs helps). If the trial is
shortened or skipped, tell Theo: the honest setting is then `shakedown_days` equal to
the days actually run, and the odds go down a little (Ravi's run: 56% with the trial,
54% without, within the noise, but more if early faults are worse than assumed).
