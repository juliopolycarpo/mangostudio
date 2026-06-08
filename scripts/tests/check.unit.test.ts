import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTurboCheckCommand,
  createWorkspaceDprintCommand,
  getCheckCwd,
  getWorkspaceDprintPaths,
} from '../lib/check';
import { ROOT_DIR } from '../lib/config';

const readText = (relativePath: string): string =>
  readFileSync(join(ROOT_DIR, relativePath), 'utf8');

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

  test('runs Turbo checks from the repository root', () => {
    expect(getCheckCwd()).toBe(ROOT_DIR);
  });

  test('preserves selected workspace dprint checks outside Turbo', () => {
    expect(getWorkspaceDprintPaths(['api', 'shared'])).toEqual([
      'apps/api/AGENTS.md',
      'apps/api/bunfig.toml',
      'apps/shared/AGENTS.md',
      'apps/shared/bunfig.toml',
    ]);
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

  test('configures typecheck dependency ordering and root tsconfig inputs', () => {
    const turboConfig = readText('turbo.jsonc');

    expect(turboConfig).toContain('"dependsOn": ["^typecheck"]');
    expect(turboConfig).toContain('"$TURBO_ROOT$/tsconfig.json"');
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
