import { describe, expect, test } from 'bun:test';

import {
  BROWSER_SMOKE_BROWSER,
  BROWSER_SMOKE_SETUP_COMMAND,
  BROWSER_SMOKE_TEST_COMMAND,
} from '../lib/browser-smoke';
import { readText } from './support/read-text';
import { parseSmokeWorkflow } from './support/smoke-workflows';

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

  test('CI pins the Playwright image to the locked browser version', () => {
    const workflow = parseSmokeWorkflow(readText('.github/workflows/browser-smoke.yml'));
    const job = workflow.jobs['browser-smoke'];
    const lock = Bun.JSONC.parse(readText('bun.lock')) as {
      packages: Record<string, [string, ...unknown[]]>;
    };
    const packageId = lock.packages['@playwright/test']?.[0];
    const version = packageId?.match(/^@playwright\/test@(\d+\.\d+\.\d+)$/)?.[1];
    if (!version) {
      throw new Error(
        `expected @playwright/test lock entry with a stable version | received: ${packageId}`
      );
    }

    expect(job?.['runs-on']).toBe('ubuntu-26.04');
    const imagePrefix = `mcr.microsoft.com/playwright:v${version}-resolute@sha256:`;
    expect(job?.container?.image.slice(0, imagePrefix.length)).toBe(imagePrefix);
    expect(job?.container?.image.slice(imagePrefix.length)).toMatch(/^[a-f0-9]{64}$/);
    expect(job?.container?.volumes).toContain('/usr/bin/unzip:/usr/local/bin/unzip:ro');
  });

  test('CI verifies the image before launching either smoke suite', () => {
    const workflowText = readText('.github/workflows/browser-smoke.yml');
    const workflow = parseSmokeWorkflow(workflowText);
    const steps = workflow.jobs['browser-smoke']?.steps ?? [];
    const imageIndex = steps.findIndex((step) => step.name === 'Verify the Playwright image');
    const developmentIndex = steps.findIndex((step) => step.run?.includes('bun run test --e2e'));
    const productionIndex = steps.findIndex((step) =>
      step.run?.includes('bun run test:e2e:production')
    );

    expect(imageIndex).toBeGreaterThanOrEqual(0);
    expect(steps[imageIndex]?.if).toBeUndefined();
    expect(steps[imageIndex]?.run).toContain('/ms-playwright/.docker-info');
    expect(steps[imageIndex]?.run).toContain('driverVersion');
    expect(developmentIndex).toBeGreaterThan(imageIndex);
    expect(productionIndex).toBeGreaterThan(imageIndex);
    expect(workflowText).not.toContain('bunx playwright install-deps');
    expect(workflowText).not.toContain('bun run test:e2e:setup');
  });

  test('CI uses the caller runtime artifact or builds one for both suites', () => {
    const workflow = parseSmokeWorkflow(readText('.github/workflows/browser-smoke.yml'));
    const build = workflow.jobs['build-runtime'];
    const browser = workflow.jobs['browser-smoke'];
    const runtime = browser?.steps?.find((step) => step.uses === '$/.github/actions/local-runtime');

    expect(build?.uses).toBe('$/.github/workflows/local-runtime.yml');
    expect(build?.if).toContain('!inputs.runtime_artifact');
    expect(browser?.needs).toEqual(['build-runtime']);
    expect(browser?.if).toContain("needs.build-runtime.result == 'success'");
    expect(browser?.if).toContain(
      "needs.build-runtime.result == 'skipped' && inputs.runtime_artifact"
    );
    expect(runtime?.with?.artifact).toContain(
      'inputs.runtime_artifact || needs.build-runtime.outputs.artifact'
    );
  });

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
