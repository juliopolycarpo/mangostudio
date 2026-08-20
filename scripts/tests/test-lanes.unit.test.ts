import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { ALL_WORKSPACE_NAMES, ROOT_DIR } from '../lib/config';
import { parseShard, testLaneEnv } from '../lib/test';
import { SHARDED_LCOV_PATHS, TEST_LANES } from '../lib/test-lanes';

const readScripts = async (manifest: string): Promise<Record<string, string>> => {
  const json = (await Bun.file(join(ROOT_DIR, manifest)).json()) as {
    scripts?: Record<string, string>;
  };
  return json.scripts ?? {};
};

describe('test lane declarations', () => {
  // The lane table is what the shard collector reads; the manifests are what
  // actually runs. A lane writing its report somewhere the collector does not
  // look is a silently missing count on a green-looking run, so pin the pair.
  it.each(TEST_LANES.filter((lane) => lane.runner === 'bun'))(
    'the $id lane writes JUnit where the lane table says it does',
    async (lane) => {
      const scripts = await readScripts(lane.manifest);
      const script = scripts[lane.coverageScript];
      expect(script).toBeDefined();
      // Workspace manifests reach the repo root through `../../`; the root one
      // does not.
      const expected =
        lane.manifest === 'package.json' ? lane.junitPath : `../../${lane.junitPath}`;
      expect(script).toContain(`--reporter-outfile=${expected}`);
      expect(script).toContain('--reporter=junit');
    }
  );

  it('every Bun lane takes the shard argument', async () => {
    for (const lane of TEST_LANES.filter((candidate) => candidate.runner === 'bun')) {
      const scripts = await readScripts(lane.manifest);
      expect(scripts[lane.coverageScript]).toContain('$MANGOSTUDIO_BUN_TEST_ARGS');
    }
  });

  it('the Vitest lane takes its whole reporter configuration from the environment', async () => {
    const scripts = await readScripts('apps/frontend/package.json');
    expect(scripts['test:coverage:vitest']).toContain('$MANGOSTUDIO_VITEST_ARGS');
    // Not a literal reporter: sharded and unsharded runs need structurally
    // different ones (blob vs junit), which is why it is env-driven.
    expect(scripts['test:coverage:vitest']).not.toContain('--reporter=');
  });

  it('covers every workspace whose LCOV a shard splits', () => {
    const laneWorkspaces = new Set(
      TEST_LANES.filter((lane) => lane.runner === 'bun' && lane.workspace !== 'root').map(
        (lane) => lane.id
      )
    );
    expect(new Set(Object.keys(SHARDED_LCOV_PATHS))).toEqual(laneWorkspaces);
  });

  it('has one lane per workspace plus root, with unique JUnit paths', () => {
    const covered = new Set(TEST_LANES.map((lane) => lane.workspace));
    expect(covered).toEqual(new Set(['root', ...ALL_WORKSPACE_NAMES]));
    expect(new Set(TEST_LANES.map((lane) => lane.junitPath)).size).toBe(TEST_LANES.length);
  });
});

describe('parseShard', () => {
  it('accepts a valid index/count pair', () => {
    expect(parseShard('--shard=3/8')).toEqual({ index: 3, count: 8 });
    expect(parseShard('--shard=1/1')).toEqual({ index: 1, count: 1 });
  });

  // Each of these would otherwise run a fraction of the files and exit 0.
  it.each([
    ['--shard=0/4', 'index'],
    ['--shard=5/4', 'index'],
    ['--shard=1/0', 'count'],
    ['--shard=2', 'index/count'],
    ['--shard=a/b', 'index/count'],
    ['--shard=1/2/3', 'index/count'],
    ['--shard=', 'index/count'],
  ])('rejects %s', (arg) => {
    expect(() => parseShard(arg)).toThrow();
  });
});

describe('testLaneEnv', () => {
  it('writes JUnit directly when unsharded', () => {
    const env = testLaneEnv(null);
    expect(env.MANGOSTUDIO_TEST_SHARD).toBe('');
    expect(env.MANGOSTUDIO_BUN_TEST_ARGS).toBe('');
    expect(env.MANGOSTUDIO_VITEST_ARGS).toBe(
      '--reporter=junit --outputFile=../../.mango/artifacts/junit/frontend-vitest.xml'
    );
  });

  it('switches Vitest to a blob report when sharded', () => {
    const env = testLaneEnv({ index: 3, count: 8 });
    expect(env.MANGOSTUDIO_BUN_TEST_ARGS).toBe('--shard=3/8');
    expect(env.MANGOSTUDIO_VITEST_ARGS).toBe(
      '--shard=3/8 --reporter=blob --outputFile=.vitest-reports/blob-3.json'
    );
    expect(env.MANGOSTUDIO_VITEST_ARGS).not.toContain('junit');
  });

  // Measured, not assumed: `--reporter=blob` leaves the thresholds on, so a
  // sharded run evaluates them against a fraction of the sources and fails on
  // every shard. The config drops them when this is set.
  it('signals the shard to the Vitest config so its thresholds stand down', () => {
    expect(testLaneEnv({ index: 3, count: 8 }).MANGOSTUDIO_TEST_SHARD).toBe('3/8');
  });
});

describe('frontend coverage thresholds', () => {
  it('are enforced unsharded and deferred to the merge when sharded', async () => {
    const config = await Bun.file(
      new URL('../../apps/frontend/vitest.config.ts', import.meta.url)
    ).text();
    expect(config).toContain('process.env.MANGOSTUDIO_TEST_SHARD');
    // The merge invocation is unsharded, so it is what applies them.
    const scripts = (await Bun.file(
      new URL('../../apps/frontend/package.json', import.meta.url)
    ).json()) as { scripts: Record<string, string> };
    expect(scripts.scripts['test:coverage:merge']).toContain('--mergeReports');
    expect(scripts.scripts['test:coverage:merge']).toContain('--coverage');
  });
});
