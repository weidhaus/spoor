import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

// The Python app serves the built UI from the same origin. In development, Vite proxies the API and the
// OIDC redirects to it (`uv run uvicorn app.main:app --port 8000`).
const backend = "http://localhost:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    proxy: {
      "/api": backend,
      "^/login/(google|microsoft)": backend,
      "/auth": backend,
    },
  },
  // ponytail: one bundle (~380 KB gzip) is fine for an internal tool on localhost; split routes with lazy() if load time matters.
  build: { sourcemap: false, chunkSizeWarningLimit: 1500 },
});
