import { describe, expect, it } from 'bun:test';
import type { ContainerEnvironmentConfig } from '@mangostudio/shared/environments';
import {
  classifyContainerFailure,
  describeContainerFailure,
} from '../../../../src/modules/environments/domain/container-failure';
import {
  ContainerEngineError,
  createContainerEngineService,
  platformFromProbe,
} from '../../../../src/modules/environments/infrastructure/container-engine';

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

interface StubReply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly spawnErrorCode?: string;
  readonly timedOut?: boolean;
}

/**
 * Answers engine calls by the subcommand they run, so a test states what the
 * engine knows rather than the order it is asked in.
 */
function engineStub(replies: Record<string, StubReply | readonly StubReply[]>) {
  const calls: RecordedCall[] = [];
  const remaining = new Map<string, StubReply[]>(
    Object.entries(replies).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value],
    ])
  );

  const run = (command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] });
    const key = args[0] === 'image' ? 'inspect' : (args[0] ?? '');
    const queue = remaining.get(key);
    const reply = (queue && queue.length > 1 ? queue.shift() : queue?.[0]) ?? {};
    return Promise.resolve({
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      exitCode: reply.exitCode === undefined ? 0 : reply.exitCode,
      ...(reply.spawnErrorCode ? { spawnErrorCode: reply.spawnErrorCode } : {}),
      ...(reply.timedOut ? { timedOut: true } : {}),
    });
  };

  return { run, calls, subcommands: () => calls.map((call) => call.args[0]) };
}

const GLIBC_PROBE = 'Linux\nx86_64\nldd (Debian GLIBC 2.36-9) 2.36\n';
const MUSL_PROBE = 'Linux\nx86_64\nmusl libc (x86_64)\n';
const config: ContainerEnvironmentConfig = { image: 'node:22' };

describe('platformFromProbe', () => {
  it.each([
    ['Linux\nx86_64\nldd (GNU libc) 2.36', 'linux-x64'],
    ['Linux\naarch64\nldd (GNU libc) 2.36', 'linux-arm64'],
    ['Linux\nx86_64\nmusl libc (x86_64)', 'linux-x64-musl'],
    ['Linux\naarch64\nmusl libc (aarch64)', 'linux-arm64-musl'],
  ])('resolves %p', (stdout, expected) => {
    expect(platformFromProbe(stdout)).toBe(expected as never);
  });

  it('refuses a non-Linux kernel, which means Windows container mode', () => {
    expect(platformFromProbe('Darwin\narm64\n')).toBeNull();
  });

  it('refuses an architecture no runtime is built for', () => {
    expect(platformFromProbe('Linux\nriscv64\nldd (GNU libc) 2.36')).toBeNull();
  });

  it('refuses output that is not a probe at all', () => {
    expect(platformFromProbe('')).toBeNull();
  });
});

describe('container engine detection', () => {
  it('reports an engine that answers, with its version', async () => {
    const stub = engineStub({ version: { stdout: '29.7.1\n' } });
    const detection = await createContainerEngineService({ run: stub.run }).detect();

    expect(detection.available).toBe(true);
    expect(detection.engines).toEqual([
      { engine: 'docker', available: true, version: '29.7.1' },
      { engine: 'podman', available: true, version: '29.7.1' },
    ]);
  });

  it('separates an engine that is absent from one that will not answer', async () => {
    const service = createContainerEngineService({
      run: (command) =>
        Promise.resolve(
          command === 'docker'
            ? {
                stdout: '',
                stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
                exitCode: 1,
              }
            : { stdout: '', stderr: '', exitCode: null, spawnErrorCode: 'ENOENT' }
        ),
    });
    const detection = await service.detect();

    expect(detection.available).toBe(false);
    expect(detection.engines).toEqual([
      { engine: 'docker', available: false, reason: 'engine-unreachable' },
      { engine: 'podman', available: false, reason: 'engine-missing' },
    ]);
  });
});

