# Working on boat-sim

1. **Stay in your package.** Changes to `types.py`, `config.py`, `geo.py` or
   `runner/` go through Maya (Lead), because everyone depends on them.
2. **Code to the interfaces.** Each package exposes a `Protocol` in its `base.py`.
   Replace the stub behind it; don't change its signature without a Lead-reviewed PR.
3. **One PR per issue**, linked with `Closes #N`. John reviews and merges.
4. **Units:** SI inside the code. Headings are compass degrees, vectors are
   (east, north). Convert knots and nautical miles only at the edges (`geo.py`).
5. **Mark guesses.** Any number that isn't from a datasheet, a dataset or a
   measurement gets `# GUESS` in the YAML or code, so calibration can find it.
6. **No data in git.** Downloaded weather and run outputs go under `data/` and
   `runs/`, which are ignored.
7. **Before pushing:** `ruff check . && ruff format --check . && pytest`. CI runs
   the same plus a smoke run.
8. **Accuracy over looks.** This is a test bench for a real boat, not a game.
9. **Cheap is a goal, not a constraint to negotiate.** Never ask John for money
   or a budget without an itemised plan of what it buys and why it's the cheapest
   way to get it. Never go looking for reasons to spend. Running costs (airtime,
   subscriptions, cloud) are simulator *outputs* to minimise, not allowances to fill.
