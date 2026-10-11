import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';
import {
  parseSmokeWorkflow,
  type SmokeJob,
  smokeMatrixCases,
  smokeStepEnv,
} from './support/smoke-workflows';

const scratchRoots: string[] = [];
afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface CommandEvent {
  readonly command: string;
  readonly args: string[];
  readonly engine?: string;
  readonly runtime?: string;
  readonly platform?: string;
  readonly skipBuild?: string;
}

function stageWorkflowRun(seededOutputPlatforms: readonly string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'mango-smoke-workflow-'));
  scratchRoots.push(root);
  const fakeBin = join(root, 'fake-bin');
  const stateDir = join(root, 'containers');
  mkdirSync(fakeBin);
  mkdirSync(stateDir);
  mkdirSync(join(root, 'apps', 'api'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  symlinkSync(join(ROOT_DIR, 'scripts', 'release'), join(root, 'scripts', 'release'), 'dir');
  const fakeSource = readText('scripts/tests/support/fake-smoke-workflow-command.ts');
  for (const name of ['bun', 'docker', 'podman', 'curl', 'ss', 'sleep']) {
    writeFileSync(join(fakeBin, name), `#!${process.execPath}\n${fakeSource}`, { mode: 0o755 });
  }
  for (const platform of ['linux-x64', 'linux-x64-musl']) {
    const target = join(root, '.mango', 'out', platform);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'mangostudio-runtime'), '#!/usr/bin/env true\n', { mode: 0o755 });
  }
  // Both executables can remain from an unverified build of another target.
  for (const platform of seededOutputPlatforms) {
    const target = join(root, '.mango', 'out', platform);
    mkdirSync(target, { recursive: true });
    for (const name of ['mangostudio', 'mangostudio-runtime']) {
      writeFileSync(join(target, name), '#!/usr/bin/env true\n', { mode: 0o755 });
    }
  }
  return { root, fakeBin, stateDir, eventsPath: join(root, 'commands.jsonl') };
}

