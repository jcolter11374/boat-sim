# Working on boat-sim

1. **Stay in your package.** Changes to `types.py`, `config.py`, `geo.py` or
   `runner/` go through Maya (Lead), because everyone depends on them.
2. **Code to the interfaces.** Each package exposes a `Protocol` in its `base.py`.
   Replace the stub behind it; don't change its signature without a Lead-reviewed PR.
3. **One PR per issue**, linked with `Closes #N` where there is one. Each PR gets one
   code review (Maya or Lena) and green checks; then Maya merges it (John's standing
   OK). Elena's look review and Nina's live sweep happen after the deploy, and any
   fixes follow as new PRs.
4. **Units:** SI inside the code. Headings are compass degrees, vectors are
   (east, north). Convert knots and nautical miles only at the edges (`geo.py`).
5. **Mark guesses.** Any number that isn't from a datasheet, a dataset or a
   measurement gets `# GUESS` in the YAML or code, so calibration can find it.
6. **No data in git.** Downloaded weather and run outputs go under `data/` and
   `runs/`, which are ignored.
7. **Before pushing:** `ruff check . && ruff format --check . && pytest`. CI runs
   the same plus a smoke run.
8. **Realism is never faked.** Bluewater is a game, and a polished, fun game with real
   sailing in it is the goal. The simulator in `src/boatsim/` is the referee: the 3D
   view may simplify how things look, but it never changes or disagrees with what the
   simulator says happened, and no result is faked to make the game easier or more
   dramatic.
9. **Cheap is a goal, not a constraint to negotiate.** Never ask John for money
   or a budget without an itemised plan of what it buys and why it's the cheapest
   way to get it. Never go looking for reasons to spend. Running costs (airtime,
   subscriptions, cloud) are simulator *outputs* to minimise, not allowances to fill.
10. **Don't merge main into your PR branch just to keep it fresh.** Every push to a
   PR restarts its checks (the fast gate, about 5 to 8 minutes; the full suite runs
   nightly on main), and GitHub gives us 20
   runners at once, so a round of "merge origin/main" pushes queues everyone. Merge
   main only when there is a conflict, or when the merge desk (Maya) asks for it
   just before merging.
