import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractStepBlocks,
  parseNeedsList,
} from './support/workflow-blocks';

// The sharded Test workflow has one failure mode that is silent by
// construction: a run that covers a fraction of the files and exits 0. Every
// assertion here guards a way in.

const workflow = readText('.github/workflows/test.yml');

// Placeholder openers assembled out of band so the literal never appears in a
// plain string — Bun's no-template-curly-in-string flags those. Same trick as
// ci-gate.unit.test.ts.
const EXPR = `$${'{{'}`;
const SHELL = `$${'{'}`;
const NOT_CANCELLED = `if: ${EXPR} !cancelled() }}`;
const TIMINGS_SNAPSHOT = `test-timings-baseline-${EXPR} github.run_attempt }}`;

// Preserve the setup/report reserve across two bounded attempts; see the
// dated healthy-step qualification in docs/reference/testing.md.
const OTHER_STEPS_SECONDS = 120;

describe('reruns replace previous test evidence', () => {
  test.each([
    [
      '.github/workflows/test.yml',
      [
        `test-shard-${EXPR} matrix.shard }}`,
        `test-shard-${EXPR} matrix.shard }}-log`,
        'test-shard-frontend',
        'test-shard-frontend-log',
        'qa-test-metrics',
        'coverage',
      ],
    ],
    ['.github/workflows/qa-metrics.yml', ['qa-collector-timings', 'qa-metrics']],
    ['.github/workflows/rust-coverage.yml', ['qa-rust-coverage']],
  ] as const)('%s replaces artifacts with the same name before uploading', (path, names) => {
    const uploads = extractJobBlocks(readText(path))
      .flatMap(({ block }) => extractStepBlocks(block))
      .filter(
        (step) =>
          step.includes('uses: actions/upload-artifact@') &&
          !step.includes(`name: ${TIMINGS_SNAPSHOT}`)
      );
    expect(uploads.map((step) => /^ {10}name: (.+)$/m.exec(step)?.[1])).toEqual([...names]);
    // A failed-job rerun can otherwise leave duplicate names and the merger
    // can download the earlier failed receipt even after the shard passed.
    for (const step of uploads) expect(step).toContain('          overwrite: true\n');
  });
});

describe('test artifacts used by targeted reruns', () => {
  test.each([
    ['resolve-timings', TIMINGS_SNAPSHOT],
    ['shard', `test-shard-${EXPR} matrix.shard }}`],
    ['frontend', 'test-shard-frontend'],
  ])('%s retains %s for the GitHub rerun window', (job, artifact) => {
    const upload = extractStepBlocks(extractJobBlock(workflow, job)).find(
      (step) =>
        step.includes('uses: actions/upload-artifact@') &&
        step.includes(`          name: ${artifact}\n`)
    );
    expect(upload).toBeDefined();
    const retentionDays = Number(/^ {10}retention-days: (\d+)$/m.exec(upload ?? '')?.[1]);
    expect(
      retentionDays,
      `expected ${artifact} retention of at least 30 days | received: ${retentionDays}`
    ).toBeGreaterThanOrEqual(30);
  });
});

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

  test('the job name reports the declared shard count', () => {
    // Compared as one line, so a drifted denominator fails on the name alone
    // instead of printing the whole job block.
    const name = /^ {4}name: (.+)$/m.exec(extractJobBlock(workflow, 'shard'))?.[1];
    const expected = `Tests (shard ${EXPR} matrix.shard }}/${shardCount()})`;
    expect(name, `expected shard job name: ${expected} | received: ${name}`).toBe(expected);
  });

  test('each shard runs its own slice of the coverage lane', () => {
    expect(extractJobBlock(workflow, 'shard')).toContain(
      `bun run test --coverage --shard="${SHELL}SHARD}/${SHELL}SHARD_COUNT}"`
    );
  });

  test('both watchdog attempts fit inside the shard job timeout', () => {
    // The watchdog retries a hung attempt once. If two full attempts plus the
    // job's other steps overrun `timeout-minutes`, the runner kills the retry
    // and the job goes red for a hang the retry would have absorbed.
    const job = extractJobBlock(workflow, 'shard');
    const jobSeconds = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(job)?.[1]) * 60;
    const attemptSeconds = Number(/--timeout-seconds=(\d+)/.exec(job)?.[1]);
    const required = attemptSeconds * 2 + OTHER_STEPS_SECONDS;

    expect(
      jobSeconds,
      `expected shard job timeout: at least ${required}s (2 x ${attemptSeconds}s watchdog attempts + ${OTHER_STEPS_SECONDS}s other steps) | received: ${jobSeconds}s`
    ).toBeGreaterThanOrEqual(required);
  });

  test('the watchdog allows twice the current healthy numbered-shard step', () => {
    // The healthy retry in CI 41961144859 took 238s on 2026-11-05.
    const healthyStepSeconds = 238;
    const job = extractJobBlock(workflow, 'shard');
    const attemptSeconds = Number(/--timeout-seconds=(\d+)/.exec(job)?.[1]);
    expect(
      attemptSeconds,
      `expected shard watchdog: at least ${healthyStepSeconds * 2}s for the measured healthy step | received: ${attemptSeconds}s`
    ).toBeGreaterThanOrEqual(healthyStepSeconds * 2);
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
    // Every shard restores, so a save in each would upload duplicate copies of one
    // snapshot, keyed apart only by the run.
    const turboSteps = extractStepBlocks(extractJobBlock(workflow, 'shard')).filter((step) =>
      step.includes('family: turbo')
    );
    const saves = turboSteps.filter((step) => /^\s+mode: save$/m.test(step));
    expect(saves, `expected one turbo save step | received: ${saves.length}`).toHaveLength(1);
    expect(saves[0]).toMatch(/if: success\(\) && matrix\.shard == 1/);
    expect(turboSteps.filter((step) => !saves.includes(step))).toSatisfy((rest: string[]) =>
      rest.every((step) => /^\s+mode: restore$/m.test(step))
    );
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

  test('restores no turbo cache, because nothing it runs can hit one', () => {
    // `--only=frontend` skips the root scripts lane, and `//#test:scripts` is
    // the one task turbo caches; the `test:coverage` this job does run is
    // `cache: false` with no `dependsOn`. A restore here only ever downloaded
    // and extracted the shards' archive in front of an uncached run — a real
    // cost, and one that reads like working cache reuse in the job log.
    expect(frontend).not.toContain('family: turbo');
    expect(frontend).not.toContain('.turbo/cache');
  });

  test('uploads the same artifact shape as a shard, dot-directories included', () => {
    expect(frontend).toContain('name: test-shard-frontend');
    expect(frontend).toContain('include-hidden-files: true');
    expect(frontend).toContain('shard-meta.json');
    expect(frontend).toContain('unhandled-errors.json');
    expect(frontend).toContain(`${NOT_CANCELLED}`);
  });
});

