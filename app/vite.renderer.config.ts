import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "src/renderer/index.html"),
        preview: path.resolve(__dirname, "src/renderer/preview.html"),
        terminal: path.resolve(__dirname, "src/renderer/terminal.html"),
      },
    },
  },
});
