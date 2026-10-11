import { describe, expect, test } from 'bun:test';

import { ROOT_DIR } from '../lib/config';
import { API_DIR, discoverQualificationTests, type QualificationSuites } from '../lib/rust-lanes';
import { TEST_LANES, type TestLane } from '../lib/test-lanes';
import { readText } from './support/read-text';
import { extractJobBlock } from './support/workflow-blocks';

// Ubuntu's real-binary qualification is the ordinary coverage shards. Keep
// both the discovered file set and the binaries those shards receive intact.
const EXPR = `$${'{{'}`;
const SHELL = `$${'{'}`;
const suites = discoverQualificationTests(ROOT_DIR);
const scripts = (
  JSON.parse(readText(`${API_DIR}/package.json`)) as {
    scripts: Record<string, string>;
  }
).scripts;

// Only the current coverage/reporting options may precede the one directory
// selector. Unknown flags or extra selectors require a coverage review.
function isUnfilteredCoverageCommand(command: string, directory: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const prefix = 'MANGOSTUDIO_DIAGNOSTIC_LOGS=0 bun ../../scripts/with-test-home.ts bun test';
  if (tokens.slice(0, 5).join(' ') !== prefix) return false;
  const args = tokens.slice(5);
  if (args.at(-1) !== directory || args.at(-2) !== '$MANGOSTUDIO_BUN_TEST_ARGS') return false;
  const flags = args.slice(0, -2);
  if (!flags.includes('--coverage')) return false;
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === '--timeout') {
      if (!/^[1-9]\d*$/.test(flags[index + 1] ?? '')) return false;
      index += 1;
      continue;
    }
    if (
      !/^(--coverage|--update-timings|--parallel=1|--reporter=junit|--(timings|coverage-dir|reporter-outfile)=[\w./-]+)$/.test(
        flags[index]
      )
    )
      return false;
  }
  return true;
}

function expectShardedQualificationCoverage(
  selected: QualificationSuites,
  lanes: readonly TestLane[],
  commands: Readonly<Record<string, string>>
): void {
  const shardedApi = lanes.filter(
    (lane) => lane.sharded && lane.manifest === `${API_DIR}/package.json`
  );
  for (const file of [...selected.unit, ...selected.integration]) {
    const covered = shardedApi.some((lane) => {
      const dir = lane.workers?.testDir;
      const command = commands[lane.coverageScript] ?? '';
      return (
        dir !== undefined && file.startsWith(`${dir}/`) && isUnfilteredCoverageCommand(command, dir)
      );
    });
    expect(
      covered,
      `expected qualification file ${API_DIR}/${file} in a sharded API coverage lane | received: no covering lane`
    ).toBe(true);
  }
}

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly 'continue-on-error'?: unknown;
  readonly with?: Record<string, string>;
  readonly run?: string;
}

interface Workflow {
  readonly on: {
    readonly workflow_call: {
      readonly inputs?: Record<string, { type: string; required: boolean }>;
      readonly outputs?: Record<string, { value: string }>;
    };
  };
  readonly jobs: Record<
    string,
    {
      uses?: string;
      needs?: string[];
      with?: Record<string, string>;
      steps?: Step[];
      outputs?: Record<string, string>;
    }
  >;
}

function expectRuntimeOnEveryShard(source: string): void {
  const workflow = Bun.YAML.parse(source) as Workflow;
  expect(
    workflow.on.workflow_call.inputs?.runtime_artifact,
    'expected required string runtime_artifact input for every shard'
  ).toMatchObject({ type: 'string', required: true });
  const runtime =
    workflow.jobs.shard?.steps?.filter((step) => step.uses === './.github/actions/local-runtime') ??
    [];
  expect(runtime, 'expected exactly one local-runtime action in the shard job').toHaveLength(1);
  const step = runtime[0];
  expect(step?.with?.artifact, 'expected shard runtime artifact from inputs.runtime_artifact').toBe(
    `${EXPR} inputs.runtime_artifact }}`
  );
  expect(step?.if, 'expected local-runtime action to run on every shard').toBeUndefined();
  const ignoreRuntimeFailure = step?.['continue-on-error'];
  expect(
    ignoreRuntimeFailure === undefined ? false : ignoreRuntimeFailure,
    'expected a missing shard runtime to fail its job'
  ).toBe(false);
  const steps = workflow.jobs.shard.steps ?? [];
  const coverage = steps.findIndex((candidate) => candidate.id === 'coverage');
  expect(coverage, 'expected shard coverage step after the local-runtime action').toBeGreaterThan(
    steps.indexOf(step as Step)
  );
  const coverageStep = steps[coverage];
  expect(coverageStep?.if, 'expected coverage to run on every shard').toBeUndefined();
  const ignoreCoverageFailure = coverageStep?.['continue-on-error'];
  expect(
    ignoreCoverageFailure === undefined ? false : ignoreCoverageFailure,
    'expected a failing shard coverage run to fail its job'
  ).toBe(false);
  expect(
    coverageStep?.run?.trim().split('\n').at(-1)?.trim(),
    'expected every shard to run all sharded coverage lanes'
  ).toBe(`-- bun run test --coverage --shard="${SHELL}SHARD}/${SHELL}SHARD_COUNT}"`);
}

