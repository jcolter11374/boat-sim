// Unit tests: bundles every tests/*.test.ts with esbuild and runs them with
// node --test. Picks the files up by name, so a new test file needs no edit
// to package.json (the old one-line list made every two PRs that added a test
// conflict, and each conflict re-ran the whole gate). Kai, 12 Nov 2026.
//   npm run test:unit
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const tests = readdirSync("tests").filter((f) => f.endsWith(".test.ts")).sort();
if (!tests.length) {
  console.error("no tests/*.test.ts found");
  process.exit(1);
}
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("node_modules/.bin/esbuild", [
  ...tests.map((f) => `tests/${f}`),
  "--bundle", "--platform=node", "--format=esm", "--outdir=test-output",
  "--out-extension:.js=.mjs", "--log-level=warning",
]);
run(process.execPath, ["--test", ...tests.map((f) => `test-output/${f.replace(/\.ts$/, ".mjs")}`)]);
