import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./frontend/tests/e2e",
  forbidOnly: !!process.env.CI,
  reporter: "list",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3187" },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
  webServer: {
    command: "npm run build && PORT=3187 HOST=127.0.0.1 npm start",
    url: "http://127.0.0.1:3187/api/history",
    reuseExistingServer: false,
  },
});
