import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import { createTurboTestCommand } from '../lib/test';

const readText = (relativePath: string): string =>
  readFileSync(join(ROOT_DIR, relativePath), 'utf8');

const readJson = <T>(relativePath: string): T => JSON.parse(readText(relativePath)) as T;

interface TurboConfig {
  tasks: Record<string, { cache?: boolean; dependsOn?: string[]; outputs?: string[] }>;
}

describe('test script', () => {
  test('creates one filtered Turbo invocation for a workspace test lane', () => {
    expect(createTurboTestCommand('test:unit', ['api', 'shared'])).toEqual([
      'turbo',
      'run',
      'test:unit',
      '--ui=stream',
      '--filter=@mangostudio/api',
      '--filter=@mangostudio/shared',
    ]);
  });

  test('delegates workspace test lanes to Turbo', () => {
    const testScript = readText('scripts/test.ts');

    expect(testScript).toContain('createTurboTestCommand');
    expect(testScript).toContain("runCommand('workspaces:test:unit'");
    expect(testScript).toContain("'workspaces:test:integration'");
    expect(testScript).toContain("'workspaces:test:coverage'");
    expect(testScript).not.toContain('runWorkspaceScript');
  });

  test('keeps root script tests explicit and browser smoke outside Turbo', () => {
    const testScript = readText('scripts/test.ts');

    expect(testScript).toContain("runCommand('root:test:unit', ['bun', 'test', 'scripts']");
    expect(testScript).toContain("runCommand('e2e', [...BROWSER_SMOKE_TEST_COMMAND]");
    expect(testScript).not.toContain("createTurboTestCommand('test:e2e'");
  });

  test('keeps conservative Turbo cache boundaries for test lanes', () => {
    const turboConfig = readJson<TurboConfig>('turbo.jsonc');

    expect(turboConfig.tasks['test:unit']).toEqual({});
    expect(turboConfig.tasks['test:integration']).toEqual({ cache: false });
    expect(turboConfig.tasks['test:coverage']).toEqual({
      cache: false,
      outputs: ['coverage/**'],
    });
    expect(turboConfig.tasks['test:e2e']).toBeUndefined();
  });

  test('does not add build dependencies to source-driven test lanes', () => {
    const turboConfig = readJson<TurboConfig>('turbo.jsonc');

    for (const task of ['test:unit', 'test:integration', 'test:coverage']) {
      expect(turboConfig.tasks[task]?.dependsOn ?? []).not.toContain('^build');
    }
  });
});
