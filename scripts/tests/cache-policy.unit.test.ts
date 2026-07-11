import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';

const CACHE_ACTION_SHA = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
const EXPRESSION_START = '$' + '{{';
const CACHE_EPOCH_EXPRESSION = `cache-epoch: ${EXPRESSION_START} vars.CI_CACHE_EPOCH || 'v1' }}`;
const CACHE_ACTIONS = [
  'setup-mango',
  'cache-turbo',
  'cache-vite',
  'cache-tsbuildinfo',
  'cache-lint-tools',
  'cache-playwright',
] as const;

function workflowFiles(): string[] {
  return readdirSync(join(ROOT_DIR, '.github', 'workflows'))
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => `.github/workflows/${file}`);
}

describe('CI cache policy', () => {
  test('keeps every cache family behind one composite and one immutable pin', () => {
    for (const workflowFile of workflowFiles()) {
      expect(readText(workflowFile), workflowFile).not.toContain('uses: actions/cache@');
    }

    for (const action of CACHE_ACTIONS) {
      const manifest = readText(`.github/actions/${action}/action.yml`);
      const cacheUses =
        manifest.match(/uses: actions\/cache(?:\/(?:restore|save))?@[a-f0-9]{40} # v[^\n]+/g) ?? [];
      expect(cacheUses, action).toHaveLength(action === 'cache-playwright' ? 2 : 1);
      for (const use of cacheUses) {
        expect(use, action).toContain(`@${CACHE_ACTION_SHA} # v6.1.0`);
      }
    }
  });

  test('passes the repository epoch fallback to every cache composite call', () => {
    for (const workflowFile of workflowFiles()) {
      const lines = readText(workflowFile).split('\n');
      for (const [index, line] of lines.entries()) {
        if (!line.includes('uses: ./.github/actions/')) continue;
        if (!CACHE_ACTIONS.some((action) => line.endsWith(`/${action}`))) continue;

        const followingLines = lines.slice(index + 1, index + 4).map((value) => value.trim());
        expect(followingLines, `${workflowFile}:${index + 1}`).toContain(CACHE_EPOCH_EXPRESSION);
      }
    }
  });

  test('uses trusted main restore prefixes and standardized diagnostics', () => {
    for (const action of CACHE_ACTIONS) {
      const manifest = readText(`.github/actions/${action}/action.yml`);
      expect(manifest, action).toMatch(/\$\{RUNNER_OS\}-\$\{RUNNER_ARCH\}/);
      expect(manifest, action).toContain(`${EXPRESSION_START} inputs.cache-epoch }}`);
      expect(manifest, action).toContain("github.event_name == 'pull_request'");
      expect(manifest, action).toContain("github.ref == 'refs/heads/main'");
      expect(manifest, action).toContain('-main-');
      expect(manifest, action).not.toContain('github.sha');
      for (const output of ['cache-hit:', 'primary-key:', 'restored-prefix:']) {
        expect(manifest, action).toContain(output);
      }
      expect(manifest, action).toContain('$GITHUB_STEP_SUMMARY');
      expect(manifest, action).not.toMatch(/path:.*(?:credential|secret|token)/i);
      if (action !== 'cache-playwright') {
        expect(manifest, action).not.toMatch(
          /steps\.cache\.outputs\.cache-(?:primary|matched)-key/
        );
      }
    }
  });

  test('keys each family on its actual toolchain and content invalidators', () => {
    const bun = readText('.github/actions/setup-mango/action.yml');
    expect(bun).toContain('bun --version');
    expect(bun).toContain("hashFiles('bun.lock')");

    const turbo = readText('.github/actions/cache-turbo/action.yml');
    expect(turbo).toContain('bun run turbo:version');
    expect(turbo).toContain("hashFiles('turbo.jsonc', 'package.json'");

    const vite = readText('.github/actions/cache-vite/action.yml');
    for (const file of ['bun.lock', 'vite.config.ts', 'vitest.config.ts', 'tsconfig*.json']) {
      expect(vite).toContain(file);
    }

    const tsbuildinfo = readText('.github/actions/cache-tsbuildinfo/action.yml');
    expect(tsbuildinfo).toContain('tsc --version');
    expect(tsbuildinfo).toContain("hashFiles('tsconfig*.json'");
    expect(tsbuildinfo).toContain("hashFiles('apps/**/*.ts', 'apps/**/*.tsx'");

    const lintTools = readText('.github/actions/cache-lint-tools/action.yml');
    expect(lintTools).toContain("hashFiles('scripts/lib/actions-lint/manifest.ts')");

    const playwright = readText('.github/actions/cache-playwright/action.yml');
    expect(playwright).toContain('playwright --version');
    expect(playwright).toContain("cache-matched-key != ''");
    expect(playwright).toContain('actions/cache/restore@');
    expect(playwright).toContain('actions/cache/save@');
    expect(readText('.github/workflows/browser-smoke.yml')).toContain(
      "steps.pw-cache.outputs.cache-restored == 'true'"
    );
  });
});
