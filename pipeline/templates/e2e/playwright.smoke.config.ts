// Separate config so the pipeline's smoke run uses its own port and never collides with a
// developer's dev server or the full E2E suite.
import { defineConfig, devices } from '@playwright/test';

// verify's supabase-local env step exports PIPELINE_SMOKE_PORT (4310..4809, from a hash of the project name), so two
// projects verifying at once never share a port; 4310 is only the standalone fallback.
const PORT = Number(process.env.PIPELINE_SMOKE_PORT || 4310);

export default defineConfig({
  testDir: './e2e/smoke',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'smoke', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
