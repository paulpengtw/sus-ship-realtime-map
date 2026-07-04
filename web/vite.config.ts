import { defineConfig } from "vite";
export default defineConfig({
  root: __dirname,
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
