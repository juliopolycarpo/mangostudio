import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import {
  assertSmokeInventory,
  parseSmokeWorkflow,
  smokeAssertions,
  smokeMatrixCases,
  smokeStepEnv,
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
