# Notes for Claude threads working in this repo

- Read CONTRIBUTING.md first; it is the team's rulebook.
- The plan doc (architecture, interfaces, milestones, your brief) is
  https://claude.ai/artifact/4mgi1LeuFF2wfQGRBnXRDR
- Success rule (John, 9 Nov 2026): follow the Microtransat Challenge rules
  (runner/arrival.py). Start = crossing their western line; finish = within 25 km of
  our target on their eastern line (39.5N 13.5W, west of Lisbon); landfall anywhere,
  Azores and Europe included, is not a finish; silent >10 days in a row or >15 total
  is disqualified. Test all launch months, but the target window is April to June:
  tune and headline on Apr-Jun, report every month for context.
- Length rule (John, 9 Nov 2026): the race caps length at 2.4 m; our 3.05 m kayak breaks
  that on purpose ("we can break that rule. Just make a note of it"). Every other rule applies.
- Shakedown (John, 9 Nov 2026): a 14-day unattended shakedown trial before the drop is
  planned, so the planning hazard set's shakedown_days: 14 is the real plan, not a guess.
- Runs in the cloud only (thread sandboxes, GitHub Actions). Stream or subset data
  (ARCO-ERA5 public Zarr, Copernicus Marine subsetting) rather than bulk downloads.
- One boat only (the v4 kayak in configs/v4_kayak.yaml). No rescue after the drop.
- Explain nautical terms plainly in anything John reads; he isn't a sailor.
- Never ask John for money or a budget without an itemised plan; never hunt for reasons
  to spend. Costs like satellite airtime are outputs to minimise (CONTRIBUTING.md rule 9).
