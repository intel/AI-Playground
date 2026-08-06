import { defineConfig } from '@playwright/test'

// Real-Electron end-to-end tests. The Vue renderer is served by a Vite dev
// server (`--mode test`, which disables the Electron plugin — see vite.config.mts)
// and each test launches the compiled Electron main process pointed at that dev
// server via VITE_DEV_SERVER_URL (set in the launch fixture).
//
// Timeouts are generous: the first run actually installs backends (downloads +
// Python env setup), which can take several minutes.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-e2e', open: 'never' }]],
  timeout: 15 * 60_000,
  expect: {
    timeout: 30_000,
  },
  use: {
    // Always keep a trace (not just on failure): passing runs can still show
    // rendering weirdness (e.g. duplicated reasoning) worth inspecting after the
    // fact via `npx playwright show-trace`.
    trace: 'on',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite --mode test --port 25413',
    url: 'http://127.0.0.1:25413',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_DEBUG_TOOLS: 'true',
      VITE_PLATFORM_TITLE: 'from Intel®',
    },
  },
})
