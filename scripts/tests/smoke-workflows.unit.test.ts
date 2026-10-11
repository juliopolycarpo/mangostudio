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

const INVALID_SMOKE_DEADLINES = [
  ['null', 'null'],
  ["''", '""'],
  ["'   '", '"   "'],
  ['false', 'false'],
  ['true', 'true'],
  ['0', '0'],
  ['-1', '-1'],
  ['1.5', '1.5'],
  ['.inf', 'Infinity'],
  ['.nan', 'NaN'],
  ["'abc'", '"abc"'],
] as const;

// The container job's suite and leak-check bodies live in these scripts. A
// step is recognized by the script it runs; the script holds what it does.
const PAIRING_SCRIPT = 'scripts/release/smoke-container-pairing.sh';
const LEAK_SCRIPT = 'scripts/release/assert-no-leftover-containers.sh';

function readWorkflows() {
  return {
    binary: parseSmokeWorkflow(readText('.github/workflows/smoke-binary.yml')),
    container: parseSmokeWorkflow(readText('.github/workflows/smoke-container.yml')),
  };
}

// Kept apart from the braces so no Actions expression opens in this source.
const DOLLAR = '$';
const READY = "steps.ready.outcome == 'success'";
const MUSL_DOWNLOADED =
  "(steps.musl_runtime.outcome == 'success' || steps.musl_target.outcome == 'success')";

