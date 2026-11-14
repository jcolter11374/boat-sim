import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
// @ts-expect-error a plain script with no types of its own
import { compressModels } from "./scripts/draco_models.mjs";

/** After the build: compress the models' geometry in dist/models (scripts/draco_models.mjs) and
 *  put three's Draco decoder beside the pages, where src/gltf.ts looks for it. */
function dracoModels(): Plugin {
  return {
    name: "draco-models",
    apply: "build",
    async closeBundle() {
      const out = resolve(__dirname, "dist");
      const from = resolve(__dirname, "node_modules/three/examples/jsm/libs/draco/gltf");
      mkdirSync(resolve(out, "draco"), { recursive: true });
      for (const f of ["draco_decoder.wasm", "draco_wasm_wrapper.js", "draco_decoder.js"]) cpSync(resolve(from, f), resolve(out, "draco", f));
      const rows: [string, number, number][] = await compressModels([resolve(out, "models")]);
      const mb = (i: 1 | 2) => (rows.reduce((s, r) => s + r[i], 0) / 1048576).toFixed(1);
      console.log(rows.length ? `models compressed: ${rows.length} files, ${mb(1)} MB -> ${mb(2)} MB` : "models compressed: none in this build");
    },
  };
}

// Relative base so the same build works on GitHub Pages (/boat-sim/) and as a
// plain folder of files. Two pages: the showroom (index.html) and the voyage
// replay (voyage.html).
export default defineConfig({
  base: "./",
  plugins: [dracoModels()],
  build: {
    outDir: "dist",
    target: "es2022",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        voyage: resolve(__dirname, "voyage.html"),
        boatyard: resolve(__dirname, "boatyard.html"),
        helm: resolve(__dirname, "helm.html"),
        leaderboard: resolve(__dirname, "leaderboard.html"),
        race: resolve(__dirname, "race.html"),
      },
    },
  },
});
