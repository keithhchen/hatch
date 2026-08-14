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
      "/v1": process.env.HATCH_CREATOR_DASHBOARD_API_URL ?? "http://127.0.0.1:8500"
    }
  }
});
