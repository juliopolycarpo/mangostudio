import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import {
  assertSmokeDeadlineBudget,
  assertSmokeInventory,
  parseSmokeWorkflow,
  type SmokeJob,
  type SmokeLeg,
  smokeAssertions,
  smokeJobLegs,
  smokeMatrixCases,
  smokeStepEnv,
  smokeStepLabel,
  smokeStepRuns,
  smokeStepTimeout,
} from './support/smoke-workflows';

// Pin the original 14 assertions, not whatever the current workflow happens
// to declare. A missing pairing must say which coverage disappeared.
const ORIGINAL_SMOKE_ASSERTIONS = [
  'binary/linux-x64',
  'binary/linux-arm64',
  'binary/darwin-arm64',
  'binary/darwin-x64',
  'binary/windows-x64',
  'binary/windows-arm64',
  'docker/bookworm/amd64',
  'docker/bookworm/arm64',
  'docker/alpine/amd64',
  'docker/alpine/arm64',
  'container/docker/linux-x64',
  'container/docker/linux-x64-musl',
  'container/podman/linux-x64',
  'container/podman/linux-x64-musl',
] as const;

function readWorkflows() {
  return {
    binary: parseSmokeWorkflow(readText('.github/workflows/smoke-binary.yml')),
    container: parseSmokeWorkflow(readText('.github/workflows/smoke-container.yml')),
  };
}

