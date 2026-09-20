import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [react()],
  // @hatch/ui is a linked local package during development. Force every
  // component onto the Dashboard's React instance so hooks cannot resolve a
  // second physical copy from packages/ui/node_modules.
  resolve: {
    dedupe: ["react", "react-dom"]
  },
  server: {
    port: 8510,
    fs: {
      allow: [".."]
    },
    proxy: {
      // The Dashboard API validates mutation Origin against the browser-facing
      // host. Vite's proxy otherwise sends its target host (18500 locally),
      // which makes every local login/sign-up look cross-origin.
      "/v1": {
        target: process.env.HATCH_CREATOR_DASHBOARD_API_URL ?? "http://127.0.0.1:8500",
        ws: true,
        headers: { "x-forwarded-host": "127.0.0.1:8510", "x-forwarded-proto": "http" }
      },
      "/api": {
        target: process.env.HATCH_CREATOR_DASHBOARD_API_URL ?? "http://127.0.0.1:8500",
        ws: true,
        headers: { "x-forwarded-host": "127.0.0.1:8510", "x-forwarded-proto": "http" }
      }
    }
  }
});
