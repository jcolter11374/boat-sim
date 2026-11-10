import { resolve } from "node:path";
import { defineConfig } from "vite";

// Relative base so the same build works on GitHub Pages (/boat-sim/) and as a
// plain folder of files. Two pages: the showroom (index.html) and the voyage
// replay (voyage.html).
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    target: "es2022",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        voyage: resolve(__dirname, "voyage.html"),
        boatyard: resolve(__dirname, "boatyard.html"),
      },
    },
  },
});
