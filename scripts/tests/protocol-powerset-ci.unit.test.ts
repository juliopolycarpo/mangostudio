import { describe, expect, test } from 'bun:test';

import { evaluateGate, parseAllowedSkips } from '../ci/evaluate-gate';
import {
  type FeatureTable,
  partitionCoverage,
  partitionOfRun,
  powersetConfigurations,
} from './support/feature-powerset';
import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks, parseNeedsList } from './support/workflow-blocks';

// Protocol CI checks the mango-protocol feature powerset on three operating
// systems. It runs as two `cargo hack --partition M/2` legs of the `rust` job
// per system, and `Protocol CI / Gate` reads one `needs.rust.result` that is
// `success` only when every leg of the matrix ran and passed. What nothing at
// run time can notice is the matrix itself shrinking, or a flag narrowing the
// powerset; these tests are what notices.

// GitHub expression opener, assembled so biome's noTemplateCurlyInString does
// not read the literal as a template placeholder.
const EXPR = '$' + '{{';
const EXPR_PATTERN = '\\$\\{\\{';
const OPERATING_SYSTEMS = ['ubuntu-latest', 'macos-latest', 'windows-latest'] as const;
const WORKFLOW = '.github/workflows/protocol-ci.yml';

// The runs `cargo hack clippy -p mango-protocol --feature-powerset` printed
// under cargo-hack 0.6.45 (`--print-command-list`), in execution order, as the
// `--features` value of each (empty: `--no-default-features`). It is the one
// literal the model below is held to, so a new feature, or a model that no
// longer matches cargo-hack, fails here instead of thinning a partition.
const PINNED_RUNS = [
  '',
  'default,schema,spawn,testing,websocket',
  'default',
  'schema',
  'default,schema',
  'spawn',
  'default,spawn',
  'schema,spawn',
  'default,schema,spawn',
  'testing',
  'default,testing',
  'schema,testing',
  'default,schema,testing',
  'spawn,testing',
  'default,spawn,testing',
  'schema,spawn,testing',
  'default,schema,spawn,testing',
  'tokio',
  'default,tokio',
  'schema,tokio',
  'default,schema,tokio',
  'websocket',
  'default,websocket',
  'schema,websocket',
  'default,schema,websocket',
  'spawn,websocket',
  'default,spawn,websocket',
  'schema,spawn,websocket',
  'default,schema,spawn,websocket',
  'testing,websocket',
  'default,testing,websocket',
  'schema,testing,websocket',
  'default,schema,testing,websocket',
  'spawn,testing,websocket',
  'default,spawn,testing,websocket',
  'schema,spawn,testing,websocket',
] as const;

const POWERSET_COMMAND =
  'cargo hack clippy -p mango-protocol --feature-powerset --all-targets --locked --partition "$PARTITION" -- -D warnings';

const label = (run: string): string => (run === '' ? '(no features)' : run);

function protocolFeatures(): FeatureTable {
  const manifest = Bun.TOML.parse(readText('crates/mango-protocol/Cargo.toml')) as {
    features: FeatureTable;
  };
  return manifest.features;
}

