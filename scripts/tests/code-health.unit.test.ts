import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { touchesCodeHealthSurface } from '../lib/code-health';
import { ROOT_DIR } from '../lib/config';
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

  test('keeps exported test fixtures in the default graph and out of the production graph', () => {
    const exportedFixtures = [
      { workspace: 'apps/api', subpath: './test-support/chatgpt/fake-server' },
      { workspace: 'apps/shared', subpath: './test-utils' },
    ];
    const workspaceNames = exportedFixtures.map(({ workspace }) => workspace);
    const { workspaces } = JSON.parse(readText('knip.json')) as {
      workspaces: Record<string, unknown>;
    };
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'mango-knip-exported-fixtures-'));
    try {
      writeFileSync(
        join(fixtureRoot, 'package.json'),
        JSON.stringify({ private: true, workspaces: workspaceNames })
      );
      writeFileSync(
        join(fixtureRoot, 'knip.json'),
        JSON.stringify({
          workspaces: Object.fromEntries(workspaceNames.map((name) => [name, workspaces[name]])),
        })
      );

      for (const { workspace, subpath } of exportedFixtures) {
        const manifest = JSON.parse(readText(`${workspace}/package.json`)) as {
          name: string;
          exports: Record<string, string>;
        };
        const fixtureEntry = manifest.exports[subpath];
        expect(
          fixtureEntry,
          `(package exports): expected a source path for ${workspace}${subpath}`
        ).toBeString();
        const fixtureFile = join(fixtureRoot, workspace, fixtureEntry as string);
        const shippedFile = join(fixtureRoot, workspace, 'src/shipped.ts');
        mkdirSync(dirname(fixtureFile), { recursive: true });
        mkdirSync(dirname(shippedFile), { recursive: true });
        writeFileSync(fixtureFile, 'import "./missing-test-dependency.js";\n');
        writeFileSync(shippedFile, 'import "./missing-runtime-dependency.js";\n');
        writeFileSync(
          join(fixtureRoot, workspace, 'package.json'),
          JSON.stringify({
            name: manifest.name,
            private: true,
            exports: { '.': './src/shipped.ts', [subpath]: fixtureEntry },
          })
        );
      }

      for (const mode of ['default', 'production']) {
        const productionFlags = mode === 'production' ? ['--production', '--strict'] : [];
        const result = Bun.spawnSync(
          [
            process.execPath,
            '--no-install',
            'run',
            'knip',
            '--directory',
            fixtureRoot,
            '--include',
            'unresolved',
            '--reporter',
            'json',
            ...productionFlags,
          ],
          { cwd: ROOT_DIR, stderr: 'pipe', stdout: 'pipe' }
        );
        const output = result.stdout.toString();
        expect(
          result.exitCode,
          `(Knip ${mode}): expected unresolved import findings | received: ${result.stderr}`
        ).toBe(1);
        const report = JSON.parse(output) as {
          issues: { unresolved?: { name: string }[] }[];
        };
        const unresolvedImports = report.issues
          .flatMap(({ unresolved }) => unresolved ?? [])
          .map(({ name }) => name);
        const expected = workspaceNames.flatMap(() =>
          mode === 'production'
            ? ['./missing-runtime-dependency.js']
            : ['./missing-runtime-dependency.js', './missing-test-dependency.js']
        );
        expect(
          unresolvedImports.sort(),
          `(Knip ${mode}): unexpected unresolved imports in ${output}`
        ).toEqual(expected.sort());
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
