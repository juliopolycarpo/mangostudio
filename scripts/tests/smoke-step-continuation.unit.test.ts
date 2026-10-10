import { afterEach, describe, expect, test } from 'bun:test';
import {
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

function stageWorkflowRun() {
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
  return { root, fakeBin, stateDir, eventsPath: join(root, 'commands.jsonl') };
}

async function runWorkflowSteps(
  job: SmokeJob,
  matrix: Record<string, string>,
  failure: 'binary' | 'container' | 'ports' | 'none',
  rebuild = false
) {
  const fixture = stageWorkflowRun();
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

  test('the manual fallback rebuilds both image targets and runs every assertion', async () => {
    const job = parseSmokeWorkflow(readText('.github/workflows/smoke-binary.yml')).jobs.binary;
    const matrix = smokeMatrixCases(job).find(({ platform }) => platform === 'linux-arm64');
    if (!matrix)
      throw new Error('Missing linux-arm64 matrix case; expected a native Linux smoke leg');
    const { outcomes, events, containers } = await runWorkflowSteps(job, matrix, 'none', true);
    expect(outcomes.every(({ code }) => code === 0)).toBe(true);
    const builds = events.filter(
      ({ command, args }) => command === 'bun' && args.includes('build:binary')
    );
    expect(builds.map(({ args }) => args[args.indexOf('--platform') + 1])).toEqual([
      'linux-arm64',
      'linux-arm64-musl',
    ]);
    expect(
      events.find(
        ({ command, args }) => command === 'bun' && args.includes('scripts/test-build.ts')
      )?.skipBuild
    ).toBe('0');
    expect(containers).toEqual([]);
  });
});
