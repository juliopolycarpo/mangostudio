import { describe, expect, test } from 'bun:test';

import { runProductionBrowserSmoke } from '../browser-production';
import { ROOT_DIR } from '../lib/config';
import type { runCommand, RunResult } from '../lib/exec';
import { readText } from './support/read-text';
import { parseSmokeWorkflow, smokeStepTimeout } from './support/smoke-workflows';

describe('hosted production browser regressions', () => {
  test('requires independent development and production browser outcomes', () => {
    const workflow = parseSmokeWorkflow(readText('.github/workflows/browser-smoke.yml'));
    const job = workflow.jobs['browser-smoke'];

    expect(job?.strategy?.matrix.mode).toEqual(['development', 'production']);
    expect(job?.['continue-on-error']).not.toBe(true);
    const strategy = job?.strategy as { 'fail-fast'?: boolean } | undefined;
    expect(strategy?.['fail-fast']).toBe(false);

    const ci = Bun.YAML.parse(readText('.github/workflows/ci.yml')) as {
      jobs: Record<string, { needs?: string[]; uses?: string }>;
    };
    expect(ci.jobs['browser-smoke']?.uses).toBe('./.github/workflows/browser-smoke.yml');
    expect(ci.jobs.gate?.needs).toContain('browser-smoke');
    expect(ci.jobs['gate-unique']?.needs).toContain('browser-smoke');
  });

  test('builds production before Playwright within the existing smoke deadline', () => {
    const manifest = JSON.parse(readText('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['test:e2e:production']).toBe('bun ./scripts/browser-production.ts');

    const workflow = parseSmokeWorkflow(readText('.github/workflows/browser-smoke.yml'));
    const job = workflow.jobs['browser-smoke'];
    const production = job?.steps?.find((step) =>
      step.run?.includes('bun run test:e2e:production')
    );
    const development = job?.steps?.find((step) => step.run?.includes('bun run test --e2e'));
    expect(production?.if).toBe("matrix.mode == 'production'");
    expect(development?.if).toBe("matrix.mode == 'development'");
    expect(production?.run).toContain('set -o pipefail');
    expect(production?.run).toContain('tee smoke-run.log');
    expect(production && smokeStepTimeout(production, {})).toBe(10);
    expect(development && smokeStepTimeout(development, {})).toBe(10);
    expect(job?.['timeout-minutes']).toBe(25);
  });

  test('keeps per-leg diagnostics distinct without loosening the browser cache', () => {
    const workflow = parseSmokeWorkflow(readText('.github/workflows/browser-smoke.yml'));
    const steps = workflow.jobs['browser-smoke']?.steps ?? [];
    const uploads = steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.with?.name).toContain('matrix.mode');
      expect(upload.with?.name).toContain('production');
    }
    const caches = steps.filter((step) => step.uses === './.github/actions/cache-scoped');
    expect(caches).toHaveLength(2);
    for (const cache of caches) {
      expect(cache.with?.family).toBe('playwright');
      expect(cache.with?.['exact-restore']).toBe('true');
      expect(cache.with?.validity).toBe(`\${{ steps.toolchain.outputs.playwright }}`);
    }
  });
});

class FakeBrowserCommands {
  readonly calls: { label: string; command: string[]; cwd: string | undefined }[] = [];

  constructor(private readonly exits: number[]) {}

  readonly execute: typeof runCommand = (label, command, options): Promise<RunResult> => {
    this.calls.push({ label, command, cwd: options?.cwd });
    const exitCode = this.exits[this.calls.length - 1];
    if (exitCode === undefined)
      throw new Error(`Unexpected command ${label}; expected no later phase`);
    return Promise.resolve({ label, exitCode, duration: 0 });
  };
}

describe('supervised production browser phases', () => {
  test('a failed build prevents browser launch and retains the failure receipt', async () => {
    const fake = new FakeBrowserCommands([23, 0]);
    const results = await runProductionBrowserSmoke([], fake.execute);
    expect(fake.calls).toEqual([
      {
        label: 'production:build',
        command: ['bun', 'run', '--filter', '@mangostudio/frontend', 'build'],
        cwd: ROOT_DIR,
      },
    ]);
    expect(results).toEqual([{ label: 'production:build', exitCode: 23, duration: 0 }]);
  });

  test('forwards browser options only after the production build', async () => {
    const fake = new FakeBrowserCommands([0, 0]);
    await runProductionBrowserSmoke(['--workers=1', '--retries=0'], fake.execute);
    expect(fake.calls[0]?.command).not.toContain('--workers=1');
    expect(fake.calls[1]?.command.slice(-2)).toEqual(['--workers=1', '--retries=0']);
  });

  test.each([0, 17])(
    'a settled build admits the browser and retains its exit %s',
    async (exitCode) => {
      const fake = new FakeBrowserCommands([0, exitCode]);
      const results = await runProductionBrowserSmoke([], fake.execute);
      expect(fake.calls.map((call) => call.label)).toEqual([
        'production:build',
        'production:browser',
      ]);
      expect(fake.calls[1]).toEqual({
        label: 'production:browser',
        command: [
          'bunx',
          '--bun',
          '--no-install',
          'playwright',
          'test',
          '--config',
          'playwright.production.config.ts',
        ],
        cwd: ROOT_DIR,
      });
      expect(results).toEqual([
        { label: 'production:build', exitCode: 0, duration: 0 },
        { label: 'production:browser', exitCode, duration: 0 },
      ]);
    }
  );
});