describe('Ubuntu qualification coverage in the shards', () => {
  test('every discovered qualification file belongs to an active sharded coverage lane', () => {
    expect(suites.unit.length + suites.integration.length).toBeGreaterThan(0);
    expectShardedQualificationCoverage(suites, TEST_LANES, scripts);
  });

  test('names the lost file when its lane is no longer sharded', () => {
    const lanes = TEST_LANES.map((lane) =>
      lane.id === 'api-unit' ? { ...lane, sharded: false } : lane
    );
    expect(() => expectShardedQualificationCoverage(suites, lanes, scripts)).toThrow(
      `expected qualification file ${API_DIR}/${suites.unit[0]} in a sharded API coverage lane`
    );
  });

  test('names a qualification file moved outside the lane directories', () => {
    const moved = 'tests/qualification/moved.integration.test.ts';
    expect(() =>
      expectShardedQualificationCoverage({ unit: [], integration: [moved] }, TEST_LANES, scripts)
    ).toThrow(`expected qualification file ${API_DIR}/${moved} in a sharded API coverage lane`);
  });

  test('rejects a manifest that no longer runs the lane directory', () => {
    const commands = {
      ...scripts,
      'test:coverage:unit': scripts['test:coverage:unit'].replace(/tests\/unit$/, 'tests/other'),
    };
    expect(() => expectShardedQualificationCoverage(suites, TEST_LANES, commands)).toThrow(
      `expected qualification file ${API_DIR}/${suites.unit[0]} in a sharded API coverage lane`
    );
  });

  test.each([
    ['name filter', '--test-name-pattern="^(?!.*expands ~)"'],
    ['separate name filter', '--test-name-pattern "^(?!.*expands ~)"'],
    ['short name filter', '-t "^(?!.*expands ~)"'],
    ['narrowed files', 'tests/unit/services/tools/glob-tool.test.ts'],
  ])('rejects a coverage command with %s', (_name, narrowing) => {
    const commands = {
      ...scripts,
      'test:coverage:unit': scripts['test:coverage:unit'].replace(
        / tests\/unit$/,
        ` ${narrowing} tests/unit`
      ),
    };
    expect(() => expectShardedQualificationCoverage(suites, TEST_LANES, commands)).toThrow(
      `expected qualification file ${API_DIR}/${suites.unit[0]} in a sharded API coverage lane`
    );
  });
});