describe('container image preparation', () => {
  it('probes an image the engine already holds, without pulling', async () => {
    const stub = engineStub({ inspect: { stdout: 'sha256:aaa' }, run: { stdout: GLIBC_PROBE } });
    let pulled = false;

    const platform = await createContainerEngineService({ run: stub.run }).prepare(config, {
      onPullStart: () => {
        pulled = true;
      },
    });

    expect(platform).toBe('linux-x64');
    expect(pulled).toBe(false);
    expect(stub.subcommands()).not.toContain('pull');
  });

  it('pulls a missing image and reports the wait before it starts', async () => {
    const stub = engineStub({
      inspect: [
        { stderr: 'Error response from daemon: No such image: node:22', exitCode: 1 },
        { stdout: 'sha256:aaa' },
      ],
      pull: { stdout: 'Status: Downloaded newer image' },
      run: { stdout: GLIBC_PROBE },
    });
    const phases: string[] = [];

    const platform = await createContainerEngineService({ run: stub.run }).prepare(config, {
      onPullStart: () => phases.push('pulling'),
    });

    expect(platform).toBe('linux-x64');
    expect(phases).toEqual(['pulling']);
    expect(stub.subcommands()).toEqual(['image', 'pull', 'image', 'run']);
  });

  it('resolves a musl image to the musl build', async () => {
    const stub = engineStub({ inspect: { stdout: 'sha256:bbb' }, run: { stdout: MUSL_PROBE } });
    const platform = await createContainerEngineService({ run: stub.run }).prepare(config);

    expect(platform).toBe('linux-x64-musl');
  });

  it('serves a second connect from cache without starting a container', async () => {
    const stub = engineStub({ inspect: { stdout: 'sha256:aaa' }, run: { stdout: GLIBC_PROBE } });
    const service = createContainerEngineService({ run: stub.run });

    await service.prepare(config);
    await service.prepare(config);

    // Two inspects — that check is local and cheap, and it is what notices a
    // re-pull — but only one container start.
    expect(stub.subcommands().filter((name) => name === 'run')).toHaveLength(1);
    expect(stub.subcommands().filter((name) => name === 'image')).toHaveLength(2);
  });

  it('re-probes when the same tag now names different bytes', async () => {
    const stub = engineStub({
      inspect: [{ stdout: 'sha256:aaa' }, { stdout: 'sha256:zzz' }],
      run: [{ stdout: GLIBC_PROBE }, { stdout: MUSL_PROBE }],
    });
    const service = createContainerEngineService({ run: stub.run });

    expect(await service.prepare(config)).toBe('linux-x64');
    // The cache is keyed by the id the inspect returned, so a re-pulled tag
    // misses it by construction rather than by an invalidation rule.
    expect(await service.prepare(config)).toBe('linux-x64-musl');
  });

  it('keeps separate answers for the same image under each engine', async () => {
    const stub = engineStub({
      inspect: { stdout: 'sha256:aaa' },
      run: [{ stdout: GLIBC_PROBE }, { stdout: MUSL_PROBE }],
    });
    const service = createContainerEngineService({ run: stub.run });

    expect(await service.prepare(config)).toBe('linux-x64');
    expect(await service.prepare({ ...config, engine: 'podman' })).toBe('linux-x64-musl');
  });

  it('refuses an image with no shell as unsupported', async () => {
    const stub = engineStub({
      inspect: { stdout: 'sha256:ccc' },
      run: {
        stderr: 'exec: "sh": executable file not found in $PATH: unknown',
        exitCode: 127,
      },
    });

    const attempt = createContainerEngineService({ run: stub.run }).prepare(config);
    await expect(attempt).rejects.toBeInstanceOf(ContainerEngineError);
    await expect(attempt).rejects.toThrow(/has no shell/);
  });

  it('refuses a probe that answers with an unusable platform', async () => {
    const stub = engineStub({
      inspect: { stdout: 'sha256:ddd' },
      run: { stdout: 'Linux\nriscv64\nldd (GNU libc) 2.36\n' },
    });

    await expect(createContainerEngineService({ run: stub.run }).prepare(config)).rejects.toThrow(
      /Could not tell which platform/
    );
  });

  it('reaps a probe container that outlived execFile’s own timeout', async () => {
    const stub = engineStub({
      inspect: { stdout: 'sha256:eee' },
      run: { exitCode: null, timedOut: true },
    });

    const attempt = createContainerEngineService({ run: stub.run }).prepare(config);
    await expect(attempt).rejects.toBeInstanceOf(ContainerEngineError);

    const probeCall = stub.calls.find((call) => call.args[0] === 'run');
    const killCall = stub.calls.find((call) => call.args[0] === 'kill');
    const probeName = probeCall?.args[probeCall.args.indexOf('--name') + 1];

    expect(probeName).toMatch(/^mango-rt-probe-/);
    expect(killCall?.args).toEqual(['kill', probeName as string]);
  });

  it('reports a daemon that will not answer rather than a missing image', async () => {
    const stub = engineStub({
      inspect: {
        stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
        exitCode: 1,
      },
    });

    const attempt = createContainerEngineService({ run: stub.run }).prepare(config);
    await expect(attempt).rejects.toThrow(/did not answer/);
    // The pull is never attempted: nothing about a dead daemon is fixed by it.
    expect(stub.subcommands()).not.toContain('pull');
  });

  it('reports a pull that could not finish', async () => {
    const stub = engineStub({
      inspect: { stderr: 'Error: node:22: image not known', exitCode: 1 },
      pull: { stderr: 'toomanyrequests: You have reached your pull rate limit.', exitCode: 1 },
    });

    await expect(createContainerEngineService({ run: stub.run }).prepare(config)).rejects.toThrow(
      /did not finish/
    );
  });

  it('reports a pull that overran its output buffer as unfinished, not as a missing engine', async () => {
    const stub = engineStub({
      inspect: { stderr: 'Error: node:22: image not known', exitCode: 1 },
      pull: {
        stderr: 'Downloading [=====>] 40%',
        exitCode: null,
        spawnErrorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      },
    });

    const attempt = createContainerEngineService({ run: stub.run }).prepare(config);
    await expect(attempt).rejects.toBeInstanceOf(ContainerEngineError);
    await expect(attempt).rejects.toMatchObject({ reason: 'image-pull-failed' });
    await expect(attempt).rejects.toThrow(/did not finish/);
  });
});

