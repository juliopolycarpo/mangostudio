import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer;
if (!server) throw new Error('Expected the maintained browser smoke webServer configuration');

// `test:e2e:production` builds the compiled frontend before Playwright starts.
// Keep the hub at the root: its static frontend discovery is relative to cwd.
export default defineConfig({
  ...base,
  projects: base.projects?.map((project) =>
    project.name === 'chromium'
      ? {
          ...project,
          testMatch: ['**/grid-late-card-state.spec.ts', '**/motion-presets.spec.ts'],
        }
      : project
  ),
  webServer: [{ ...server, command: 'bun apps/api/src/index.ts serve', cwd: import.meta.dir }],
});