describe('qualification runtime artifact handoff', () => {
  const source = readText('.github/workflows/test.yml');

  test('every shard receives the runtime artifact before running its coverage slice', () => {
    expectRuntimeOnEveryShard(source);
  });

  test.each([
    [
      'missing artifact',
      `artifact: ${EXPR} inputs.runtime_artifact }}`,
      'artifact: ""',
      'expected shard runtime artifact from inputs.runtime_artifact',
    ],
    [
      'missing action',
      'uses: ./.github/actions/local-runtime',
      'uses: ./.github/actions/setup-mango',
      'expected exactly one local-runtime action in the shard job',
    ],
    [
      'only one shard',
      'uses: ./.github/actions/local-runtime',
      `uses: ./.github/actions/local-runtime\n        if: ${EXPR} matrix.shard == 1 }}`,
      'expected local-runtime action to run on every shard',
    ],
    [
      'ignored failure',
      'uses: ./.github/actions/local-runtime',
      'uses: ./.github/actions/local-runtime\n        continue-on-error: true',
      'expected a missing shard runtime to fail its job',
    ],
    [
      'ignored failure expression',
      'uses: ./.github/actions/local-runtime',
      `uses: ./.github/actions/local-runtime\n        continue-on-error: ${EXPR} true }}`,
      'expected a missing shard runtime to fail its job',
    ],
    [
      'false expression',
      'uses: ./.github/actions/local-runtime',
      `uses: ./.github/actions/local-runtime\n        continue-on-error: ${EXPR} false }}`,
      'expected a missing shard runtime to fail its job',
    ],
    [
      'quoted failure policy',
      'uses: ./.github/actions/local-runtime',
      'uses: ./.github/actions/local-runtime\n        continue-on-error: "false"',
      'expected a missing shard runtime to fail its job',
    ],
    [
      'null failure policy',
      'uses: ./.github/actions/local-runtime',
      'uses: ./.github/actions/local-runtime\n        continue-on-error: null',
      'expected a missing shard runtime to fail its job',
    ],
    [
      'only one coverage shard',
      'id: coverage',
      `id: coverage\n        if: ${EXPR} matrix.shard == 1 }}`,
      'expected coverage to run on every shard',
    ],
    [
      'ignored coverage failure',
      'id: coverage',
      'id: coverage\n        continue-on-error: true',
      'expected a failing shard coverage run to fail its job',
    ],
    [
      'ignored coverage failure expression',
      'id: coverage',
      `id: coverage\n        continue-on-error: ${EXPR} true }}`,
      'expected a failing shard coverage run to fail its job',
    ],
  ])('rejects %s', (_name, oldText, newText, diagnostic) => {
    expect(source).toContain(oldText);
    expect(() => expectRuntimeOnEveryShard(source.replace(oldText, newText))).toThrow(diagnostic);
  });

  test.each(['uses: ./.github/actions/local-runtime', 'id: coverage'])(
    'accepts literal false failure continuation for %s',
    (marker) => {
      expectRuntimeOnEveryShard(
        source.replace(marker, `${marker}\n        continue-on-error: false`)
      );
    }
  );

  test('CI passes the output of the runtime producer to Test', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const producer = Bun.YAML.parse(
      extractJobBlock(workflow, 'local-runtime')
    ) as Workflow['jobs'][string];
    const consumer = Bun.YAML.parse(extractJobBlock(workflow, 'test')) as Workflow['jobs'][string];
    expect(producer.uses).toBe('./.github/workflows/local-runtime.yml');
    expect(consumer.needs).toContain('local-runtime');
    expect(consumer.uses).toBe('./.github/workflows/test.yml');
    expect(consumer.with?.runtime_artifact).toBe(`${EXPR} needs.local-runtime.outputs.artifact }}`);
  });

  test('the producer uploads both runtime and fake agent under its exported artifact name', () => {
    const workflow = Bun.YAML.parse(readText('.github/workflows/local-runtime.yml')) as Workflow;
    expect(workflow.on.workflow_call.outputs?.artifact.value).toBe(
      `${EXPR} jobs.build.outputs.artifact }}`
    );
    const build = workflow.jobs.build;
    const upload = build.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.name).toBe(build.outputs?.artifact);
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(upload?.with?.path?.trim().split('\n')).toEqual([
      `${EXPR} runner.temp }}/local-runtime/mangostudio-runtime`,
      `${EXPR} runner.temp }}/local-runtime/fake_cursor_agent`,
    ]);
  });

  test('the action downloads the named artifact and exports both binaries to the tests', () => {
    const action = Bun.YAML.parse(readText('.github/actions/local-runtime/action.yml')) as {
      runs: { steps: Step[] };
    };
    const download = action.runs.steps.find((step) =>
      step.uses?.startsWith('actions/download-artifact@')
    );
    expect(download?.with?.name).toBe(`${EXPR} inputs.artifact }}`);
    expect(download?.with?.path).toBe(`${EXPR} runner.temp }}/local-runtime`);
    const verify = action.runs.steps.find(
      (step) => step.name === 'Verify and export the Local runtime'
    );
    expect(verify?.if).toBeUndefined();
    expect(verify?.run).toContain(
      `binary="${SHELL}RUNNER_TEMP}/local-runtime/mangostudio-runtime"`
    );
    expect(verify?.run).toContain(`fake="${SHELL}RUNNER_TEMP}/local-runtime/fake_cursor_agent"`);
    expect(verify?.run).toContain(`echo "MANGOSTUDIO_RUNTIME_BINARY=${SHELL}binary}"`);
    expect(verify?.run).toContain(`echo "MANGOSTUDIO_FAKE_CURSOR_AGENT=${SHELL}fake}"`);
    expect(verify?.run).toContain('>> "$GITHUB_ENV"');
  });
});
