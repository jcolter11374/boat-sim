import { defineConfig } from "vite";

// Relative base so the same build works on GitHub Pages (/boat-sim/) and as a
// plain folder of files.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", target: "es2022" },
});
