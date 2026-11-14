import { describe, expect, test } from 'bun:test';

import {
  createTurboCheckCommand,
  createWorkspaceCycleCommand,
  createWorkspaceFormatCommand,
  TURBO_CHECK_TASKS,
} from '../lib/check';
import { ROOT_DIR } from '../lib/config';
import { createImportCycleCommand } from '../lib/import-cycle-command';
import { readText } from './support/read-text';

describe('check script', () => {
  test('shares a cycle-only command with explicit configuration, complete diagnostics and roots', () => {
    const roots = ['apps/api', 'packages/protocol'];
    expect(createImportCycleCommand(roots)).toEqual([
      'bun',
      'scripts/check-import-cycles.ts',
      ...roots,
    ]);
    expect(createImportCycleCommand(roots, 'json')).toContain('--json');
    expect(roots).toEqual(['apps/api', 'packages/protocol']);
  });

  test('check help reports the cycle exclusions and source size limit', () => {
    const result = Bun.spawnSync([process.execPath, './scripts/check.ts', '--help'], {
      cwd: ROOT_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const help = result.stdout.toString();
    for (const policy of [
      'node_modules, .git, dist, coverage, and .turbo',
      'root .mango and target',
      'crates/mango-protocol/fuzz/target',
      '.claude/worktrees',
      'over 4 MiB fail before parsing',
    ]) {
      expect(help, `expected cycle help to report ${policy}`).toContain(policy);
    }
  });

  test('check help documents --force and the replay of source scans', () => {
    const result = Bun.spawnSync([process.execPath, './scripts/check.ts', '--help'], {
      cwd: ROOT_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const help = result.stdout.toString();
    for (const text of ['--force', 'Turbo gets --force', 'pass stamps', 'replayed']) {
      expect(
        help,
        `(check --help): expected the help to mention ${text} | received: none`
      ).toContain(text);
    }
  });

  test('stamps the seven source scans, off for --force, CI and report runs', () => {
    const checkScript = readText('scripts/check.ts');
    for (const label of [
      '`$' + '{workspace}:cycles`',
      "'root:cycles'",
      "'root:node-env-branches'",
      "'frontend:api-import-boundary'",
      "'root:shared-import-boundary'",
    ]) {
      expect(
        checkScript,
        `(check): expected sourceScanTask(${label} | received: no such stamped task`
      ).toMatch(new RegExp(`sourceScanTask\\(\\s*${label.replaceAll(/[$.{}`]/g, '\\$&')}`));
    }
    expect(checkScript).toContain('passStampsEnabled(forceRun) && !reportTarget');
    expect(checkScript).toContain('forceRun ? withTurboForce(command) : command');
  });

  test('creates one filtered Turbo invocation for selected workspaces', () => {
    expect(createTurboCheckCommand(['api', 'shared'])).toEqual([
      'turbo',
      'run',
      'check:quick',
      'typecheck:with-deps',
      '--ui=stream',
      '--filter=@mangostudio/api',
      '--filter=@mangostudio/shared',
    ]);
  });

  test('keeps the cycle scan out of the cached Turbo tasks', () => {
    expect(
      TURBO_CHECK_TASKS,
      `(check): expected the cached Turbo check tasks without check:cycles | received: ${TURBO_CHECK_TASKS.join(', ')}`
    ).toEqual(['check:quick', 'typecheck:with-deps']);
  });

  test.each(['api', 'frontend', 'shared'] as const)(
    'scans the %s workspace for import cycles from the repository root',
    (workspace) => {
      expect(createWorkspaceCycleCommand(workspace)).toEqual([
        'bun',
        'scripts/check-import-cycles.ts',
        `apps/${workspace}`,
      ]);
    }
  );

  test('a workspace cycle scan is the command its own check:cycles script runs', () => {
    // `bun ../../scripts/check-import-cycles.ts .` from apps/<name> resolves its root to
    // apps/<name> against ROOT_DIR, the same argument the direct command passes.
    for (const workspace of ['api', 'frontend', 'shared'] as const) {
      const manifest = JSON.parse(readText(`apps/${workspace}/package.json`)) as {
        scripts?: Record<string, string>;
      };
      expect(manifest.scripts?.['check:cycles']).toBe('bun ../../scripts/check-import-cycles.ts .');
      expect(createWorkspaceCycleCommand(workspace).slice(1)).toEqual([
        'scripts/check-import-cycles.ts',
        `apps/${workspace}`,
      ]);
    }
  });

  test('checks selected workspace docs and configuration outside Turbo', () => {
    expect(createWorkspaceFormatCommand('api')).toEqual(['bun', 'fmt', '--check', 'apps/api']);
  });

  test('delegates cached workspace checks to Turbo and runs cycle scans directly', () => {
    const checkScript = readText('scripts/check.ts');

    expect(checkScript).toContain('createTurboCheckCommand');
    expect(checkScript).toMatch(/commandTask\(\s*'workspaces:check'/);
    expect(checkScript).toContain('createWorkspaceCycleCommand(workspace)');
    expect(checkScript).toContain('`$' + '{workspace}:cycles`');
    expect(checkScript).not.toContain('runWorkspaceScript');
    expect(checkScript).not.toContain('root:madge');
  });

  test('gates duplicate lockfile versions in the root checks', () => {
    const checkScript = readText('scripts/check.ts');

    const dedupeTask = "commandTask('root:dedupe', ['bun', 'dedupe', '--check']";

    expect(
      checkScript.includes(dedupeTask),
      `expected scripts/check.ts to run: ${dedupeTask} | received: no root:dedupe task`
    ).toBe(true);
  });

  test('audits the whole lockfile on schedule and through CI', () => {
    const workflow = readText('.github/workflows/dependency-audit.yml');

    // A schedule catches advisories published against versions already on main.
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: /m);
    expect(workflow).toContain('workflow_call:');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).toContain('run: bun audit --audit-level=moderate');
    // bun audit reads bun.lock directly; an install would run dependency code.
    expect(workflow).not.toContain('bun install');
  });

  test('configures typecheck ordering and root config cache inputs', () => {
    const turboConfig = readText('turbo.jsonc');

    // `typecheck` hashes its upstream workspaces through `transit` without
    // waiting for them; `typecheck:with-deps` is what selects them.
    expect(turboConfig).toContain('"dependsOn": ["transit"]');
    expect(turboConfig).toContain('"dependsOn": ["typecheck", "^typecheck:with-deps"]');
    expect(turboConfig).not.toContain('"dependsOn": ["^typecheck"]');
    expect(turboConfig).toContain('"$TURBO_ROOT$/tsconfig.json"');
    expect(turboConfig).toContain('"$TURBO_ROOT$/bunfig.toml"');
    expect(turboConfig).toContain('"$TURBO_DEFAULT$"');
  });

  test('keeps whole-workspace lint and cycle scans separate in every workspace check', () => {
    for (const manifestPath of [
      'apps/api/package.json',
      'apps/frontend/package.json',
      'apps/shared/package.json',
      'packages/protocol/package.json',
    ]) {
      const manifest = JSON.parse(readText(manifestPath)) as { scripts?: Record<string, string> };

      expect(manifest.scripts?.['check:quick']).toBe(
        `bun --cwd ../.. lint ${manifestPath.slice(0, -13)} && bun --cwd ../.. fmt --check ${manifestPath.slice(0, -13)}`
      );
      expect(manifest.scripts?.['check:cycles']).toBe('bun ../../scripts/check-import-cycles.ts .');
      expect(manifest.scripts?.check).toBe(
        'bun run check:quick && bun run check:cycles && bun run typecheck'
      );
      expect(manifest.scripts?.typecheck).toBe('bun check --no-script');
      expect(manifest.scripts?.circular).toBeUndefined();
    }
  });

  test('fixes the same whole workspace that check:quick lints', () => {
    for (const manifestPath of [
      'apps/api/package.json',
      'apps/frontend/package.json',
      'apps/shared/package.json',
    ]) {
      const manifest = JSON.parse(readText(manifestPath)) as { scripts?: Record<string, string> };

      expect(manifest.scripts?.fix, `${manifestPath} fix script`).toBe(
        `bun --cwd ../.. lint --fix ${manifestPath.slice(0, -13)} && bun --cwd ../.. fmt ${manifestPath.slice(0, -13)}`
      );
    }
  });
});
