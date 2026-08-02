import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/portal/",
  plugins: [react()],
  server: {
    port: 8510,
    proxy: {
      "/v1": process.env.HATCH_CREATOR_DASHBOARD_API_URL ?? "http://127.0.0.1:8500"
    }
  }
});