describe('shared test timings', () => {
  test('uploads one immutable snapshot on cache hits and cold runs', () => {
    const resolver = extractJobBlock(workflow, 'resolve-timings');
    expect(resolver).toContain(`artifact: ${TIMINGS_SNAPSHOT}`);
    expect(resolver).toContain(
      `"${SHELL}TIMINGS_KEY:-cold}" > .mango/artifacts/timings/source-key.txt`
    );
    const snapshot = extractStepBlocks(resolver).find((step) =>
      step.includes('uses: actions/upload-artifact@')
    );
    expect(snapshot).toContain(`name: ${TIMINGS_SNAPSHOT}`);
    expect(snapshot).toContain('path: .mango/artifacts/timings');
    expect(snapshot).toContain('if-no-files-found: error');
    expect(snapshot).not.toContain('overwrite: true');
    expect(snapshot).not.toMatch(/^\s+if:/m);
  });

  test.each(['shard', 'frontend'])('%s downloads the resolver snapshot before tests', (job) => {
    const block = extractJobBlock(workflow, job);
    expect(parseNeedsList(block)).toEqual(['resolve-timings']);
    const steps = extractStepBlocks(block);
    const download = steps.findIndex((step) =>
      step.includes(`name: ${EXPR} needs.resolve-timings.outputs.artifact }}`)
    );
    const tests = steps.findIndex((step) => step.includes('run-tests-watchdog.ts'));
    expect(download, `expected a timings download in ${job}`).toBeGreaterThanOrEqual(0);
    expect(tests, `expected the watchdog after the timings download in ${job}`).toBeGreaterThan(
      download
    );
    expect(steps[download]).toContain('uses: actions/download-artifact@');
    expect(steps[download]).toContain('path: .mango/artifacts/timings');
    expect(steps[download]).not.toMatch(/^\s+if:/m);
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

  test('passes the plain shard count to the merge', () => {
    // A job that dies before uploading leaves its directory missing, not
    // empty; without the count the merge would report a green run over a
    // partial artifact set. The script itself adds one directory per
    // unsharded lane from the registry, so the workflow passes the raw count.
    expect(merge).toContain('merge-test-shards.ts shards "$SHARD_COUNT"');
  });

  test('passes the shard count to the test-metrics collector', () => {
    // The collector derives the expected job set from the count. Without it a
    // shard that never uploaded is invisible and its lanes would read as a
    // smaller, complete total instead of `partial`.
    expect(merge).toContain(
      'collect-test-metrics.ts shard-summary.json shards "$SHARD_COUNT" > test-metrics.json'
    );
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
  // The merge job counts one artifact per unsharded lane, so a job that uploads
  // a `test-shard-*` artifact is not free to appear here — which is what makes
  // the exact list worth pinning.
  test('declares exactly the jobs the merge job knows how to account for', () => {
    expect(extractJobBlocks(workflow).map(({ job }) => job)).toEqual([
      'resolve-timings',
      'shard',
      'frontend',
      'merge',
    ]);
  });

  // The Windows slot paths (the `current` shim, its rollback, the stage sweep,
  // and owner-only credentials across a rotation) are the Rust runtime's
  // `#[cfg(windows)]` tests now. They run in cargo-shim.yml's workspace
  // matrix, so that matrix, not this workflow, is what must keep Windows.
  test('leaves the Windows runtime slot tests to the cargo workspace matrix', () => {
    const cargo = extractJobBlock(readText('.github/workflows/cargo-shim.yml'), 'workspace');
    expect(cargo).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(cargo).toContain(
      'cargo nextest run --workspace --all-targets --all-features --locked --retries 0'
    );
    expect(workflow).not.toContain('windows-latest');
  });

  // ci.yml calls this as one `test` job, so the aggregate gate's `needs` list
  // is unchanged by the fan-out. Adding a third job here is fine; adding one to
  // ci.yml is what ci-gate.unit.test.ts guards.
  test('ci.yml still depends on a single test job', () => {
    const ci = readText('.github/workflows/ci.yml');
    expect(extractJobBlock(ci, 'test')).toContain('uses: $/.github/workflows/test.yml');
    expect(parseNeedsList(extractJobBlock(ci, 'gate-unique'))).toContain('test');
  });
});
