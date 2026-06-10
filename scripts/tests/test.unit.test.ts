import { describe, expect, test } from 'bun:test';
// Bun parses JSONC natively, so importing the config tolerates the comments and
// trailing commas `turbo.jsonc` is allowed to carry (JSON.parse would throw).
import turboConfigJson from '../../turbo.jsonc';
import { createTurboTestCommand } from '../lib/test';
import { readText } from './support/read-text';

interface TurboConfig {
  tasks: Record<
    string,
    {
      cache?: boolean;
      dependsOn?: string[];
      env?: string[];
      inputs?: string[];
      outputs?: string[];
    }
  >;
}

const turboConfig = turboConfigJson as TurboConfig;

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

  test('runs root script tests through Turbo and keeps browser smoke outside', () => {
    const testScript = readText('scripts/test.ts');

    expect(testScript).toContain("'//#test:scripts'");
    expect(testScript).toContain("runCommand('e2e', [...BROWSER_SMOKE_TEST_COMMAND]");
    expect(testScript).not.toContain("createTurboTestCommand('test:e2e'");
  });

  test('declares env and cache boundaries for test lanes', () => {
    const testEnv = ['DATABASE_PATH', 'CI', 'MANGOSTUDIO_*'];
    expect(turboConfig.tasks['test:unit']).toEqual({ env: testEnv });
    expect(turboConfig.tasks['test:integration']).toEqual({ cache: false, env: testEnv });
    expect(turboConfig.tasks['test:coverage']).toEqual({
      cache: false,
      outputs: ['$TURBO_ROOT$/.mango/artifacts/coverage/**'],
      env: testEnv,
    });
    expect(turboConfig.tasks['test:e2e']).toBeUndefined();
  });

  test('does not add build dependencies to source-driven test lanes', () => {
    for (const task of ['test:unit', 'test:integration', 'test:coverage']) {
      expect(turboConfig.tasks[task]?.dependsOn ?? []).not.toContain('^build');
    }
  });
});