describe('smoke workflow assertion inventory', () => {
  test('preserves all fourteen original platform, Docker variant and engine/libc assertions', () => {
    assertSmokeInventory(smokeAssertions(readWorkflows()), ORIGINAL_SMOKE_ASSERTIONS);
  });

  test.each(['binary/windows-arm64', 'docker/alpine/arm64', 'container/podman/linux-x64-musl'])(
    'names missing coverage for %s',
    (missing) => {
      const assertions = smokeAssertions(readWorkflows()).filter(({ id }) => id !== missing);
      expect(() => assertSmokeInventory(assertions, ORIGINAL_SMOKE_ASSERTIONS)).toThrow(
        `missing [${missing}]`
      );
    }
  );

  test('rejects extra or duplicate assertions', () => {
    const assertions = smokeAssertions(readWorkflows());
    const first = assertions[0];
    expect(first).toBeDefined();
    if (!first) throw new Error('Expected at least one smoke assertion');
    expect(() => assertSmokeInventory([...assertions, first], ORIGINAL_SMOKE_ASSERTIONS)).toThrow(
      'duplicated [binary/linux-x64]'
    );
    expect(() =>
      assertSmokeInventory([{ ...first, id: 'binary/unsupported' }], ORIGINAL_SMOKE_ASSERTIONS)
    ).toThrow('unexpected [binary/unsupported]');
  });

  test('runs fourteen assertions in seven native runner jobs', () => {
    const assertions = smokeAssertions(readWorkflows());
    const jobs = new Set(assertions.map(({ job, matrix }) => `${job}/${matrix.platform ?? ''}`));
    expect(jobs.size).toBe(7);
    expect(assertions.filter(({ job }) => job === 'container/container')).toHaveLength(4);
    for (const platform of ['linux-x64', 'linux-arm64']) {
      expect(assertions.filter(({ matrix }) => matrix.platform === platform)).toHaveLength(3);
    }
    for (const platform of ['darwin-arm64', 'darwin-x64', 'windows-x64', 'windows-arm64']) {
      expect(assertions.filter(({ matrix }) => matrix.platform === platform)).toHaveLength(1);
    }
  });

  test('keeps each platform on its native runner and each runtime paired with the right image', () => {
    const expectedRunners: Record<string, string> = {
      'linux-x64': 'ubuntu-latest',
      'linux-arm64': 'ubuntu-24.04-arm',
      'darwin-arm64': 'macos-latest',
      'darwin-x64': 'macos-15-intel',
      'windows-x64': 'windows-latest',
      'windows-arm64': 'windows-11-arm',
    };
    const expectedDockerTargets: Record<string, string> = {
      'docker/bookworm/amd64': 'linux-x64',
      'docker/bookworm/arm64': 'linux-arm64',
      'docker/alpine/amd64': 'linux-x64-musl',
      'docker/alpine/arm64': 'linux-arm64-musl',
    };
    for (const { id, matrix, env, step } of smokeAssertions(readWorkflows())) {
      if (id.startsWith('binary/')) expect(matrix.runner, id).toBe(expectedRunners[env.PLATFORM]);
      if (id.startsWith('docker/')) {
        expect(env.BINARY_PLATFORM, id).toBe(expectedDockerTargets[id]);
        expect(env.DOCKERFILE, id).toBe(
          env.VARIANT === 'alpine' ? 'Dockerfile.alpine' : 'Dockerfile'
        );
      }
      if (id.startsWith('container/')) {
        const musl = id.endsWith('-musl');
        expect(env.BASE_IMAGE, id).toBe(musl ? 'alpine:3' : 'debian:bookworm-slim');
        expect(env.PACKAGES, id).toBe(musl ? 'bash libstdc++' : '');
        expect(step.run, id).toContain('image inspect "$MANGO_CONTAINER_E2E_IMAGE"');
        expect(step.run, id).toContain('[ ! -x "$MANGO_CONTAINER_E2E_RUNTIME" ]');
      }
    }
  });

  test('every folded assertion runs after failure and retains its failure result', () => {
    const workflows = readWorkflows();
    for (const { id, job, step } of smokeAssertions(workflows)) {
      const condition = id.startsWith('docker/')
        ? '$' + '{{ !cancelled() && matrix.docker_arch }}'
        : '$' + '{{ !cancelled() }}';
      expect(step.if, id).toBe(condition);
      expect(step['continue-on-error'], id).toBeUndefined();
      const [workflowName, jobName] = job.split('/');
      const workflow = workflows[workflowName as keyof typeof workflows];
      expect(workflow.jobs[jobName]['continue-on-error'], id).toBeUndefined();
    }
  });

  test('every step a smoke leg can run has a deadline and they total below its job deadline', () => {
    // A job timeout cancels the job, which skips every later !cancelled()
    // assertion and teardown check. A step timeout only fails that step, so
    // everything one runner executes in sequence, setup and teardown included,
    // must carry a deadline and must not add up to the job's.
    const budgeted: string[] = [];
    for (const [workflowName, workflow] of Object.entries(readWorkflows())) {
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        // A reusable-workflow caller has no steps and cannot set a timeout.
        if (!job.steps) continue;
        assertSmokeDeadlineBudget(`${workflowName}/${jobName}`, job);
        budgeted.push(`${workflowName}/${jobName}`);
      }
    }
    expect(budgeted).toEqual(['binary/binary', 'container/container']);
  });

  test('a step without a deadline fails the budget by leg and step name', () => {
    const job = (steps: string): SmokeJob =>
      parseSmokeWorkflow(`jobs:
  smoke:
    timeout-minutes: 10
    steps:
${steps}`).jobs.smoke;
    expect(() =>
      assertSmokeDeadlineBudget(
        'binary/smoke',
        job('      - uses: actions/checkout@v7\n      - name: Smoke\n        timeout-minutes: 4')
      )
    ).toThrow(
      'expected binary/smoke step "actions/checkout@v7" to declare timeout-minutes: <number> | received: undefined'
    );
    // A marker step is still a step the runner executes before the deadline.
    expect(() =>
      assertSmokeDeadlineBudget(
        'binary/smoke',
        job(
          '      - name: Smoke\n        timeout-minutes: 4\n      - id: ready\n        run: "true"'
        )
      )
    ).toThrow(
      'expected binary/smoke step "ready" to declare timeout-minutes: <number> | received: undefined'
    );
    expect(() => assertSmokeDeadlineBudget('binary/smoke', { steps: [] })).toThrow(
      'expected binary/smoke to declare a numeric job timeout-minutes | received: undefined'
    );
  });

  test('a leg whose deadlines reach the job deadline fails, counting only steps it can run', () => {
    const job = (jobTimeout: number): SmokeJob => ({
      'timeout-minutes': jobTimeout,
      strategy: { matrix: { include: [{ platform: 'linux-x64', docker_arch: 'amd64' }] } },
      steps: [
        { uses: 'actions/checkout@v7', 'timeout-minutes': 2 },
        { name: 'Toolchain', if: '$' + '{{ inputs.rebuild }}', 'timeout-minutes': 5 },
        { name: 'Download', if: '$' + '{{ !inputs.rebuild }}', 'timeout-minutes': 3 },
        {
          name: 'Docker',
          if: '$' + '{{ !cancelled() && matrix.docker_arch }}',
          'timeout-minutes': 4,
        },
      ],
    });
    // Rebuild and prebuilt setup never share a leg: 2+5+4, not 2+5+3+4.
    expect(() => assertSmokeDeadlineBudget('binary/smoke', job(12))).not.toThrow();
    expect(() => assertSmokeDeadlineBudget('binary/smoke', job(11))).toThrow(
      "expected binary/smoke (linux-x64, rebuild) step deadlines to total below the job's timeout-minutes: 11 | received: 11 (actions/checkout@v7=2 + Toolchain=5 + Docker=4)"
    );
  });

  test('a job expands into one leg per matrix case and rebuild mode it branches on', () => {
    const matrix = { include: [{ platform: 'linux-x64' }, { platform: 'windows-x64' }] };
    const legs = smokeJobLegs('binary/binary', {
      strategy: { matrix },
      steps: [{ name: 'Toolchain', if: '$' + '{{ inputs.rebuild }}' }],
    });
    expect(legs.map(({ name }) => name)).toEqual([
      'binary/binary (linux-x64, prebuilt)',
      'binary/binary (linux-x64, rebuild)',
      'binary/binary (windows-x64, prebuilt)',
      'binary/binary (windows-x64, rebuild)',
    ]);
    expect(legs[1]).toEqual({
      name: 'binary/binary (linux-x64, rebuild)',
      matrix: { platform: 'linux-x64' },
      inputs: { rebuild: true },
    });
    expect(smokeJobLegs('container/container', { steps: [{ name: 'Suite' }] })).toEqual([
      { name: 'container/container', matrix: {}, inputs: {} },
    ]);
  });

  test('a leg skips only the steps its matrix or rebuild mode proves cannot run', () => {
    const linuxRebuild = {
      name: 'linux',
      matrix: { docker_arch: 'amd64' },
      inputs: { rebuild: true },
    };
    const macPrebuilt = { name: 'mac', matrix: {}, inputs: { rebuild: false } };
    const runs = (condition: string, leg: SmokeLeg) =>
      smokeStepRuns({ if: `${'$'}{{ ${condition} }}` }, leg);

    expect(smokeStepRuns({}, macPrebuilt)).toBe(true);
    expect(runs('!cancelled()', macPrebuilt)).toBe(true);
    expect(runs('inputs.rebuild', linuxRebuild)).toBe(true);
    expect(runs('inputs.rebuild', macPrebuilt)).toBe(false);
    expect(runs('!inputs.rebuild', linuxRebuild)).toBe(false);
    expect(runs('!inputs.rebuild', macPrebuilt)).toBe(true);
    expect(runs('!cancelled() && matrix.docker_arch', linuxRebuild)).toBe(true);
    expect(runs('!cancelled() && matrix.docker_arch', macPrebuilt)).toBe(false);
    expect(runs('!cancelled() && matrix.docker_arch && !inputs.rebuild', linuxRebuild)).toBe(false);
    // Without the wrapper GitHub still evaluates `if:` as an expression.
    expect(smokeStepRuns({ if: 'matrix.docker_arch' }, macPrebuilt)).toBe(false);
    // Unproven shapes count toward the budget rather than silently leaving it.
    expect(runs('matrix.docker_arch || inputs.rebuild', macPrebuilt)).toBe(true);
    expect(runs('!(matrix.docker_arch && inputs.rebuild)', linuxRebuild)).toBe(true);
    expect(runs("steps.ready.outcome == 'success'", macPrebuilt)).toBe(true);
    expect(runs('inputs.channel', macPrebuilt)).toBe(true);
  });

  test('a step is cited by its name, then its id, then its action', () => {
    expect(smokeStepLabel({ name: 'Smoke', id: 'smoke', uses: 'a/b@v1' }, 0)).toBe('Smoke');
    expect(smokeStepLabel({ id: 'ready', run: 'true' }, 0)).toBe('ready');
    expect(smokeStepLabel({ uses: 'actions/checkout@v7' }, 0)).toBe('actions/checkout@v7');
    expect(smokeStepLabel({ run: 'true' }, 2)).toBe('#3');
  });

  test('a binary leg with no folded assertion after it keeps rebuild headroom', () => {
    // A manual rebuild compiles inside the smoke step. Linux needs the short
    // deadline to leave room for its Docker assertions; macOS and Windows run
    // nothing after it, so they take the budget the Linux legs split in three.
    const assertions = smokeAssertions(readWorkflows()).filter(
      ({ job }) => job === 'binary/binary'
    );
    for (const { id, matrix, step } of assertions.filter(({ id }) => id.startsWith('binary/'))) {
      const folded = assertions.filter((other) => other.matrix.platform === matrix.platform);
      const expected = folded.length > 1 ? 4 : 12;
      const minutes = smokeStepTimeout(step, matrix);
      if (minutes !== expected) {
        throw new Error(
          `expected ${id} step timeout-minutes: ${expected} (${folded.length} assertion(s) share its job) | received: ${minutes}`
        );
      }
    }
  });

  test('a step deadline resolves through its matrix field', () => {
    const step = { name: 'smoke', 'timeout-minutes': '$' + '{{ matrix.smoke_timeout }}' };
    expect(smokeStepTimeout(step, { smoke_timeout: '12' })).toBe(12);
    expect(smokeStepTimeout({ 'timeout-minutes': 4 }, {})).toBe(4);
    expect(smokeStepTimeout({}, {})).toBeUndefined();
    expect(() => smokeStepTimeout(step, {})).toThrow(
      'expected step "smoke" timeout-minutes to be a number or a matrix field holding one | received: $' +
        '{{ matrix.smoke_timeout }}'
    );
  });

  test('checks each container engine for leaks once after both libc assertions', () => {
    const job = readWorkflows().container.jobs.container;
    expect(smokeMatrixCases(job)).toEqual([{}]);
    const leakSteps = (job.steps ?? []).filter(({ run }) => run?.includes('name=mango-rt-'));
    expect(leakSteps).toHaveLength(2);
    expect(leakSteps.map(({ env }) => env?.CONTAINER_CLI).sort()).toEqual(['docker', 'podman']);
    for (const step of leakSteps) {
      expect(step.if).toBe('$' + '{{ !cancelled() }}');
      expect(step.run).toContain('seq 1 20');
      const steps = [...(job.steps ?? [])];
      const leakIndex = steps.indexOf(step);
      const suites = steps.filter(
        ({ env, run }) =>
          env?.MANGO_CONTAINER_E2E_ENGINE === step.env?.CONTAINER_CLI &&
          run?.includes('connect-container-runtime.integration.test.ts')
      );
      expect(suites).toHaveLength(2);
      for (const suite of suites) expect(steps.indexOf(suite)).toBeLessThan(leakIndex);
    }
  });

  test('expands Cartesian engine/libc cells and include-only platform matrices', () => {
    const workflow = parseSmokeWorkflow(`jobs:
  pairing:
    strategy:
      matrix:
        engine: [docker, podman]
        variant: [glibc, musl]
        include:
          - variant: glibc
            platform: linux-x64
          - variant: musl
            platform: linux-x64-musl
  binary:
    strategy:
      matrix:
        include:
          - platform: linux-x64
          - platform: windows-arm64
`);
    expect(smokeMatrixCases(workflow.jobs.pairing)).toEqual([
      { engine: 'docker', variant: 'glibc', platform: 'linux-x64' },
      { engine: 'docker', variant: 'musl', platform: 'linux-x64-musl' },
      { engine: 'podman', variant: 'glibc', platform: 'linux-x64' },
      { engine: 'podman', variant: 'musl', platform: 'linux-x64-musl' },
    ]);
    expect(smokeMatrixCases(workflow.jobs.binary)).toEqual([
      { platform: 'linux-x64' },
      { platform: 'windows-arm64' },
    ]);
    expect(smokeMatrixCases({ steps: [] })).toEqual([{}]);
    expect(
      smokeStepEnv(
        { env: { PLATFORM: 'old', BASE: 'shared' } },
        { env: { PLATFORM: '$' + '{{ matrix.platform }}' } },
        { platform: 'linux-x64' }
      )
    ).toEqual({ BASE: 'shared', PLATFORM: 'linux-x64' });
  });
});
