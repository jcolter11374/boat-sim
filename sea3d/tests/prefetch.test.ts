import { test } from "node:test";
import assert from "node:assert/strict";
import { FIRST_WEATHER, HELM_PACKAGES, mayPrefetch, weatherFiles, wheelFiles } from "../src/helm/prefetch";

test("wheelFiles lists each package's wheel after its dependencies, once", () => {
  const lock = {
    packages: {
      numpy: { file_name: "numpy-2.0.whl", depends: [] },
      pyyaml: { file_name: "PyYAML-6.0.whl", depends: ["libyaml"] },
      libyaml: { file_name: "libyaml-0.2.zip" },
    },
  };
  assert.deepEqual(wheelFiles(lock, [...HELM_PACKAGES, "numpy"]), ["numpy-2.0.whl", "libyaml-0.2.zip", "PyYAML-6.0.whl"]);
});

test("wheelFiles skips packages the lock doesn't know", () => {
  assert.deepEqual(wheelFiles({}, ["numpy"]), []);
});

test("the title screen warms the same Pyodide the workers load", async () => {
  const { readFileSync } = await import("node:fs");
  const { PYODIDE_DIR } = await import("../src/helm/prefetch");
  for (const w of ["helm/worker.ts", "race/worker.ts", "yard/sim.worker.ts"]) {
    const dir = readFileSync(new URL(`../src/${w}`, import.meta.url), "utf8").match(/PYODIDE_DIR\s*=\s*"([^"]+)"/)?.[1];
    assert.equal(dir, PYODIDE_DIR, `${w} loads another Pyodide than helm/prefetch.ts warms`);
  }
});

test("the simulator isn't fetched ahead on Save-Data, a slow link or mobile data; an unknown link is fine", () => {
  assert.equal(mayPrefetch(undefined), true); // Safari, Firefox: the browser doesn't say
  assert.equal(mayPrefetch({ effectiveType: "4g" }), true);
  assert.equal(mayPrefetch({ effectiveType: "4g", type: "wifi" }), true);
  assert.equal(mayPrefetch({ saveData: true, effectiveType: "4g" }), false);
  for (const t of ["slow-2g", "2g", "3g"]) assert.equal(mayPrefetch({ effectiveType: t }), false, t);
  assert.equal(mayPrefetch({ effectiveType: "4g", type: "cellular" }), false);
});

test("the title warms the split weather's static file and first months, or the whole season without the list", () => {
  const parts = ["2020-04", "2020-05", "2020-06", "2020-07"].map((key) => ({ key, file: `forcing_2020_${key}.npz` }));
  assert.deepEqual(weatherFiles({ static: "forcing_2020_static.npz", parts }), ["forcing_2020_static.npz", "forcing_2020_2020-04.npz", "forcing_2020_2020-05.npz"]);
  assert.deepEqual(weatherFiles(null), ["forcing_2020.npz"]);
  assert.deepEqual(weatherFiles({} as never), ["forcing_2020.npz"]);
  // 23 April, the usual launch, and the week past its first steps: April and May
  assert.deepEqual(FIRST_WEATHER, ["2020-04", "2020-05"]);
});
