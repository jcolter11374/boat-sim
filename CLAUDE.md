# Notes for Claude threads working in this repo

- Read CONTRIBUTING.md first; it is the team's rulebook.
- The plan doc (architecture, interfaces, milestones, your brief) is
  https://claude.ai/artifact/4mgi1LeuFF2wfQGRBnXRDR
- Arrival rule: any landfall in Europe counts, Azores included. Test all launch months.
- Runs in the cloud only (thread sandboxes, GitHub Actions). Stream or subset data
  (ARCO-ERA5 public Zarr, Copernicus Marine subsetting) rather than bulk downloads.
- One boat only (the v4 kayak in configs/v4_kayak.yaml). No rescue after the drop.
- Explain nautical terms plainly in anything John reads; he isn't a sailor.
