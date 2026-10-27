import { describe, expect, test } from 'bun:test';

import {
  BROWSER_SMOKE_BROWSER,
  BROWSER_SMOKE_SETUP_COMMAND,
  BROWSER_SMOKE_TEST_COMMAND,
} from '../lib/browser-smoke';
import { readText } from './support/read-text';
import {
  assertSmokeDeadlineBudget,
  parseSmokeWorkflow,
  smokeStepTimeout,
} from './support/smoke-workflows';

describe('browser smoke setup', () => {
  test('installs only Chromium with Playwright system dependencies through Bun', () => {
    expect(BROWSER_SMOKE_BROWSER).toBe('chromium');
    expect(BROWSER_SMOKE_SETUP_COMMAND).toEqual([
      'bunx',
      'playwright',
      'install',
      '--with-deps',
      'chromium',
    ]);
  });

  test('runs Playwright through Bun for the e2e lane', () => {
    expect(BROWSER_SMOKE_TEST_COMMAND).toEqual(['bunx', 'playwright', 'test']);
  });

  test('exposes a root setup script for local environments', () => {
    const manifest = JSON.parse(readText('package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.['test:e2e:setup']).toBe('bun ./scripts/test-e2e-setup.ts');
  });

  test('CI installs Chromium before running the browser smoke lane', () => {
    const workflow = readText('.github/workflows/browser-smoke.yml');
    const setupIndex = workflow.indexOf('bun run test:e2e:setup');
    const runIndex = workflow.indexOf('bun run test --e2e');

    expect(setupIndex).toBeGreaterThan(-1);
    expect(runIndex).toBeGreaterThan(setupIndex);
    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain('bunx playwright install-deps chromium');
    expect(workflow).not.toContain('npx playwright');
  });

  test.each([
    ['cache miss', 'bun run test:e2e:setup', "steps.pw-cache.outputs.cache-restored != 'true'"],
    [
      'cache hit',
      'bunx playwright install-deps chromium',
      "steps.pw-cache.outputs.cache-restored == 'true'",
    ],
  ])(
    'browser %s leaves room for installation, the smoke deadline and diagnostics',
    (cachePath, installCommand, installCondition) => {
      const workflow = parseSmokeWorkflow(readText('.github/workflows/browser-smoke.yml'));
      const job = workflow.jobs['browser-smoke'];
      if (!job) throw new Error('expected browser-smoke job | received: missing');
      const install = job.steps?.find((step) => step.run === installCommand);
      const smoke = job.steps?.find((step) => step.run?.includes('bun run test --e2e'));
      if (!install || !smoke) {
        throw new Error(
          `expected ${cachePath} installation and smoke commands | received: missing`
        );
      }

      // Each runner executes one installation branch. Keep the old ten-minute
      // maximum for the smoke command itself, independent of installation time.
      expect(install.if).toBe(installCondition);
      // Project the two measured phases, reserving at least five minutes for
      // other setup and failure uploads. A cold manual Rust build is outside this model.
      assertSmokeDeadlineBudget(`browser/${cachePath}`, { ...job, steps: [install, smoke] });
      const smokeDeadline = smokeStepTimeout(smoke, {});
      expect(smokeDeadline, `browser/${cachePath} must retain the ten-minute smoke allowance`).toBe(
        10
      );
      const installDeadline = smokeStepTimeout(install, {});
      expect(installDeadline).toBeLessThanOrEqual(10);
      expect(
        job['timeout-minutes'],
        `browser/${cachePath} must reserve at least five minutes beyond installation and smoke deadlines`
      ).toBeGreaterThanOrEqual((installDeadline ?? 0) + (smokeDeadline ?? 0) + 5);
    }
  );

  test('testing docs show the setup command without npx fallbacks', () => {
    const docs = [
      readText('docs/reference/testing.md'),
      readText('docs/pt-br/reference/testing.md'),
    ];

    for (const doc of docs) {
      expect(doc).toContain('bun run test:e2e:setup');
      expect(doc).toContain('Ubuntu 26.04');
      expect(doc).not.toContain('npx playwright');
    }
  });
});
