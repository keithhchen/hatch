import { defineConfig } from "@playwright/test";

const port = Number(process.env.HATCH_E2E_PORT ?? 18_500);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  outputDir: "e2e/test-results",
  reporter: process.env.CI ? [["line"], ["html", { outputFolder: "e2e/playwright-report", open: "never" }]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    reducedMotion: "reduce"
  },
  webServer: {
    command: "npm run build && node e2e/test-server.mjs",
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe"
  },
  projects: [
    { name: "mobile-320", use: { viewport: { width: 320, height: 700 } } },
    { name: "mobile-390", use: { viewport: { width: 390, height: 844 } } },
    { name: "tablet-768", use: { viewport: { width: 768, height: 1024 } } },
    { name: "desktop-1280", use: { viewport: { width: 1280, height: 800 } } }
  ]
});
