# Tow test: measuring the kayak's real drag

**Why:** the simulator's speed numbers rest on two guesses: how hard the water
pushes back on the hull (its *drag*) and how much push the thrusters really make
at low power. One afternoon on calm water replaces both guesses with
measurements. This is the single most valuable test before launch.

**Time:** about 3 hours on the water. **People:** two (one drives, one reads the scale).

## What you need

- The kayak **fully built and at sailing weight** (about 123 kg, keel and bulb
  fitted). The keel reaches about 1 m below the surface, so stay in water at
  least 2 m deep.
- A **digital hanging scale** (luggage type) reading to 0.01 kg, rated to at
  least 10 kg. The pulls are small: about 0.5 kg at 1.7 kt and about 1.3 kg at 3 kt.
- 15 to 20 m of **floating line**, so the kayak tows well behind the boat's wake.
- A **phone with a GPS speed app** (any app that shows speed in knots).
- For tests B and C: an inline **DC watt meter** between the battery and each
  thruster's speed controller, and the laptop or radio link you use to set thrust.
- A phone to **video the scale**. The reading jumps around, so you'll average it later.

## Pick the day

- Wind under 5 kt (flags hang limp) and flat water.
- **Slack tide** if you're in tidal water. That's the pause of ~30 minutes when the
  tide turns and the current is close to zero. Every run is done in both directions
  anyway, so any leftover current cancels out.

## Test A: tow at known speeds (drag)

1. Tie the scale between the end of the tow line and the kayak's bow eye. Tow from
   the side of the towing boat (a short pole or a side cleat), not dead astern, so the
   kayak is out of the propeller wash.
2. With the kayak's thrusters **off**, tow at a steady **1.0 kt** by GPS for one
   minute. Film the scale for the whole minute.
3. Turn around and repeat in the opposite direction.
4. Do the same at **1.5, 2.0, 2.5 and 3.0 kt**.
5. Write down each run's GPS speed and the scale's average reading.

## Test B: tied to the dock (thruster pull)

1. Tie the kayak's stern to a dock cleat through the scale, with the line straight
   out behind it. Keep hands well clear of the thrusters.
2. Run **one thruster** at **5, 10, 15, 25 and 50 W** on the watt meter, holding
   each setting for 30 seconds. Write down the watts and the average pull.
3. Repeat with the other thruster.

## Test C: under its own power (the check)

Run both thrusters together at **15 W total**, then at **30 W total**, for 3 minutes
each way. Write down the GPS speed for each direction. This checks that tests A
and B add up.

## Record sheet

| Test | Setting | Direction 1 | Direction 2 | Average |
| --- | --- | --- | --- | --- |
| A | 1.0 kt | ___ kg at ___ kt | ___ kg at ___ kt | |
| A | 1.5 kt | | | |
| A | 2.0 kt | | | |
| A | 2.5 kt | | | |
| A | 3.0 kt | | | |
| B port | 5 / 10 / 15 / 25 / 50 W | ___ kg each | | |
| B starboard | 5 / 10 / 15 / 25 / 50 W | ___ kg each | | |
| C | 15 W total | ___ kt | ___ kt | |
| C | 30 W total | ___ kt | ___ kt | |

Also note the wind, the time, and anything odd, like weed on the hull or a wobbly reading.

## Where the numbers go

Post a photo of the sheet in the project and Theo (Physics) will do this. To do it
yourself in a cloud sandbox:

```python
from boatsim.vessel.calibrate import fit_form_factor, fit_thruster_efficiency

# Test A: average speed (kt) and average pull (kg) for each run
print(fit_form_factor([1.0, 1.5, 2.0, 2.5, 3.0], [0.18, 0.38, 0.65, 0.98, 1.37]))
# Test B: watts on one thruster, and the pull (kg)
print(fit_thruster_efficiency([5, 10, 15, 25, 50], [0.31, 0.49, 0.65, 0.91, 1.45]))
```

(The numbers above are made up, to show the format; the real ones go in their place.) Put the first result into
`configs/v4_kayak.yaml` as `hull: form_factor:` and the second as
`propulsion: thruster_efficiency:`, then remove their `# GUESS` notes. Test C is the
check: re-run the simulator at 15 W and 30 W in calm water, and the speeds should
match within about 0.1 kt. If they don't, tell Theo, because something else
in the model is off.

For comparison, today's model predicts:

| Test A speed (kt) | 1.0 | 1.5 | 2.0 | 2.5 | 3.0 |
| --- | --- | --- | --- | --- | --- |
| Pull (kg) | 0.18 | 0.36 | 0.61 | 0.91 | 1.27 |

| Test B watts, one thruster | 5 | 10 | 15 | 25 | 50 |
| --- | --- | --- | --- | --- | --- |
| Pull (kg) | 0.31 | 0.50 | 0.65 | 0.91 | 1.45 |

Test C: **1.7 kt at 15 W total** and **2.2 kt at 30 W total**.
