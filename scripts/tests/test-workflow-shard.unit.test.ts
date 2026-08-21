import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractJobBlock, extractJobBlocks, parseNeedsList } from './support/workflow-blocks';

// The sharded Test workflow has one failure mode that is silent by
// construction: a run that covers a fraction of the files and exits 0. Every
// assertion here guards a way in.

const workflow = readText('.github/workflows/test.yml');

// Placeholder openers assembled out of band so the literal never appears in a
// plain string — biome's noTemplateCurlyInString flags those. Same trick as
// ci-gate.unit.test.ts.
const EXPR = `$${'{{'}`;
const SHELL = `$${'{'}`;
const NOT_CANCELLED = `if: ${EXPR} !cancelled() }}`;

const shardCount = (): number => {
  const declared = /^ {2}SHARD_COUNT: (\d+)$/m.exec(workflow)?.[1];
  expect(declared).toBeDefined();
  return Number(declared);
};

describe('Test workflow shard matrix', () => {
  test('the matrix lists exactly SHARD_COUNT shards, numbered from one', () => {
    const listed = /^ {8}shard: \[([\d, ]+)\]$/m
      .exec(extractJobBlock(workflow, 'shard'))?.[1]
      ?.split(',')
      .map((value) => Number(value.trim()));

    // A matrix shorter than SHARD_COUNT never runs the last shards' files and
    // still exits 0; longer, and `--shard=9/8` is rejected at parse time.
    expect(listed).toEqual(Array.from({ length: shardCount() }, (_, index) => index + 1));
  });

  test('each shard runs its own slice of the coverage lane', () => {
    expect(extractJobBlock(workflow, 'shard')).toContain(
      `bun run test --coverage --shard="${SHELL}SHARD}/${SHELL}SHARD_COUNT}"`
    );
  });

  test('a failing shard does not cancel the others', () => {
    // fail-fast would leave the merge job counting a partial fan-out and
    // reporting it as the suite's totals.
    expect(extractJobBlock(workflow, 'shard')).toContain('fail-fast: false');
  });

  test('every shard uploads its results, including when it failed', () => {
    const block = extractJobBlock(workflow, 'shard');
    expect(block).toContain(`name: test-shard-${EXPR} matrix.shard }}`);
    expect(block).toContain('.mango/artifacts/junit/');
    expect(block).toContain('.mango/artifacts/coverage/');
    expect(block).toContain('shard-meta.json');
    expect(block).toContain('unhandled-errors.json');
  });

  test('the upload keeps dot-directories', () => {
    // Observed on a real run: at the default, dot-directories like `.mango`
    // are dropped from the artifact and the upload still reports success, so
    // the failure only appears in the merge job.
    expect(extractJobBlock(workflow, 'shard')).toContain('include-hidden-files: true');
  });

  test('only the first shard writes the shared turbo cache', () => {
    // All eight resolve the same primary key; letting each save turns seven
    // post-job steps into "cache already exists" warnings that read as a fault.
    // The frontend job restores the same key and must not save either.
    const saves = [...extractJobBlock(workflow, 'shard').matchAll(/mode: .*matrix\.shard == 1/g)];
    expect(saves).toHaveLength(1);
    expect(extractJobBlock(workflow, 'frontend')).toContain('mode: restore\n');
  });
});

describe('Test workflow frontend job', () => {
  const frontend = extractJobBlock(workflow, 'frontend');

  test('runs the whole frontend lane, never a shard of it', () => {
    // Bun's LCOV is not union-mergeable, so a `--shard` reaching this lane
    // would silently turn a fraction of the suite into "the" frontend
    // coverage. The lane's own scripts refuse the shard variable
    // (test-lanes.unit.test.ts); this pins the workflow half.
    expect(frontend).toContain('bun run test --coverage --only=frontend');
    expect(frontend).not.toContain('--shard');
  });

  test('uploads the same artifact shape as a shard, dot-directories included', () => {
    expect(frontend).toContain('name: test-shard-frontend');
    expect(frontend).toContain('include-hidden-files: true');
    expect(frontend).toContain('shard-meta.json');
    expect(frontend).toContain('unhandled-errors.json');
    expect(frontend).toContain(`${NOT_CANCELLED}`);
  });

  test('restores the same pinned timings key the shards read', () => {
    // `--timings` balances the in-process `--parallel` workers; reading the
    // key resolve-timings pinned keeps this job off the live-prefix race the
    // shards were moved off of.
    expect(parseNeedsList(frontend)).toEqual(['resolve-timings']);
    expect(frontend).toContain('mode: restore-exact');
  });
});

describe('Test workflow merge job', () => {
  const merge = extractJobBlock(workflow, 'merge');

  test('waits for every test job and still runs when one failed', () => {
    expect(parseNeedsList(merge)).toEqual(['shard', 'frontend']);
    expect(merge).toContain(NOT_CANCELLED);
  });

  test('collects every test-job artifact rather than a fixed list', () => {
    // `test-shard-*` also matches the frontend job's `test-shard-frontend`.
    expect(merge).toContain('pattern: test-shard-*');
  });

  test('expects the shard count plus the frontend job', () => {
    // A job that dies before uploading leaves its directory missing, not
    // empty; without the count the merge would report a green run over a
    // partial artifact set.
    expect(merge).toContain('merge-test-shards.ts shards "$((SHARD_COUNT + 1))"');
  });

  test('the coverage diagnostics upload keeps dot-directories', () => {
    // `.mango` is a dot-directory too, so this hits the same trap as the shard
    // upload: an empty artifact that reports success, exactly when someone is
    // trying to diagnose the red run that produced it.
    const at = merge.indexOf('name: coverage');
    expect(at).toBeGreaterThan(-1);
    expect(merge.slice(at)).toContain('include-hidden-files: true');
  });

  test('reporting steps survive a failing gate so the QA report still renders', () => {
    for (const step of ['collect-test-metrics.ts', 'name: qa-test-metrics']) {
      const at = merge.indexOf(step);
      expect(merge.lastIndexOf(NOT_CANCELLED, at)).toBeGreaterThan(-1);
    }
  });

  test('publishes the fragment name the qa-metrics workflow downloads', () => {
    expect(merge).toContain('name: qa-test-metrics');
    expect(readText('.github/workflows/qa-metrics.yml')).toContain('name: qa-test-metrics');
  });
});

describe('Test workflow shape', () => {
  test('declares exactly the resolve-timings, shard, frontend, and merge jobs', () => {
    expect(extractJobBlocks(workflow).map(({ job }) => job)).toEqual([
      'resolve-timings',
      'shard',
      'frontend',
      'merge',
    ]);
  });

  // ci.yml calls this as one `test` job, so the aggregate gate's `needs` list
  // is unchanged by the fan-out. Adding a third job here is fine; adding one to
  // ci.yml is what ci-gate.unit.test.ts guards.
  test('ci.yml still depends on a single test job', () => {
    const ci = readText('.github/workflows/ci.yml');
    expect(extractJobBlock(ci, 'test')).toContain('uses: ./.github/workflows/test.yml');
    expect(parseNeedsList(extractJobBlock(ci, 'gate'))).toContain('test');
  });
});
