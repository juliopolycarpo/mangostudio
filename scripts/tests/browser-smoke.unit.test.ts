import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROWSER_SMOKE_BROWSER,
  BROWSER_SMOKE_SETUP_COMMAND,
  BROWSER_SMOKE_TEST_COMMAND,
} from '../lib/browser-smoke';
import { ROOT_DIR } from '../lib/config';

const readText = (relativePath: string): string =>
  readFileSync(join(ROOT_DIR, relativePath), 'utf8');

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
