import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/ui",
  outputDir: ".test-results/ui",
  reporter: [["list"], ["json", { outputFile: ".test-results/ui-report.json" }]],
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:1420",
    headless: true,
    viewport: { width: 1240, height: 820 },
  },
  webServer: {
    command: "npm run ui:dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
});
