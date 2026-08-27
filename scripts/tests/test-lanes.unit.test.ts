import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { ALL_WORKSPACE_NAMES, ROOT_DIR } from '../lib/config';
import { parseShard, shardedCoverageWorkspaces, testLaneEnv } from '../lib/test';
import { laneById, SHARDED_LCOV_PATHS, TEST_LANES } from '../lib/test-lanes';

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
  it.each([...TEST_LANES])(
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

  // Same pinning as the JUnit paths above, for a stronger reason: for sharded
  // lanes the timings file decides which files each shard runs, so a lane
  // reading one path while the merge step writes another balances against a
  // file nothing updates — and silently keeps the old split forever.
  it.each(TEST_LANES.filter((lane) => lane.timingsPath))(
    'the $id lane reads timings from where the lane table says it does',
    async (lane) => {
      const scripts = await readScripts(lane.manifest);
      const script = scripts[lane.coverageScript];
      const expected =
        lane.manifest === 'package.json' ? lane.timingsPath : `../../${lane.timingsPath}`;
      expect(script).toContain(`--timings=${expected}`);
      // Without this the lanes read a timings file and never refresh it.
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
    expect(laneById('root').timingsPath).toBeUndefined();
  });

  it('every sharded lane takes the shard argument', async () => {
    for (const lane of TEST_LANES.filter((candidate) => candidate.sharded)) {
      const scripts = await readScripts(lane.manifest);
      expect(scripts[lane.coverageScript]).toContain('$MANGOSTUDIO_BUN_TEST_ARGS');
    }
  });

  // An unsharded lane must not even reference the shard variable: its LCOV is
  // whole-run coverage, and a `--shard` leaking in would make the merge treat a
  // fraction of the suite as the whole lane — every job still exiting 0.
  it.each(TEST_LANES.filter((lane) => !lane.sharded))(
    'the unsharded $id lane cannot receive a shard argument',
    async (lane) => {
      const scripts = await readScripts(lane.manifest);
      expect(scripts[lane.coverageScript]).not.toContain('$MANGOSTUDIO_BUN_TEST_ARGS');
      expect(scripts[lane.coverageScript]).not.toContain('--shard');
    }
  );

  // Keyed by workspace, not lane: the api workspace is two lanes whose LCOV
  // slices its own `test:coverage` script merges into the one staged file.
  it('covers every workspace in the staged-LCOV table', () => {
    const workspaces = new Set(
      TEST_LANES.filter((lane) => lane.workspace !== 'root').map((lane) => lane.workspace)
    );
    expect(new Set(Object.keys(SHARDED_LCOV_PATHS))).toEqual(workspaces);
  });

  it('has one lane per workspace plus root, with unique JUnit paths', () => {
    const covered = new Set(TEST_LANES.map((lane) => lane.workspace));
    expect(covered).toEqual(new Set(['root', ...ALL_WORKSPACE_NAMES]));
    expect(new Set(TEST_LANES.map((lane) => lane.junitPath)).size).toBe(TEST_LANES.length);
  });

  // `coverageThresholds` reads as per-lane infrastructure, but nothing in the
  // registry enforces it — the gate is a `&&` appended to one workspace's
  // coverage script. Declaring floors on a second lane without chaining the
  // enforcer there would be a gate that never runs, and every gate stays green
  // while it does not run. Iterated over the registry rather than pinned to
  // `frontend` so the declaration and the wiring cannot drift apart.
  //
  // Sharded lanes cannot be wired this way at all: each shard's LCOV is
  // partial, so a per-package chain would fail every run. Their floors belong
  // in the merge job, so a declaration here is asserted to be an error.
  it.each(TEST_LANES.filter((lane) => lane.coverageThresholds))(
    'the $id lane chains enforcement of the floors it declares',
    async (lane) => {
      expect(lane.sharded).toBe(false);
      const scripts = await readScripts(lane.manifest);
      expect(scripts[lane.coverageScript]).toContain(
        `bun ../../scripts/qa-gate/enforce-coverage-thresholds.ts ${lane.id}`
      );
    }
  );
});

