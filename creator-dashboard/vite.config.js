import http from "node:http";
import https from "node:https";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const dashboardApiTarget = process.env.HATCH_CREATOR_DASHBOARD_API_URL ?? "http://127.0.0.1:8500";
const dashboardApiUrl = new URL(dashboardApiTarget);
const dashboardApiIsLocal = ["localhost", "127.0.0.1", "::1"].includes(dashboardApiUrl.hostname);
const dashboardApiOrigin = dashboardApiIsLocal ? "http://127.0.0.1:8510" : dashboardApiUrl.origin;
const dashboardApiOriginUrl = new URL(dashboardApiOrigin);
const dashboardApiAgent = dashboardApiIsLocal
  ? dashboardApiUrl.protocol === "https:" ? new https.Agent() : new http.Agent()
  : dashboardApiUrl.protocol === "https:"
    ? new https.Agent({ proxyEnv: process.env })
    : new http.Agent({ proxyEnv: process.env });

function createDashboardApiProxy() {
  return {
    target: dashboardApiTarget,
    agent: dashboardApiAgent,
    changeOrigin: true,
    ws: true,
    headers: {
      origin: dashboardApiOrigin,
      "x-forwarded-host": dashboardApiOriginUrl.host,
      "x-forwarded-proto": dashboardApiOriginUrl.protocol.slice(0, -1)
    },
    configure(proxy) {
      proxy.on("proxyReqWs", proxyRequest => proxyRequest.setHeader("origin", dashboardApiOrigin));
    }
  };
}

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
      // Keep the API-visible Origin and forwarded host aligned with the selected backend.
      "/v1": createDashboardApiProxy(),
      "/api": createDashboardApiProxy()
    }
  }
});
