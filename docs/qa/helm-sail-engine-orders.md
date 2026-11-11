# QA: can a player cheat the physics with sail and engine orders? (#242)

Ravi (QA), 11 Nov 2026. Sam's #242 lets a player on a stock sailboat order the sails (`full`, `reef1`, `reef2`, `storm`, `down`) and the engine (on/off). I drove the 31 ft cruiser's vessel model (`vessel/keelboat.py`, on main) directly with each order in a calm, a gale and a storm. Each run is 1 hour (6 hours for the gale runs) of 10-minute steps. The probe script is below.

**Short answer:** #242's plumbing is sound: validation, share links and base mode delays all work. But the orders open up four places where the boat model gives something for nothing. Three of them are in `keelboat.py` (merged earlier), so the auto behaviour and the ghost touch them too, not only players. One is in #242 itself.

## Findings, worst first

### 1. Under engine the boat steers with no rudder, no autopilot and a flat battery (keelboat.py)

| Calm, engine on at 70 %, heading 90 | Made good | Heading held |
|---|---|---|
| Healthy | 5.3 kn | 90 |
| Rudder gone | 5.3 kn | 90 |
| Autopilot dead (`electronics_main`) | 5.3 kn | 90 |
| Battery flat (electronics off) | 5.3 kn | 90 |

The cause is `KayakVessel.step`, which sets `steering = steering or motoring`. That line is right for the kayak, whose motors steer by differential thrust. A keelboat has one propeller, so it steers only with the rudder and only when the autopilot is alive. Here the diesel runs off its own fuel and the boat holds any heading with neither of them. A player whose autopilot has died can switch the engine on and keep going straight. In a calm the boat does this by itself, so the ghost does it too.

**Fix (Theo):** in `KeelboatVessel._motoring`, return True only when the autopilot is on, `electronics_main` is undamaged and the rudder works. Otherwise the engine pushes along whatever heading the boat already has, or does nothing (simplest: engine off). Test: rudder gone plus engine on gives no course held.

### 2. Low-throttle creep: the engine runs almost forever (keelboat.py)

| Calm, engine on | Speed | Fuel per hour | 30 L lasts | Distance on 30 L |
|---|---|---|---|---|
| 100 % | 6.0 kn | 2.0 L | 15 h | 90 nm |
| 10 % | 2.8 kn | 0.2 L | 150 h | 420 nm |
| 1 % | 1.3 kn | 0.02 L | 1,500 h (62 days) | about 1,900 nm |

Speed goes with throttle^(1/3), but fuel burn is straight proportional to throttle. So the less throttle you use, the further the tank goes, without limit. At 1 % the tank motors two thirds of the way across the Atlantic. A real diesel has an idle floor: it burns roughly a quarter to half a litre an hour just turning over (GUESS for a 21 hp engine), and in gear at idle it pushes the boat at 2 to 3 kn.

**Fix (Theo):** add `engine_idle_frac` (GUESS 0.15 to 0.25) so any throttle above zero runs at least at idle, for both burn and speed. That caps range at roughly 150 to 250 nm, which is about what a 30 L tank on a 31 ft boat really gets. Test: no throttle setting goes further than N nm on a full tank.

### 3. Full sail in a gale costs nothing (keelboat.py)

| Reaching, 6 h | Sails left to the boat | Full ordered | Storm sails |
|---|---|---|---|
| 29 kn wind | 7.85 kn (reef 1) | **8.05 kn** | 6.76 kn |
| 39 kn wind | 8.05 kn (reef 2) | **8.45 kn** | 7.39 kn |
| 47 kn wind | 8.06 kn (reef 2) | **8.44 kn** | 7.38 kn |

Overriding the reefing gains 2.5 to 5 % in a gale, with no downside:

- A ballasted keelboat can't be knocked flat in our model (`max_m0_nm` is infinite).
- The sail and rig break only from the per-knockdown odds (`p_part.sail`), which don't depend on how much sail is up.

On a real boat, full sail at 35 to 45 kn is how sails blow out, rigs break and boats broach (round up out of control). The gain is small, but it is free, and a 6-launch race is decided by margins this size. Above 50 kn the model already forces the sails down, so storms proper are safe.

**Fix (Theo):** give each plan a wind limit. When the plan flown is above `reef_heel_deg` heel, or above its wind limit, add an hourly chance of `damage["sail"]` that grows with the overload. The auto-reefing boat never pays it, so paired races stay fair. Test: full sail at 40 kn for a day breaks something most of the time, and the auto plan almost never does.

### 4. #242 accepts sail plans the boat doesn't have, and refuses one it does

`SAIL_PLANS` is the cruiser's list. The 14 ft dinghy has only `full`, and the beach cat has `full` and `main_only`:

- Ordering `reef1` on the dinghy is accepted. `choose_plan` then quietly ignores it and flies the auto plan. The player thinks they reefed, but they didn't.
- Ordering `main_only` on the beach cat is refused as an unknown plan.

**Fix (Sam, in #242):** validate against `vessel.polar.plans + ["down"]` and report the boat's own list in `status()` (for Iris's buttons). Test: every stock boat accepts exactly its polar's plans plus `down`.

### 5. Motoring straight into a storm ignores the wind (keelboat.py, minor)

The engine speed has the wave penalty but no wind drag on the hull and rig. Headed straight into 49 kn with 6 m seas, the cruiser still makes 1.9 kn. At 58 kn it makes 1.0 kn, holding any heading where the sailing model has to run off. It isn't faster: the autopilot's tacking makes more ground upwind. But it lets a player hold position in a storm that should push them back. Fold the hull's windage (`air_front_area_m2`, `air_cd_front`) into the motor speed. It's low priority.

## What I checked and found fine

- **Fuel stops the engine.** Fuel can't go below zero, and an engine marked broken never runs.
- **Engine burns fuel whenever it's on,** even when the sails are faster, and that is the honest rule.
- **Real base station mode:** sail orders ride the route and wait for the boat's next check-in, so there's no instant reefing from home.
- **Boats without sails** (kayak, Rev B, Rev C) refuse sail and engine orders.
- **Old share links** load unchanged, and new ones replay the sail orders.

## Recommendation

- #242 can merge after fix 4. That one is a few lines in Sam's PR.
- Fixes 1 to 3 belong in one small keelboat PR (Theo), with the tests above. Until it lands, stock boats in the helm and race views are open to the engine cheats.
- None of this touches the kayak, Rev B or Rev C, or the leaderboard, which has no stock boats ranked alongside the kayak.

## Probe

```python
# python -I probe.py from the repo root (src on the path): one vessel, fixed env, 10-minute steps
from boatsim.vessel.keelboat import KeelboatVessel
from boatsim.types import Command, EnvState

v = KeelboatVessel(load_design("configs/stock_cruiser31.yaml"))
# calm creep:   Command(90, f, None, True) in EnvState(), f = 1.0 ... 0.01
# no steering:  same at 0.7 with damage {"rudder": True} / {"electronics_main": True} / battery 0
# gale reach:   EnvState(wind_v=-ws, hs=ws/4, tp=9, wave_dir=0), Command(90, 0, plan, False), 6 h
# storm motor:  EnvState(wind_u=-ws, hs=hs, tp=10, wave_dir=90), Command(90, 1.0, "down", True)
```
