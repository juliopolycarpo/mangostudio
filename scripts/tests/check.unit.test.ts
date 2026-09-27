import { describe, expect, test } from 'bun:test';
import { createTurboCheckCommand, createWorkspaceDprintCommand } from '../lib/check';
import { readText } from './support/read-text';

describe('check script', () => {
  test('creates one filtered Turbo invocation for selected workspaces', () => {
    expect(createTurboCheckCommand(['api', 'shared'])).toEqual([
      'turbo',
      'run',
      'check:quick',
      'typecheck',
      'circular',
      '--ui=stream',
      '--filter=@mangostudio/api',
      '--filter=@mangostudio/shared',
    ]);
  });

  test('preserves selected workspace dprint checks outside Turbo', () => {
    expect(createWorkspaceDprintCommand('api')).toEqual([
      'bunx',
      'dprint',
      'check',
      'apps/api/AGENTS.md',
      'apps/api/bunfig.toml',
    ]);
  });

  test('delegates workspace source checks to Turbo', () => {
    const checkScript = readText('scripts/check.ts');

    expect(checkScript).toContain('createTurboCheckCommand');
    expect(checkScript).toContain("runCommand('workspaces:check'");
    expect(checkScript).not.toContain('runWorkspaceScript');
    expect(checkScript).not.toContain('root:madge');
  });

  test('gates duplicate lockfile versions in the root checks', () => {
    const checkScript = readText('scripts/check.ts');

    const dedupeTask = "runCommand('root:dedupe', ['bun', 'dedupe', '--check']";

    expect(
      checkScript.includes(dedupeTask),
      `expected scripts/check.ts to run: ${dedupeTask} | received: no root:dedupe task`
    ).toBe(true);
  });

  test('audits the whole lockfile without failing unrelated pull requests', () => {
    const workflow = readText('.github/workflows/dependency-audit.yml');

    // A schedule catches advisories published against versions already on main.
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: /m);
    // Pull requests run it only when the dependency graph moves.
    expect(workflow).toMatch(/^ {4}paths:\n(?: {6}- .+\n)*? {6}- bun\.lock\n/m);
    expect(workflow).toContain('run: bun audit --audit-level=moderate');
    // bun audit reads bun.lock directly; an install would run dependency code.
    expect(workflow).not.toContain('bun install');
  });

  test('configures typecheck ordering and root config cache inputs', () => {
    const turboConfig = readText('turbo.jsonc');

    expect(turboConfig).toContain('"dependsOn": ["^typecheck"]');
    expect(turboConfig).toContain('"$TURBO_ROOT$/tsconfig.json"');
    expect(turboConfig).toContain('"$TURBO_ROOT$/biome.json"');
    expect(turboConfig).toContain('"$TURBO_DEFAULT$"');
  });

  test('exposes circular checks in TypeScript workspaces', () => {
    for (const manifestPath of [
      'apps/api/package.json',
      'apps/frontend/package.json',
      'apps/shared/package.json',
    ]) {
      const manifest = JSON.parse(readText(manifestPath)) as { scripts?: Record<string, string> };

      expect(manifest.scripts?.circular).toBe('madge --circular --extensions ts,tsx .');
    }
  });
});
