import { describe, expect, test } from 'bun:test';

import { createTurboCheckCommand, createWorkspaceFormatCommand } from '../lib/check';
import { createImportCycleCommand } from '../lib/import-cycles';
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
  test('creates one filtered Turbo invocation for selected workspaces', () => {
    expect(createTurboCheckCommand(['api', 'shared'])).toEqual([
      'turbo',
      'run',
      'check:quick',
      'check:cycles',
      'typecheck:with-deps',
      '--ui=stream',
      '--filter=@mangostudio/api',
      '--filter=@mangostudio/shared',
    ]);
  });

  test('checks selected workspace docs and configuration outside Turbo', () => {
    expect(createWorkspaceFormatCommand('api')).toEqual(['bun', 'fmt', '--check', 'apps/api']);
  });

  test('delegates workspace source checks to Turbo', () => {
    const checkScript = readText('scripts/check.ts');

    expect(checkScript).toContain('createTurboCheckCommand');
    expect(checkScript).toContain("commandTask('workspaces:check'");
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
