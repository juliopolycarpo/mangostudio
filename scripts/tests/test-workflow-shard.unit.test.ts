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
    expect(block).toContain('apps/frontend/.vitest-reports/');
    expect(block).toContain('shard-meta.json');
    expect(block).toContain('vitest-errors.json');
  });

  test('the upload keeps dot-directories', () => {
    // Observed on a real run: at the default, `.vitest-reports` is dropped from
    // the artifact and the upload still reports success, so the failure only
    // appears in the merge job.
    expect(extractJobBlock(workflow, 'shard')).toContain('include-hidden-files: true');
  });

  test('only the first shard writes the shared caches', () => {
    // All eight resolve the same primary key; letting each save turns seven
    // post-job steps into "cache already exists" warnings that read as a fault.
    const saves = [...extractJobBlock(workflow, 'shard').matchAll(/mode: .*matrix\.shard == 1/g)];
    expect(saves).toHaveLength(2);
  });
});

describe('Test workflow merge job', () => {
  const merge = extractJobBlock(workflow, 'merge');

  test('waits for every shard and still runs when one failed', () => {
    expect(parseNeedsList(merge)).toEqual(['shard']);
    expect(merge).toContain(NOT_CANCELLED);
  });

  test('collects every shard artifact rather than a fixed list', () => {
    expect(merge).toContain('pattern: test-shard-*');
  });

  test('the Vitest merge is a hard gate, because it is where thresholds apply', () => {
    // Sharded Vitest runs emit blob reports and skip their own thresholds, so
    // a continue-on-error here would drop coverage enforcement entirely.
    const stepIndex = merge.indexOf('test:coverage:merge');
    expect(stepIndex).toBeGreaterThan(-1);
    expect(merge.slice(0, stepIndex)).not.toContain('continue-on-error');
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
  test('declares exactly the shard and merge jobs', () => {
    expect(extractJobBlocks(workflow).map(({ job }) => job)).toEqual(['shard', 'merge']);
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