describe('container teardown', () => {
  it('kills by the container name and swallows an already-gone container', async () => {
    const stub = engineStub({
      kill: { stderr: 'Error response from daemon: No such container', exitCode: 1 },
    });

    await createContainerEngineService({ run: stub.run }).kill('docker', 'mango-rt-sandbox-abc');

    expect(stub.calls).toEqual([{ command: 'docker', args: ['kill', 'mango-rt-sandbox-abc'] }]);
  });
});

describe('classifyContainerFailure', () => {
  it.each([
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock', 'engine-unreachable'],
    ['permission denied while trying to connect to the Docker daemon socket', 'engine-unreachable'],
    ['Cannot connect to Podman. Please verify the connection', 'engine-unreachable'],
    ['Error response from daemon: No such image: node:22', 'image-missing'],
    ['Error: nonexistent:x: image not known', 'image-missing'],
    ['pull access denied for private/thing, repository does not exist', 'image-missing'],
    ['manifest for node:99 not found: manifest unknown', 'image-missing'],
    ['toomanyrequests: You have reached your pull rate limit', 'image-pull-failed'],
    ['net/http: TLS handshake timeout', 'image-pull-failed'],
    ['exec: "sh": executable file not found in $PATH: unknown', 'image-unsupported'],
    ['unable to start container process: exec: "sh"', 'image-unsupported'],
  ])('reads %p as %s', (stderr, expected) => {
    expect(classifyContainerFailure({ stderr, exitCode: 1 })).toBe(expected as never);
  });

  it('reads a spawn ENOENT as a missing engine, whatever stderr says', () => {
    expect(classifyContainerFailure({ stderr: '', exitCode: null, spawnErrorCode: 'ENOENT' })).toBe(
      'engine-missing'
    );
  });

  it('falls back to unknown rather than guessing', () => {
    expect(classifyContainerFailure({ stderr: 'something nobody has seen', exitCode: 7 })).toBe(
      'unknown'
    );
  });

  it('keeps the engine output on an unknown failure, where it is the only account', () => {
    const message = describeContainerFailure('unknown', {
      engine: 'podman',
      image: 'node:22',
      stderr: 'something nobody has seen',
    });
    expect(message).toContain('podman');
    expect(message).toContain('something nobody has seen');
  });

  it('names the engine that refused, so a machine with both says which', () => {
    expect(
      describeContainerFailure('engine-missing', {
        engine: 'podman',
        image: 'node:22',
        stderr: '',
      })
    ).toContain('podman');
  });
});
