import { describe, expect, test } from 'bun:test';

import { touchesCodeHealthSurface } from '../lib/code-health';
import { readText } from './support/read-text';

describe('code-health check', () => {
  test('runs for entry graph, dependency, and workspace source changes', () => {
    for (const file of [
      'package.json',
      'bun.lock',
      'knip.json',
      '.gitignore',
      '.github/workflows/ci.yml',
      '.github/actions/setup-mango/action.yml',
      '.claude/hooks/auto-fix.mjs',
      '.codex/hooks/auto-fix.mjs',
      'scripts/check.ts',
      'tests/browser-smoke/auth-flow.spec.ts',
      'apps/api/package.json',
      'apps/api/bunfig.toml',
      'apps/api/src/app.ts',
      'apps/api/tests/unit/app.test.ts',
      'apps/frontend/build.ts',
      'apps/frontend/src/index.css',
      'packages/cli/bin/mangostudio.js',
    ]) {
      expect(touchesCodeHealthSurface([file]), file).toBe(true);
    }
  });

  test('skips documentation and unrelated repository metadata', () => {
    expect(
      touchesCodeHealthSurface([
        'README.md',
        'docs/reference/testing.md',
        'scripts/README.md',
        '.github/ISSUE_TEMPLATE/bug.yml',
        'packages/cli/README.md',
      ])
    ).toBe(false);
  });

  test('is wired into full and change-scoped check runs', () => {
    const checkScript = readText('scripts/check.ts');

    expect(checkScript).toContain('touchesCodeHealthSurface');
    expect(checkScript).toContain("commandTask('root:code-health'");
    expect(checkScript).toContain("commandTask('root:code-health-production'");
  });

  test('gates dependency placement against production entries only', () => {
    const scripts = JSON.parse(readText('package.json')).scripts as Record<string, string>;
    const knip = JSON.parse(readText('knip.json')) as {
      workspaces: Record<string, { entry?: string[]; project?: string[] }>;
    };

    expect(scripts['code-health:production']).toContain('--production --strict');
    expect(scripts['code-health:production']).toContain('--include dependencies,unlisted');
    // Without a `!` production marker a workspace has no production graph, and
    // Knip reports every runtime dependency in it as unused.
    for (const workspace of [
      'apps/api',
      'apps/frontend',
      'apps/shared',
      'packages/protocol',
      'packages/cli',
    ]) {
      const patterns = [
        ...(knip.workspaces[workspace]?.entry ?? []),
        ...(knip.workspaces[workspace]?.project ?? []),
      ];
      expect(
        patterns.filter((pattern) => pattern.endsWith('!')),
        `(knip.json): expected a production pattern ending in "!" for ${workspace} | received: ${JSON.stringify(patterns)}`
      ).not.toHaveLength(0);
    }
  });
});
