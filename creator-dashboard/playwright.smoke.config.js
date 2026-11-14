import { defineConfig } from "@playwright/test";

// Serves the built dist (run `npm run build` first); CI builds before this runs.
export default defineConfig({
  testDir: "./smoke",
  testMatch: /.*\.smoke\.js/,
  timeout: 30_000,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:18530", browserName: "chromium" },
  webServer: { command: "npx vite preview --host 127.0.0.1 --port 18530 --strictPort", url: "http://127.0.0.1:18530", reuseExistingServer: false }
});
