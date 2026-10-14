import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const shared = fileURLToPath(new URL("../shared", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const api = { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } };

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@shared": shared } },
  server: { port: 5173, fs: { allow: [repoRoot] }, proxy: api },
  preview: { port: 4173, proxy: api },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 700,
  },
});