async function runWorkflowSteps(
  job: SmokeJob,
  matrix: Record<string, string>,
  failure:
    | 'binary'
    | 'rejected-native-build'
    | 'container'
    | 'ports'
    | 'native-port'
    | 'slow-port'
    | 'none',
  rebuild = false,
  leftoverContainers: readonly string[] = [],
  seededOutputPlatforms: readonly string[] = []
) {
  const fixture = stageWorkflowRun(seededOutputPlatforms);
  for (const name of leftoverContainers) writeFileSync(join(fixture.stateDir, name), 'running');
  const outcomes: Array<{ name: string; code: number }> = [];
  const resolveValue = (value: string) =>
    value
      .replaceAll('$' + '{{ github.workspace }}', fixture.root)
      .replaceAll('$' + '{{ inputs.rebuild }}', String(rebuild))
      .replaceAll('$' + "{{ inputs.rebuild && '0' || '1' }}", rebuild ? '0' : '1');

  // Execute the commands unchanged. The separate workflow policy test checks
  // GitHub's !cancelled() conditions and absence of continue-on-error. This
  // fixture proves command execution/teardown, not the hosted Actions runner.
  for (const step of job.steps ?? []) {
    if (!step.run || (step.if?.includes('matrix.docker_arch') && !matrix.docker_arch)) continue;
    if (step.if?.includes('!inputs.rebuild') && rebuild) continue;
    const stepEnv = Object.fromEntries(
      Object.entries(smokeStepEnv(job, step, matrix)).map(([name, value]) => [
        name,
        resolveValue(value),
      ])
    );
    const child = Bun.spawn(['bash', '-eo', 'pipefail', '-c', step.run], {
      cwd: join(fixture.root, step['working-directory'] ?? ''),
      env: {
        ...process.env,
        ...stepEnv,
        PATH: `${fixture.fakeBin}:${process.env.PATH}`,
        RUNNER_TEMP: join(fixture.root, 'runner-temp'),
        FAKE_SMOKE_WORKFLOW_EVENTS: fixture.eventsPath,
        FAKE_SMOKE_WORKFLOW_STATE: fixture.stateDir,
        FAKE_SMOKE_WORKFLOW_FAILURE: failure,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, `${step.name}: ${stdout}${stderr}`).toBeOneOf([0, 1, 9]);
    outcomes.push({ name: step.name ?? '', code });
  }
  const events = readFileSync(fixture.eventsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as CommandEvent);
  return { outcomes, events, containers: readdirSync(fixture.stateDir) };
}

describe.skipIf(process.platform === 'win32')('folded smoke command continuation', () => {
  test('both Docker assertions report an occupied port before starting a container', async () => {
    const job = parseSmokeWorkflow(readText('.github/workflows/smoke-binary.yml')).jobs.binary;
    const matrix = smokeMatrixCases(job).find(({ platform }) => platform === 'linux-x64');
    if (!matrix)
      throw new Error('Missing linux-x64 matrix case; expected a native Linux smoke leg');
    const { outcomes, events, containers } = await runWorkflowSteps(job, matrix, 'ports');
    const dockerAssertions = outcomes.filter(({ name }) => name.includes('Docker smoke test'));
    expect(dockerAssertions.map(({ code }) => code)).toEqual([1, 1]);
    expect(events.filter(({ command, args }) => command === 'docker' && args[0] === 'run')).toEqual(
      []
    );
    expect(containers).toEqual([]);
  });

  test('a container left up by a killed image step is removed before the port precheck', async () => {
    const job = parseSmokeWorkflow(readText('.github/workflows/smoke-binary.yml')).jobs.binary;
    const matrix = smokeMatrixCases(job).find(({ platform }) => platform === 'linux-x64');
    if (!matrix)
      throw new Error('Missing linux-x64 matrix case; expected a native Linux smoke leg');
    // A step killed at its deadline never runs its EXIT trap, so the next
    // image step meets the same-named container still publishing 13002.
    const { outcomes, containers } = await runWorkflowSteps(job, matrix, 'none', false, [
      'mangostudio-smoke-linux-amd64-13002',
    ]);
    const received = outcomes
      .filter(({ name }) => name.includes('Docker smoke test'))
      .map(({ name, code }) => `${name}=${code}`)
      .join(', ');
    const expected = 'Run Bookworm Docker smoke test=0, Run Alpine Docker smoke test=0';
    if (received !== expected || containers.length) {
      throw new Error(
        `expected the leftover container removed and both images tested (${expected}; containers []) | received: ${received}; containers [${containers.join(', ')}]`
      );
    }
  }, 15_000);

  test('a port docker-proxy releases a moment late does not fail the image assertion', async () => {
    const job = parseSmokeWorkflow(readText('.github/workflows/smoke-binary.yml')).jobs.binary;
    const matrix = smokeMatrixCases(job).find(({ platform }) => platform === 'linux-x64');
    if (!matrix)
      throw new Error('Missing linux-x64 matrix case; expected a native Linux smoke leg');
    const { outcomes } = await runWorkflowSteps(job, matrix, 'slow-port');
    const received = outcomes
      .filter(({ name }) => name.includes('Docker smoke test'))
      .map(({ name, code }) => `${name}=${code}`)
      .join(', ');
    const expected = 'Run Bookworm Docker smoke test=0, Run Alpine Docker smoke test=0';
    if (received !== expected) {
      throw new Error(
        `expected the precheck to wait out a port released on its third probe (${expected}) | received: ${received}`
      );
    }
  }, 15_000);

  test('a leaked native hub fails only the native teardown check, not the image assertions', async () => {
    const job = parseSmokeWorkflow(readText('.github/workflows/smoke-binary.yml')).jobs.binary;
    const matrix = smokeMatrixCases(job).find(({ platform }) => platform === 'linux-x64');
    if (!matrix)
      throw new Error('Missing linux-x64 matrix case; expected a native Linux smoke leg');
    const { outcomes, events } = await runWorkflowSteps(job, matrix, 'native-port');
    // The images bind 13002 only, so a listener on 13001 is the native
    // step's finding alone; repeating it would leave both images untested.
    const received = outcomes
      .filter(({ name }) => name.includes('Docker') || name.includes('teardown'))
      .map(({ name, code }) => `${name}=${code}`)
      .join(', ');
    const expected = [
      'Assert native binary teardown=1',
      'Run Bookworm Docker smoke test=0',
      'Assert Bookworm Docker teardown=0',
      'Run Alpine Docker smoke test=0',
      'Assert Alpine Docker teardown=0',
    ].join(', ');
    if (received !== expected) {
      throw new Error(
        `expected a port 13001 listener to fail only the native teardown check (${expected}) | received: ${received}`
      );
    }
    expect(
      events.filter(({ command, args }) => command === 'docker' && args[0] === 'run')
    ).toHaveLength(2);
  });

  test('a broken first container assertion still reports the other three and both leak checks', async () => {
    const job = parseSmokeWorkflow(readText('.github/workflows/smoke-container.yml')).jobs
      .container;
    const { outcomes, events } = await runWorkflowSteps(job, {}, 'container');
    const assertions = outcomes.filter(({ name }) => name.includes('container transport smoke'));
    expect(assertions.map(({ code }) => code)).toEqual([9, 0, 0, 0]);
    expect(outcomes.filter(({ name }) => name.includes('outlived'))).toEqual([
      { name: 'Assert no docker container outlived the suite', code: 0 },
      { name: 'Assert no podman container outlived the suite', code: 0 },
    ]);
    expect(
      events.filter(({ command, args }) => command === 'bun' && args[0] === 'test')
    ).toHaveLength(4);
    expect(
      outcomes.some(({ code }) => code !== 0),
      'later successes retain the first failure'
    ).toBe(true);
  }, 15_000);

  test.each(['linux-x64', 'linux-arm64'])(
    'a broken %s binary assertion still reports both images and removes their containers',
    async (platform) => {
      const job = parseSmokeWorkflow(readText('.github/workflows/smoke-binary.yml')).jobs.binary;
      const matrix = smokeMatrixCases(job).find((entry) => entry.platform === platform);
      if (!matrix)
        throw new Error(`Missing ${platform} matrix case; expected a native Linux smoke leg`);
      const { outcomes, events, containers } = await runWorkflowSteps(job, matrix, 'binary');
      const assertions = outcomes.filter(({ name }) => name.includes('smoke test'));
      expect(assertions.map(({ code }) => code)).toEqual([9, 0, 0]);
      expect(
        events.filter(({ command, args }) => command === 'docker' && args[0] === 'run')
      ).toHaveLength(2);
      expect(containers, 'both Docker EXIT traps remove their fixed-port containers').toEqual([]);
      expect(
        outcomes.filter(({ name }) => name.includes('teardown')).map(({ code }) => code)
      ).toEqual([0, 0, 0]);
      expect(
        outcomes.some(({ code }) => code !== 0),
        'later successes retain the first failure'
      ).toBe(true);
    }
  );

  test('the manual fallback builds each image target once and runs every assertion', async () => {
    const job = parseSmokeWorkflow(readText('.github/workflows/smoke-binary.yml')).jobs.binary;
    const matrix = smokeMatrixCases(job).find(({ platform }) => platform === 'linux-arm64');
    if (!matrix)
      throw new Error('Missing linux-arm64 matrix case; expected a native Linux smoke leg');
    const { outcomes, events, containers } = await runWorkflowSteps(job, matrix, 'none', true);
    expect(outcomes.every(({ code }) => code === 0)).toBe(true);
    const builds = events.filter(
      ({ command, args }) => command === 'bun' && args.includes('build:binary')
    );
    // The binary smoke step already built the glibc target; only musl is new.
    const received = builds.map(({ args }) => args[args.indexOf('--platform') + 1]).join(', ');
    if (received !== 'linux-arm64-musl') {
      throw new Error(
        `expected the image steps to build only the target the binary smoke did not (linux-arm64-musl) | received: ${received}`
      );
    }
    expect(
      events.find(
        ({ command, args }) => command === 'bun' && args.includes('scripts/test-build.ts')
      )?.skipBuild
    ).toBe('0');
    expect(containers).toEqual([]);
  });

  test('the manual fallback rebuilds existing musl executables after the native glibc build succeeds', async () => {
    const job = parseSmokeWorkflow(readText('.github/workflows/smoke-binary.yml')).jobs.binary;
    const matrix = smokeMatrixCases(job).find(({ platform }) => platform === 'linux-arm64');
    if (!matrix)
      throw new Error('Missing linux-arm64 matrix case; expected a native Linux smoke leg');
    const { outcomes, events, containers } = await runWorkflowSteps(
      job,
      matrix,
      'none',
      true,
      [],
      [matrix.musl_platform]
    );
    const builds = events
      .filter(({ command, args }) => command === 'bun' && args.includes('build:binary'))
      .map(({ args }) => args[args.indexOf('--platform') + 1]);
    expect(builds, 'the native glibc completion marker cannot verify existing musl output').toEqual(
      [matrix.musl_platform]
    );
    expect(outcomes.every(({ code }) => code === 0)).toBe(true);
    expect(
      events.find(
        ({ command, args }) => command === 'bun' && args.includes('scripts/test-build.ts')
      )?.skipBuild
    ).toBe('0');
    expect(containers, 'both Docker EXIT traps remove their fixed-port containers').toEqual([]);
  });

  test.each([
    ['incomplete', 'binary'],
    ['rejected', 'rejected-native-build'],
  ] as const)(
    'the manual fallback rebuilds the glibc target for its image after the %s native build fails',
    async (_state, failure) => {
      const job = parseSmokeWorkflow(readText('.github/workflows/smoke-binary.yml')).jobs.binary;
      const matrix = smokeMatrixCases(job).find(({ platform }) => platform === 'linux-x64');
      if (!matrix)
        throw new Error('Missing linux-x64 matrix case; expected a native Linux smoke leg');
      // Incomplete builds leave only a runtime. Rejected builds leave both
      // executables but no successful-build README marker.
      const { outcomes, events, containers } = await runWorkflowSteps(job, matrix, failure, true);
      const builds = events
        .filter(({ command, args }) => command === 'bun' && args.includes('build:binary'))
        .map(({ args }) => args[args.indexOf('--platform') + 1])
        .join(', ');
      const images = outcomes
        .filter(({ name }) => name.includes('Docker smoke test'))
        .map(({ code }) => code)
        .join(', ');
      if (builds !== 'linux-x64, linux-x64-musl' || images !== '0, 0') {
        throw new Error(
          `expected both image targets built (linux-x64, linux-x64-musl) and both images passing (0, 0) | received: builds [${builds}], images [${images}]`
        );
      }
      expect(outcomes.find(({ name }) => name === 'Run binary smoke test')?.code).toBe(9);
      expect(
        outcomes.filter(({ name }) => name.includes('teardown')).map(({ code }) => code)
      ).toEqual([0, 0, 0]);
      expect(containers, 'both Docker EXIT traps remove their fixed-port containers').toEqual([]);
    }
  );
});

// The container job's steps are one line each; these run the scripts behind
// them directly, for the inputs a correct workflow never produces.
async function runContainerScript(
  script: string,
  env: (root: string) => Record<string, string>,
  leftovers: string[] = []
) {
  const fixture = stageWorkflowRun();
  for (const name of leftovers) writeFileSync(join(fixture.stateDir, name), 'running');
  const child = Bun.spawn([join(ROOT_DIR, 'scripts', 'release', script)], {
    cwd: join(fixture.root, 'apps', 'api'),
    env: {
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      FAKE_SMOKE_WORKFLOW_EVENTS: fixture.eventsPath,
      FAKE_SMOKE_WORKFLOW_STATE: fixture.stateDir,
      FAKE_SMOKE_WORKFLOW_FAILURE: 'none',
      ...env(fixture.root),
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const events = existsSync(fixture.eventsPath) ? readFileSync(fixture.eventsPath, 'utf8') : '';
  const commands = events
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CommandEvent)
    .map(({ command, args }) => [command, ...args].join(' '));
  return { stdout, stderr, code, commands };
}

describe.skipIf(process.platform === 'win32')('container smoke scripts', () => {
  const pairing = {
    CONTAINER_CLI: 'podman',
    BASE_IMAGE: 'alpine:3',
    PACKAGES: 'bash libstdc++',
    MANGO_CONTAINER_E2E_IMAGE: 'mango-container-smoke:musl',
    MANGO_CONTAINER_E2E_ENGINE: 'podman',
  };

  test('a pairing with packages builds its image, then inspects it and runs the suite', async () => {
    const { code, commands, stdout, stderr } = await runContainerScript(
      'smoke-container-pairing.sh',
      (root) => ({
        ...pairing,
        MANGO_CONTAINER_E2E_RUNTIME: join(root, '.mango/out/linux-x64-musl/mangostudio-runtime'),
      })
    );
    expect(code, `${stdout}${stderr}`).toBe(0);
    expect(commands).toEqual([
      'podman build -t mango-container-smoke:musl -',
      'podman image inspect mango-container-smoke:musl',
      'bun test tests/integration/services/connect-container-runtime.integration.test.ts',
    ]);
  });

  test('a pairing without packages tags the pulled base image unchanged', async () => {
    const { code, commands, stdout, stderr } = await runContainerScript(
      'smoke-container-pairing.sh',
      (root) => ({
        ...pairing,
        BASE_IMAGE: 'debian:bookworm-slim',
        PACKAGES: '',
        MANGO_CONTAINER_E2E_IMAGE: 'mango-container-smoke:glibc',
        MANGO_CONTAINER_E2E_RUNTIME: join(root, '.mango/out/linux-x64/mangostudio-runtime'),
      })
    );
    expect(code, `${stdout}${stderr}`).toBe(0);
    expect(commands.slice(0, 2)).toEqual([
      'podman pull debian:bookworm-slim',
      'podman tag debian:bookworm-slim mango-container-smoke:glibc',
    ]);
  });

  test('a pairing names the runtime path it could not execute and skips the suite', async () => {
    const { code, commands, stdout } = await runContainerScript(
      'smoke-container-pairing.sh',
      () => ({
        ...pairing,
        MANGO_CONTAINER_E2E_RUNTIME: '/nonexistent/mangostudio-runtime',
      })
    );
    expect(code).toBe(1);
    expect(stdout).toContain(
      "::error::expected MANGO_CONTAINER_E2E_RUNTIME: path of an executable runtime binary | received: '/nonexistent/mangostudio-runtime'"
    );
    expect(commands.filter((command) => command.startsWith('bun '))).toEqual([]);
  });

  test.each([
    ['CONTAINER_CLI', 'nerdctl', "expected CONTAINER_CLI: docker | podman | received: 'nerdctl'"],
    [
      'BASE_IMAGE',
      '',
      "expected BASE_IMAGE: an image reference such as debian:bookworm-slim | received: ''",
    ],
    [
      'MANGO_CONTAINER_E2E_IMAGE',
      '',
      "expected MANGO_CONTAINER_E2E_IMAGE: a tag such as mango-container-smoke:glibc | received: ''",
    ],
  ])('a pairing rejects %s=%p before it reaches the engine', async (name, value, message) => {
    const { code, commands, stdout } = await runContainerScript(
      'smoke-container-pairing.sh',
      () => ({
        ...pairing,
        MANGO_CONTAINER_E2E_RUNTIME: '/nonexistent/mangostudio-runtime',
        [name]: value,
      })
    );
    expect(code).toBe(1);
    expect(stdout).toContain(`::error::${message}`);
    expect(commands).toEqual([]);
  });

  test('the leak check names every container that outlived the grace period', async () => {
    const { code, commands, stdout } = await runContainerScript(
      'assert-no-leftover-containers.sh',
      () => ({ CONTAINER_CLI: 'docker' }),
      ['mango-rt-one', 'mango-rt-two', 'unrelated']
    );
    expect(code).toBe(1);
    // The engine lists them in its own order; one annotation carries both.
    const prefix = '::error::expected no mango-rt-* container left in docker | received: ';
    expect(stdout).toStartWith(prefix);
    expect(stdout.slice(prefix.length).trim().split(' ').sort()).toEqual([
      'mango-rt-one',
      'mango-rt-two',
    ]);
    expect(commands.filter((command) => command.startsWith('docker ps'))).toHaveLength(20);
  });

  test('the leak check passes on the first poll that finds no container', async () => {
    const { code, commands } = await runContainerScript(
      'assert-no-leftover-containers.sh',
      () => ({ CONTAINER_CLI: 'podman' }),
      ['unrelated']
    );
    expect(code).toBe(0);
    expect(commands).toEqual(['podman ps -a --format {{.Names}} --filter name=mango-rt-']);
  });

  test('the leak check rejects an engine it cannot ask', async () => {
    const { code, commands, stdout } = await runContainerScript(
      'assert-no-leftover-containers.sh',
      () => ({ CONTAINER_CLI: '' })
    );
    expect(code).toBe(1);
    expect(stdout).toContain("::error::expected CONTAINER_CLI: docker | podman | received: ''");
    expect(commands).toEqual([]);
  });
});