// An assertion survives an earlier assertion's failure, but not failed setup:
// without staged bytes it could only add a second, misleading failure.
function expectedAssertionCondition(id: string): string {
  if (id.startsWith('binary/')) return `${DOLLAR}{{ !cancelled() && ${READY} }}`;
  if (id.startsWith('docker/')) {
    const staged = id.startsWith('docker/alpine/') ? `${READY} && ${MUSL_DOWNLOADED}` : READY;
    return `${DOLLAR}{{ !cancelled() && ${staged} && matrix.docker_arch }}`;
  }
  if (id.startsWith('container/')) return '$' + '{{ !cancelled() }}';
  throw new Error(`expected a binary/, docker/ or container/ assertion id | received: ${id}`);
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
        expect(step.run?.trim(), id).toBe(`../../${PAIRING_SCRIPT}`);
        expect(step['working-directory'], id).toBe('apps/api');
      }
    }
    const pairing = readText(PAIRING_SCRIPT);
    expect(pairing).toContain('image inspect "$MANGO_CONTAINER_E2E_IMAGE"');
    expect(pairing).toContain('[ ! -x "$MANGO_CONTAINER_E2E_RUNTIME" ]');
    expect(pairing).toContain(
      'bun test tests/integration/services/connect-container-runtime.integration.test.ts'
    );
  });

  test('every folded assertion runs after failure and retains its failure result', () => {
    const workflows = readWorkflows();
    for (const { id, job, step } of smokeAssertions(workflows)) {
      const condition = expectedAssertionCondition(id);
      if (step.if !== condition) {
        throw new Error(`expected ${id} step if: ${condition} | received: ${step.if}`);
      }
      expect(step['continue-on-error'], id).toBeUndefined();
      const [workflowName, jobName] = job.split('/');
      const workflow = workflows[workflowName as keyof typeof workflows];
      expect(workflow.jobs[jobName]['continue-on-error'], id).toBeUndefined();
    }
  });

  test('the binary job marks setup complete once, before its first assertion', () => {
    const steps = [...(readWorkflows().binary.jobs.binary.steps ?? [])];
    const first = steps.findIndex(({ run }) => run?.includes('scripts/test-build.ts'));
    const marker = steps[first - 1];
    // The default condition is what makes the marker fail-closed: it is
    // skipped as soon as any checkout, toolchain or download step fails.
    if (marker?.id !== 'ready' || marker.if !== undefined) {
      throw new Error(
        `expected the step before the binary smoke to be { id: ready, if: undefined } | received: ${JSON.stringify({ id: marker?.id, if: marker?.if })}`
      );
    }
    for (const step of steps.slice(0, first - 1)) {
      const label = step.name ?? step.uses;
      if (step.if?.includes('cancelled()') || step.if?.includes('always()')) {
        throw new Error(
          `expected setup step "${label}" to stop after an earlier failure | received: ${step.if}`
        );
      }
    }
  });

  test('every step outcome a binary job condition reads belongs to an earlier step', () => {
    // An unknown id reads as an empty outcome: no error, just a silent skip.
    const steps = [...(readWorkflows().binary.jobs.binary.steps ?? [])];
    for (const [index, step] of steps.entries()) {
      const earlier = steps.slice(0, index).map(({ id }) => id);
      for (const [, id] of (step.if ?? '').matchAll(/steps\.(\w+)\./g)) {
        if (!earlier.includes(id)) {
          throw new Error(
            `expected "${step.name}" to read the outcome of an earlier step id [${earlier.filter(Boolean).join(', ')}] | received: ${id}`
          );
        }
      }
    }
  });

  test('the Alpine downloads wait for setup and the teardown checks never skip', () => {
    const steps = readWorkflows().binary.jobs.binary.steps ?? [];
    const expected: Record<string, string> = {
      musl_runtime: `${DOLLAR}{{ !cancelled() && ${READY} && matrix.docker_arch && inputs.rebuild }}`,
      musl_target: `${DOLLAR}{{ !cancelled() && ${READY} && matrix.docker_arch && !inputs.rebuild }}`,
    };
    for (const [id, condition] of Object.entries(expected)) {
      const received = steps.find((step) => step.id === id)?.if;
      if (received !== condition) {
        throw new Error(`expected step ${id} if: ${condition} | received: ${received}`);
      }
    }
    const teardowns = steps.filter(({ name }) => name?.endsWith('teardown'));
    expect(teardowns).toHaveLength(3);
    for (const { name, if: received } of teardowns) {
      const condition = '$' + '{{ !cancelled() && matrix.docker_arch }}';
      if (received !== condition) {
        throw new Error(`expected "${name}" if: ${condition} | received: ${received}`);
      }
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
      'expected binary/smoke step "actions/checkout@v7" to declare timeout-minutes: <positive integer> | received: undefined'
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
      'expected binary/smoke step "ready" to declare timeout-minutes: <positive integer> | received: undefined'
    );
    expect(() => assertSmokeDeadlineBudget('binary/smoke', { steps: [] })).toThrow(
      'expected binary/smoke to declare job timeout-minutes: <positive integer> | received: undefined'
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
    // A parenthesized `||` group is one unknown term: it cannot rescue a
    // conjunction whose own matrix term is false on this leg.
    const gated =
      "!cancelled() && steps.ready.outcome == 'success' && (steps.a.outcome == 'success' || steps.b.outcome == 'success') && matrix.docker_arch";
    if (runs(gated, macPrebuilt)) {
      throw new Error(
        `expected a leg without docker_arch to skip a step whose top-level && names matrix.docker_arch | received: counted for "${gated}"`
      );
    }
    expect(runs(gated, linuxRebuild)).toBe(true);
    expect(runs('(matrix.docker_arch && inputs.rebuild) || inputs.rebuild', macPrebuilt)).toBe(
      true
    );
  });

  test('rebuild branch detection follows case-insensitive Actions context names', () => {
    const legs = smokeJobLegs('binary/smoke', {
      steps: [{ if: 'INPUTS.REBUILD' }, { if: '!inputs.REBUILD' }],
    });
    expect(legs.map(({ inputs }) => inputs)).toEqual([{ rebuild: false }, { rebuild: true }]);
  });

  test.each(['true', 'false'])(
    'parsed boolean conditions stay conservatively budgeted: %s',
    (declared) => {
      const job = parseSmokeWorkflow(`jobs:
  smoke:
    timeout-minutes: 4
    steps:
      - name: Boolean condition
        if: ${declared}
        timeout-minutes: 4`).jobs.smoke;
      expect(() => smokeJobLegs('binary/smoke', job)).not.toThrow();
      expect(smokeJobLegs('binary/smoke', job)).toEqual([
        { name: 'binary/smoke', matrix: {}, inputs: {} },
      ]);
      expect(() => assertSmokeDeadlineBudget('binary/smoke', job)).toThrow(
        "expected binary/smoke step deadlines to total below the job's timeout-minutes: 4 | received: 4 (Boolean condition=4)"
      );
      expect(() =>
        assertSmokeDeadlineBudget('binary/smoke', { ...job, 'timeout-minutes': 5 })
      ).not.toThrow();
    }
  );

  test.each(['matrix.DOCKER_ARCH', 'MATRIX.docker_arch', 'MaTrIx.DoCkEr_ArCh'])(
    'matrix gates resolve case-insensitive context and field names: %s',
    (condition) => {
      const linux = { name: 'linux', matrix: { docker_arch: 'amd64' }, inputs: {} };
      const uppercaseLinux = { name: 'linux', matrix: { DOCKER_ARCH: 'amd64' }, inputs: {} };
      const mac = { name: 'mac', matrix: {}, inputs: {} };
      expect(smokeStepRuns({ if: condition }, linux)).toBe(true);
      expect(smokeStepRuns({ if: condition }, uppercaseLinux)).toBe(true);
      expect(smokeStepRuns({ if: condition }, mac)).toBe(false);
      expect(smokeStepRuns({ if: `!${condition}` }, linux)).toBe(false);
      expect(smokeStepRuns({ if: `!${condition}` }, mac)).toBe(true);
    }
  );

  test.each(['inputs.REBUILD', 'INPUTS.rebuild', 'InPuTs.ReBuIlD'])(
    'rebuild gates resolve case-insensitive context and field names: %s',
    (condition) => {
      const rebuild = { name: 'rebuild', matrix: {}, inputs: { rebuild: true } };
      const prebuilt = { name: 'prebuilt', matrix: {}, inputs: { rebuild: false } };
      expect(smokeStepRuns({ if: condition }, prebuilt)).toBe(false);
      expect(smokeStepRuns({ if: condition }, rebuild)).toBe(true);
      expect(smokeStepRuns({ if: `!${condition}` }, prebuilt)).toBe(true);
      expect(smokeStepRuns({ if: `!${condition}` }, rebuild)).toBe(false);
    }
  );

  test.each([
    "steps.label.outputs.name == 'x && matrix.docker_arch && y'",
    "steps.label.outputs.name == 'it''s x && matrix.docker_arch && y'",
    "steps.label.outputs.name == '(x) && matrix.docker_arch && y'",
  ])('quoted Actions literals stay one unknown term: %s', (condition) => {
    const macPrebuilt = { name: 'mac', matrix: {}, inputs: { rebuild: false } };
    expect(smokeStepRuns({ if: condition }, macPrebuilt)).toBe(true);
    expect(() =>
      assertSmokeDeadlineBudget('binary/smoke', {
        'timeout-minutes': 10,
        strategy: { matrix: { include: [{ platform: 'darwin-arm64' }] } },
        steps: [{ name: 'Quoted condition', if: condition }],
      })
    ).toThrow(
      'expected binary/smoke (darwin-arm64) step "Quoted condition" to declare timeout-minutes: <positive integer> | received: undefined'
    );
  });

  test.each([
    "steps.label.outputs.name == '(x || y' && matrix.docker_arch",
    "steps.label.outputs.name == 'x) && y' && matrix.docker_arch",
    "steps.label.outputs.name == 'it''s (x || y)' && matrix.docker_arch",
  ])('quoted operators and parentheses leave genuine matrix gating intact: %s', (condition) => {
    const macPrebuilt = { name: 'mac', matrix: {}, inputs: { rebuild: false } };
    const linuxRebuild = {
      name: 'linux',
      matrix: { docker_arch: 'amd64' },
      inputs: { rebuild: true },
    };
    expect(smokeStepRuns({ if: condition }, macPrebuilt)).toBe(false);
    expect(smokeStepRuns({ if: condition }, linuxRebuild)).toBe(true);
  });

  test.each([
    "matrix.docker_arch && steps.label.outputs.name == 'unterminated",
    "steps.label.outputs.name == 'unterminated && matrix.docker_arch && x",
    "matrix.docker_arch && (steps.ready.outcome == 'success'",
    "matrix.docker_arch && steps.ready.outcome == 'success')",
  ])('unmatched quotes or parentheses conservatively count a step: %s', (condition) => {
    const macPrebuilt = { name: 'mac', matrix: {}, inputs: { rebuild: false } };
    expect(smokeStepRuns({ if: condition }, macPrebuilt)).toBe(true);
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
    expect(smokeStepTimeout({ 'timeout-minutes': '4' }, {})).toBe(4);
    expect(smokeStepTimeout({}, {})).toBeUndefined();
    expect(() => smokeStepTimeout(step, {})).toThrow(
      'expected step "smoke" timeout-minutes to be a positive integer or a matrix field holding one | received: "$' +
        '{{ matrix.smoke_timeout }}" | resolved matrix.smoke_timeout: undefined'
    );
  });

  test.each(['matrix.SMOKE_TIMEOUT', 'MATRIX.smoke_timeout', 'MaTrIx.SmOkE_TiMeOuT'])(
    'matrix deadlines resolve case-insensitive context and field names: %s',
    (field) => {
      const step = { name: 'Smoke', 'timeout-minutes': `${'$'}{{ ${field} }}` };
      expect(smokeStepTimeout(step, { smoke_timeout: '12' })).toBe(12);
      expect(smokeStepTimeout(step, { SMOKE_TIMEOUT: '12' })).toBe(12);
    }
  );

  test.each(INVALID_SMOKE_DEADLINES)(
    'rejects invalid direct step deadline %s',
    (declared, received) => {
      const job = parseSmokeWorkflow(`jobs:
  smoke:
    steps:
      - name: Smoke
        timeout-minutes: ${declared}`).jobs.smoke;
      expect(() => smokeStepTimeout(job.steps?.[0] ?? {}, {})).toThrow(
        `expected step "Smoke" timeout-minutes to be a positive integer or a matrix field holding one | received: ${received}`
      );
    }
  );

  test.each(INVALID_SMOKE_DEADLINES)(
    'rejects invalid resolved matrix deadline %s',
    (declared, received) => {
      const expression = '$' + '{{ matrix.smoke_timeout }}';
      const job = parseSmokeWorkflow(`jobs:
  smoke:
    strategy:
      matrix:
        include:
          - smoke_timeout: ${declared}
    steps:
      - name: Smoke
        timeout-minutes: ${expression}`).jobs.smoke;
      expect(() => smokeStepTimeout(job.steps?.[0] ?? {}, smokeMatrixCases(job)[0] ?? {})).toThrow(
        `expected step "Smoke" timeout-minutes to be a positive integer or a matrix field holding one | received: "${expression}" | resolved matrix.smoke_timeout: ${received}`
      );
    }
  );

  test.each(INVALID_SMOKE_DEADLINES)('rejects invalid job deadline %s', (declared, received) => {
    const job = parseSmokeWorkflow(`jobs:
  smoke:
    timeout-minutes: ${declared}
    steps: []`).jobs.smoke;
    expect(() => assertSmokeDeadlineBudget('binary/smoke', job)).toThrow(
      `expected binary/smoke to declare job timeout-minutes: <positive integer> | received: ${received}`
    );
  });

  test('checks each container engine for leaks once after both libc assertions', () => {
    const job = readWorkflows().container.jobs.container;
    expect(smokeMatrixCases(job)).toEqual([{}]);
    const leakSteps = (job.steps ?? []).filter(({ run }) => run?.includes(LEAK_SCRIPT));
    expect(leakSteps).toHaveLength(2);
    expect(leakSteps.map(({ env }) => env?.CONTAINER_CLI).sort()).toEqual(['docker', 'podman']);
    for (const step of leakSteps) {
      expect(step.if).toBe('$' + '{{ !cancelled() }}');
      expect(step.run?.trim()).toBe(LEAK_SCRIPT);
      const steps = [...(job.steps ?? [])];
      const leakIndex = steps.indexOf(step);
      const suites = steps.filter(
        ({ env, run }) =>
          env?.MANGO_CONTAINER_E2E_ENGINE === step.env?.CONTAINER_CLI &&
          run?.includes(PAIRING_SCRIPT)
      );
      expect(suites).toHaveLength(2);
      for (const suite of suites) expect(steps.indexOf(suite)).toBeLessThan(leakIndex);
    }
    const leakCheck = readText(LEAK_SCRIPT);
    expect(leakCheck).toContain('seq 1 20');
    expect(leakCheck).toContain('name=mango-rt-');
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