describe('api lanes', () => {
  // The two api suites need opposite isolation settings, which is why the
  // workspace is two lanes at all. Unit without isolation is 172 failures
  // (measured on 1.4.0); integration inside Bun's isolate machinery is the
  // intermittent runner hang (oven-sh/bun#39709) that burned CI's
  // timeout-minutes. Pin both directions so neither flag drifts onto the
  // other lane.
  it('keeps the unit lane isolated and never --no-isolate', async () => {
    const scripts = await readScripts(laneById('api-unit').manifest);
    const script = scripts[laneById('api-unit').coverageScript];
    expect(script).toContain('--parallel=1');
    expect(script).not.toContain('--no-isolate');
    expect(script).toContain('tests/unit');
    expect(script).not.toContain('tests/integration');
  });

  it('keeps the integration lane out of isolate mode', async () => {
    const scripts = await readScripts(laneById('api-integration').manifest);
    const script = scripts[laneById('api-integration').coverageScript];
    expect(script).not.toContain('--parallel');
    expect(script).not.toContain('--isolate');
    expect(script).toContain('tests/integration');
    expect(script).not.toContain('tests/unit');
  });

  // Each lane writes its own slice; the orchestrating script must merge them
  // into the one per-workspace file every coverage reader (and the shard
  // upload) expects, or api coverage silently becomes integration-only.
  it('merges both LCOV slices into the staged api file', async () => {
    const scripts = await readScripts('apps/api/package.json');
    const script = scripts['test:coverage'];
    expect(script).toContain('merge-lcov-shards.ts');
    expect(script).toContain(`../../${SHARDED_LCOV_PATHS.api}`);
    expect(script).toContain('coverage/api-unit/lcov.info');
    expect(script).toContain('coverage/api-integration/lcov.info');
  });

  it('gives each lane its own coverage directory', async () => {
    const scripts = await readScripts('apps/api/package.json');
    expect(scripts['test:coverage:unit']).toContain(
      '--coverage-dir=../../.mango/artifacts/coverage/api-unit'
    );
    expect(scripts['test:coverage:integration']).toContain(
      '--coverage-dir=../../.mango/artifacts/coverage/api-integration'
    );
  });
});

describe('frontend lane', () => {
  const frontend = laneById('frontend');

  // `mock.module` leaks across files without isolation (measured on 1.4.0), so
  // the flag is load-bearing, and `--no-isolate` would quietly re-share the
  // module graph even under `--parallel`.
  it('runs isolated, never --no-isolate', async () => {
    const scripts = await readScripts(frontend.manifest);
    for (const key of ['test', 'test:unit', 'test:integration', 'test:coverage']) {
      expect(scripts[key]).not.toContain('--no-isolate');
    }
    expect(scripts['test:coverage']).toContain('--isolate');
    expect(scripts['test:coverage']).toContain('--parallel=4');
  });

  // Resolver-level aliases (motion/react, the auth-client stub) live in
  // tsconfig.test.json and only reach `bun test` through this flag —
  // `bunfig.toml`'s `[test] tsconfig` key is accepted and silently ignored, so
  // without the flag the suite runs green against the real modules.
  it('every bun test script carries the tsconfig override', async () => {
    const scripts = await readScripts(frontend.manifest);
    for (const key of ['test:unit', 'test:integration', 'test:coverage']) {
      expect(scripts[key]).toContain('--tsconfig-override=./tsconfig.test.json');
    }
  });

  // The floors were measured on the full suite (82.35 / 77.53 / 82.39 / 54.45
  // on 2026-08-21) and set ~1pt under; their *presence* is what this pins —
  // the frontend went gateless between the istanbul thresholds' deletion and
  // this lane, and nothing else fails when someone deletes the numbers.
  // The wiring is pinned for every lane that declares floors, in the registry
  // suite above; this pins that the frontend is one of them.
  it('declares total-coverage floors', () => {
    const thresholds = frontend.coverageThresholds;
    expect(thresholds).toBeDefined();
    for (const metric of ['lines', 'functions', 'statements', 'branches'] as const) {
      expect(thresholds?.[metric]).toBeGreaterThan(0);
      expect(thresholds?.[metric]).toBeLessThan(100);
    }
  });

  // Bun 1.4.0's own `coverageThreshold` is enforced per *file* — any workspace
  // with a legitimately uncovered file fails every positive value — and a miss
  // prints nothing. Pinned as absent so re-adding it is a deliberate act, not a
  // copy-paste from Bun's docs.
  it('keeps the per-file bunfig threshold out of the config', async () => {
    const bunfig = await Bun.file(join(ROOT_DIR, 'apps/frontend/bunfig.toml')).text();
    // The comment in the file may (and does) explain the trap by name; only an
    // uncommented assignment re-arms it.
    expect(bunfig).not.toMatch(/^\s*coverageThreshold/m);
    // The gate reads the LCOV back, so the reporter must keep writing it.
    expect(bunfig).toContain('"lcov"');
  });

  // The Vitest lane is retired; a script that resurrects the runner would run
  // zero files (or the whole suite twice) without any other gate noticing.
  it('has no script that invokes vitest', async () => {
    const scripts = await readScripts(frontend.manifest);
    for (const [key, script] of Object.entries(scripts)) {
      expect(script, key).not.toContain('vitest');
    }
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
  it('passes no shard flag when unsharded', () => {
    expect(testLaneEnv(null)).toEqual({ MANGOSTUDIO_BUN_TEST_ARGS: '' });
  });

  it('passes the shard flag to the sharded lanes', () => {
    expect(testLaneEnv({ index: 3, count: 8 })).toEqual({
      MANGOSTUDIO_BUN_TEST_ARGS: '--shard=3/8',
    });
  });
});

describe('shardedCoverageWorkspaces', () => {
  // The frontend must never enter a sharded coverage fan-out: its LCOV cannot
  // be reassembled from slices, so a shard flag reaching it silently turns a
  // fraction of the suite into "the" frontend coverage.
  it('excludes the unsharded frontend and keeps every sharded workspace', () => {
    expect(shardedCoverageWorkspaces().sort()).toEqual(['api', 'runtime', 'shared']);
  });
});
