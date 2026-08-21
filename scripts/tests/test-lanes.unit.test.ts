import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
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

  // Same pinning as the JUnit paths above, for a stronger reason: the timings
  // file decides which files each shard runs, so a lane reading one path while
  // the merge step writes another balances against a file nothing updates —
  // and silently keeps the old split forever.
  it.each(TEST_LANES.filter((lane) => lane.timingsPath))(
    'the $id lane reads timings from where the lane table says it does',
    async (lane) => {
      const scripts = await readScripts(lane.manifest);
      const script = scripts[lane.coverageScript];
      const expected =
        lane.manifest === 'package.json' ? lane.timingsPath : `../../${lane.timingsPath}`;
      expect(script).toContain(`--timings=${expected}`);
      // Without this the shards read a timings file and never refresh it.
      expect(script).toContain('--update-timings');
    }
  );

  // The inverse direction: a lane that opts out must not carry the flags, or it
  // writes a slice the merge step then treats as authoritative for a lane it is
  // not balancing.
  it.each(TEST_LANES.filter((lane) => !lane.timingsPath))(
    'the $id lane passes no timings flags',
    async (lane) => {
      const scripts = await readScripts(lane.manifest);
      expect(scripts[lane.coverageScript]).not.toContain('--timings=');
      expect(scripts[lane.coverageScript]).not.toContain('--update-timings');
    }
  );

  // Turbo caches `//#test:scripts` and nothing else in the test lanes. A timings
  // file is untracked, so it cannot enter that cache key — balancing this lane
  // would let shard i restore a report built from a different file set. Worth
  // 0.6s; not worth that. Pinned so re-adding it is a deliberate act.
  it('the cached root lane opts out of timings', () => {
    expect(TEST_LANES.find((lane) => lane.id === 'root')?.timingsPath).toBeUndefined();
  });

  it('the Vitest lane declares no timings path', () => {
    const vitest = TEST_LANES.filter((lane) => lane.runner === 'vitest');
    expect(vitest.length).toBeGreaterThan(0);
    for (const lane of vitest) expect(lane.timingsPath).toBeUndefined();
  });

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
  // The reporter list mirrors `vitest.config.ts`'s own `GITHUB_ACTIONS` test,
  // so these have to pin the variable instead of inheriting the runner's:
  // otherwise the exact-string cases below pass locally and fail on CI, where
  // it is set. Restored afterwards because `bun test` shares one module graph
  // across files.
  const inherited = process.env.GITHUB_ACTIONS;
  const setGithubActions = (value: string | undefined): void => {
    if (value === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = value;
  };

  beforeEach(() => setGithubActions(undefined));
  afterAll(() => setGithubActions(inherited));

  it('writes JUnit directly when unsharded', () => {
    const env = testLaneEnv(null);
    expect(env.MANGOSTUDIO_TEST_SHARD).toBe('');
    expect(env.MANGOSTUDIO_BUN_TEST_ARGS).toBe('');
    expect(env.MANGOSTUDIO_VITEST_ARGS).toBe(
      '--reporter=default --reporter=junit --outputFile=../../.mango/artifacts/junit/frontend-vitest.xml'
    );
  });

  it('switches Vitest to a blob report when sharded', () => {
    const env = testLaneEnv({ index: 3, count: 8 });
    expect(env.MANGOSTUDIO_BUN_TEST_ARGS).toBe('--shard=3/8');
    expect(env.MANGOSTUDIO_VITEST_ARGS).toBe(
      '--shard=3/8 --reporter=default --reporter=blob --outputFile=.vitest-reports/blob-3.json'
    );
    expect(env.MANGOSTUDIO_VITEST_ARGS).not.toContain('junit');
  });

  // A CLI `--reporter` replaces `vitest.config.ts`'s `reporters` rather than
  // adding to it, so a file-only reporter set prints nothing — and the
  // `Errors N errors` line is the only place Vitest's unhandled errors ever
  // appear (its JUnit reporter hardcodes `errors="0"`).
  it('keeps the console reporter in both modes so unhandled errors reach the log', () => {
    expect(testLaneEnv(null).MANGOSTUDIO_VITEST_ARGS).toContain('--reporter=default');
    expect(testLaneEnv({ index: 3, count: 8 }).MANGOSTUDIO_VITEST_ARGS).toContain(
      '--reporter=default'
    );
  });

  // Same replacement rule, second casualty: the config adds `github-actions`
  // under CI, so omitting it here would drop every inline failure annotation
  // from the run — a regression the suite's own green counts cannot show.
  it('restores the CI annotation reporter the config would have added', () => {
    setGithubActions('true');
    expect(testLaneEnv(null).MANGOSTUDIO_VITEST_ARGS).toBe(
      '--reporter=default --reporter=github-actions --reporter=junit --outputFile=../../.mango/artifacts/junit/frontend-vitest.xml'
    );
    expect(testLaneEnv({ index: 3, count: 8 }).MANGOSTUDIO_VITEST_ARGS).toBe(
      '--shard=3/8 --reporter=default --reporter=github-actions --reporter=blob --outputFile=.vitest-reports/blob-3.json'
    );
  });

  // Measured, not assumed: `--reporter=blob` leaves the thresholds on, so a
  // sharded run evaluates them against a fraction of the sources and fails on
  // every shard. The config drops them when this is set.
  it('signals the shard to the Vitest config so its thresholds stand down', () => {
    expect(testLaneEnv({ index: 3, count: 8 }).MANGOSTUDIO_TEST_SHARD).toBe('3/8');
  });
});

describe('frontend coverage thresholds', () => {
  // The Vitest lane used to carry 70/60/64/72, standing them down under
  // `MANGOSTUDIO_TEST_SHARD` so only the unsharded merge decided them. Those
  // numbers were measured over the whole suite, and the suite has moved to
  // `bun test` — this lane now runs nothing, so a threshold on it would gate on
  // a coverage figure no file produces. Pinned as absent so re-adding one is a
  // deliberate act rather than a copy-paste.
  it('are no longer declared on the Vitest lane, which runs no files', async () => {
    const config = await Bun.file(
      new URL('../../apps/frontend/vitest.config.ts', import.meta.url)
    ).text();
    expect(config).toContain('thresholds: undefined');
    expect(config).not.toContain('process.env.MANGOSTUDIO_TEST_SHARD');
  });

  // The merge invocation stays wired even with nothing to merge: it is what
  // would apply thresholds again, and the Bun lane's own are re-derived
  // separately.
  it('leave the unsharded merge as the place they would be applied', async () => {
    const scripts = (await Bun.file(
      new URL('../../apps/frontend/package.json', import.meta.url)
    ).json()) as { scripts: Record<string, string> };
    expect(scripts.scripts['test:coverage:merge']).toContain('--mergeReports');
    expect(scripts.scripts['test:coverage:merge']).toContain('--coverage');
  });
});
