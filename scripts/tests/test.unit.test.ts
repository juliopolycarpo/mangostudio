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

  test('the cached root scripts lane keys on the shard and restores its JUnit report', () => {
    // Both halves are load-bearing and both fail silently. Without
    // MANGOSTUDIO_* in the key, shard 2 restores shard 1's entry and runs
    // nothing; without the output, a cache hit leaves no report and the shard
    // contributes zero root tests to a run that still looks green.
    expect(turboConfig.tasks['//#test:scripts']).toEqual({
      inputs: ['$TURBO_DEFAULT$', 'scripts/**'],
      outputs: ['$TURBO_ROOT$/.mango/artifacts/junit/root.xml'],
      env: ['CI', 'MANGOSTUDIO_*'],
    });
  });

  test('leaves the shared JUnit directory out of per-workspace outputs', () => {
    // Every workspace writes into one directory, so declaring it would have
    // four tasks claiming the same glob — the overlap the typecheck task's own
    // comment warns cross-contaminates a restored cache.
    for (const task of ['test:unit', 'test:integration', 'test:coverage']) {
      for (const output of turboConfig.tasks[task]?.outputs ?? []) {
        expect(output).not.toContain('junit');
      }
    }
  });

  test('does not add build dependencies to source-driven test lanes', () => {
    for (const task of ['test:unit', 'test:integration', 'test:coverage']) {
      expect(turboConfig.tasks[task]?.dependsOn ?? []).not.toContain('^build');
    }
  });

  test('keeps Bun coverage output machine-readable without duplicate console tables', () => {
    for (const workspace of ['api', 'frontend', 'runtime', 'shared']) {
      const bunfig = readText(`apps/${workspace}/bunfig.toml`);

      expect(bunfig).toContain('coverageReporter = ["lcov"]');
      expect(bunfig).not.toContain('"text"');
    }
  });
});
