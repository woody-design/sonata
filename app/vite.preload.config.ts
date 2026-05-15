import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/preload",
    emptyOutDir: true,
    sourcemap: true,
    target: "node22",
    lib: {
      entry: "src/preload/preload.ts",
      formats: ["cjs"],
      fileName: () => "preload.js",
    },
    rollupOptions: {
      external: ["electron"],
    },
  },
});