/** The values of one matrix axis written as a flow list, e.g. `os: [a, b]`. */
function matrixAxis(job: string, axis: string): string[] {
  const list = new RegExp(`^ {8}${axis}: \\[([^\\]]*)\\]$`, 'm').exec(job)?.[1];
  return (list ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function powersetStep(job: string): string {
  return extractStepBlocks(job).find((step) => step.includes('cargo hack ')) ?? '';
}

/** The `N` of the step's `PARTITION: ${{ matrix.partition }}/N`, or 0 when it has none. */
function partitionCount(step: string): number {
  const count = new RegExp(`PARTITION: ${EXPR_PATTERN} matrix\\.partition \\}\\}/(\\d+)$`, 'm');
  return Number(count.exec(step)?.[1] ?? 0);
}

describe('the cargo-hack feature powerset the partitions split', () => {
  test('the model reproduces the configurations cargo-hack runs for mango-protocol', () => {
    const modelled = powersetConfigurations(protocolFeatures())
      .map((set) => set.join(','))
      .sort();

    expect(
      modelled.map(label),
      `expected powerset: ${PINNED_RUNS.length} configurations, as cargo-hack 0.6.45 runs them | received: ${modelled.length} (a feature was added or changed in crates/mango-protocol/Cargo.toml; re-derive PINNED_RUNS with cargo hack --print-command-list and check each partition still runs something)`
    ).toEqual([...PINNED_RUNS].sort().map(label));
    expect(PINNED_RUNS).toHaveLength(36);
  });

  test('chunks the runs the way cargo-hack numbers them', () => {
    // cargo-hack 0.6.45 `Progress::in_partition`: run / ceil(total / count).
    expect([0, 17, 18, 35].map((run) => partitionOfRun(run, 36, 2))).toEqual([0, 0, 1, 1]);
    expect(PINNED_RUNS.filter((_, run) => partitionOfRun(run, 36, 2) === 0)).toHaveLength(18);
    expect(PINNED_RUNS.filter((_, run) => partitionOfRun(run, 36, 2) === 1)).toHaveLength(18);
  });
});

describe('partition coverage model', () => {
  const runs = ['a', 'b', 'c', 'd'];

  test('accepts two partitions that together cover every run once', () => {
    expect(partitionCoverage(runs, 2, [1, 2])).toEqual({
      missing: [],
      duplicated: [],
      idle: [],
      invalid: [],
    });
  });

  test('names the runs a dropped partition leaves unchecked', () => {
    expect(partitionCoverage(runs, 2, [1]).missing).toEqual(['c', 'd']);
  });

  test('names the runs a partition listed twice checks twice', () => {
    expect(partitionCoverage(runs, 2, [1, 1, 2]).duplicated).toEqual(['a', 'b']);
  });

  test('flags a partition cargo-hack would accept and leave empty', () => {
    // 36 runs in 7 chunks of 6 leave the seventh chunk with nothing to run.
    const thirtySix = Array.from({ length: 36 }, (_, run) => `run-${run}`);
    expect(partitionCoverage(thirtySix, 7, [1, 2, 3, 4, 5, 6, 7]).idle).toEqual([7]);
  });

  test('flags a partition number outside 1..count', () => {
    expect(partitionCoverage(runs, 2, [0, 3]).invalid).toEqual([0, 3]);
  });
});

describe('Protocol CI feature-powerset partitions', () => {
  const workflow = readText(WORKFLOW);
  const rust = extractJobBlock(workflow, 'rust');
  const step = powersetStep(rust);
  const partitions = matrixAxis(rust, 'partition').map(Number);

  test('the rust job exists and fans out over operating system and partition', () => {
    expect(rust, 'expected job "rust" in protocol-ci.yml | received: none').not.toBe('');
    const systems = matrixAxis(rust, 'os');
    expect(
      systems,
      `expected rust matrix os: ${OPERATING_SYSTEMS.join(', ')} | received: ${systems.join(', ') || 'none'}`
    ).toEqual([...OPERATING_SYSTEMS]);
    expect(
      partitions,
      `expected rust matrix partition: 1, 2 | received: ${partitions.join(', ') || 'no partition axis (one unpartitioned powerset run)'}`
    ).toEqual([1, 2]);
  });

  test('no matrix leg is dropped by include, exclude or a tolerated failure', () => {
    expect(rust, 'expected rust matrix without exclude').not.toMatch(/^\s+exclude:/m);
    expect(rust, 'expected rust matrix without include').not.toMatch(/^\s+include:/m);
    // A job-level `continue-on-error` reports `success` for a failed leg.
    expect(rust, 'expected rust job without continue-on-error').not.toContain('continue-on-error');
    expect(rust).toContain('fail-fast: false');
  });

  test('every operating system runs every partition', () => {
    const legs = matrixAxis(rust, 'os').flatMap((os) =>
      partitions.map((partition) => `${os} partition ${partition}/${partitionCount(step)}`)
    );
    const expected = OPERATING_SYSTEMS.flatMap((os) =>
      [1, 2].map((partition) => `${os} partition ${partition}/2`)
    );

    expect(
      expected.filter((leg) => !legs.includes(leg)),
      `expected legs: ${expected.join(' | ')} | received: ${legs.join(' | ') || 'none'}`
    ).toEqual([]);
  });

  test('the powerset step runs one pinned command whose partition comes from the matrix', () => {
    const run = /^\s+(?:- )?run: (.*)$/m.exec(step)?.[1];

    expect(
      run,
      `expected command: ${POWERSET_COMMAND} | received: ${run ?? 'no cargo hack step'}`
    ).toBe(POWERSET_COMMAND);
    // Reached through env so the value is data, never script text, and through
    // bash so `"$PARTITION"` means the same on the Windows runner.
    expect(step).toContain('shell: bash');
    expect(
      partitionCount(step),
      `expected PARTITION: ${EXPR} matrix.partition }}/${partitions.length}, one count for ${partitions.length} matrix partitions | received count: ${partitionCount(step) || 'no PARTITION env'}`
    ).toBe(partitions.length);
  });

  test('together the partitions run every configuration exactly once', () => {
    const count = partitionCount(step);
    const unpartitioned = count === 0 || partitions.length === 0;
    const coverage = partitionCoverage(PINNED_RUNS.map(label), count, partitions);
    const problems = unpartitioned
      ? [`no --partition M/N: ${PINNED_RUNS.length} configurations run in one unsplit step`]
      : [
          ...coverage.missing.map((run) => `${run} runs in no partition`),
          ...coverage.duplicated.map((run) => `${run} runs in more than one partition`),
          ...coverage.idle.map((partition) => `partition ${partition}/${count} runs nothing`),
          ...coverage.invalid.map((partition) => `partition ${partition} is outside 1..${count}`),
        ];

    expect(
      problems,
      `expected all ${PINNED_RUNS.length} configurations in exactly one of 2 partitions | received: ${problems.join('; ')}`
    ).toEqual([]);
  });

  test('doctests and docs run once per operating system, not once per partition', () => {
    const repeated = extractStepBlocks(rust).filter(
      (candidate) =>
        /cargo (test -p mango-protocol --doc|doc -p mango-protocol)/.test(candidate) &&
        !/matrix\.partition == \d+/.test(candidate)
    );

    const names = repeated.map((candidate) => /name: (.*)/.exec(candidate)?.[1] ?? 'unnamed step');
    expect(
      names,
      `expected doctests and docs gated to one partition (matrix.partition == N) | received on every partition: ${names.join(', ')}`
    ).toEqual([]);
  });
});

describe('Protocol CI / Gate and the partitioned job', () => {
  const workflow = readText(WORKFLOW);
  const gate = extractJobBlock(workflow, 'gate');
  const needs = parseNeedsList(gate);
  const partitionedJobs = ['rust'];

  test('requires every partitioned job, naming the one it lost', () => {
    const missing = partitionedJobs.filter((job) => !needs.includes(job));

    expect(
      missing,
      `expected Protocol CI Gate to require job "${missing.join('", "')}" (feature-powerset partitions 1/2 and 2/2 on every system) | received needs: ${needs.join(', ')}`
    ).toEqual([]);
  });

  test('a skipped, cancelled or failed partitioned job fails the Gate when protocol paths changed', () => {
    // `protocol == 'true'` leaves ALLOWED_SKIPS empty, so nothing may skip.
    const accepted = parseAllowedSkips('');
    for (const result of ['skipped', 'cancelled', 'failure'] as const) {
      const results = Object.fromEntries(needs.map((job) => [job, 'success' as const]));
      const verdict = evaluateGate({ ...results, rust: result }, accepted);

      expect(verdict.ok, `expected Gate to fail with rust: ${result} | received: pass`).toBe(false);
      expect(verdict.lines.join('\n')).toContain(`rust: ${result}`);
    }
  });

  test('accepts the partitioned job as skipped only when no protocol path changed', () => {
    const skips = new RegExp(
      `ALLOWED_SKIPS: ${EXPR_PATTERN} needs\\.changes\\.outputs\\.protocol == 'false' && '([^']*)' \\|\\| '' \\}\\}`
    ).exec(gate)?.[1];

    expect(
      skips,
      'expected ALLOWED_SKIPS guarded by protocol == false | received: none'
    ).toBeDefined();
    const accepted = (skips ?? '').split(' ').sort();
    const expected = needs.filter((job) => job !== 'changes').sort();
    expect(
      accepted,
      `expected every lane in the protocol == false skip list, rust included | received: ${accepted.join(' ')}`
    ).toEqual(expected);
    expect(
      extractJobBlock(workflow, 'rust'),
      "expected rust to run only under if: needs.changes.outputs.protocol == 'true'"
    ).toContain("if: needs.changes.outputs.protocol == 'true'");
  });
});
