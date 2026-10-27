import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertBenchmarkPlatform } from '../bench/benchmark-platform';
import { runtimeVersion, RuntimeVersionError } from '../bench/runtime-version';
import type {
  NativeCommandReceipt,
  NativeProcessCommandOptions,
} from '../lib/native-bun-qualification-process';

async function retainedFailure(promise: Promise<string>): Promise<RuntimeVersionError> {
  try {
    await promise;
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeVersionError);
    if (!(error instanceof RuntimeVersionError)) throw error;
    return error;
  }
}

class HeldSupervisor {
  private reject!: (error: Error) => void;
  readonly result = new Promise<NativeCommandReceipt>((_resolve, reject) => {
    this.reject = reject;
  });
  readonly run = (_options: NativeProcessCommandOptions): Promise<NativeCommandReceipt> =>
    this.result;
  async release(): Promise<void> {
    this.reject(new Error('late rejection'));
    await this.result.catch(() => {});
  }
}

class ReceiptSupervisor {
  constructor(readonly receipt: NativeCommandReceipt) {}
  readonly run = (_options: NativeProcessCommandOptions): Promise<NativeCommandReceipt> =>
    Promise.resolve(this.receipt);
}

function receipt(): NativeCommandReceipt {
  return {
    label: 'runtime-version',
    command: ['fake', '--version'],
    environment: {},
    startedAt: '',
    finishedAt: '',
    durationMs: 0,
    exitCode: 0,
    signal: null,
    timedOut: false,
    timeoutSeconds: 15,
    errors: [],
    log: '',
    settlement: {
      scope: 'observed descendants and command process group',
      pollIntervalMs: 20,
      rootObserved: false,
      observed: [],
      survivors: [],
      snapshotErrors: [],
      pollErrors: [],
      empty: true,
    },
  };
}

describe('runtime version ownership', () => {
  test.skipIf(process.platform === 'win32')(
    'real fast command returns version after direct exit and empty scope',
    async () => {
      expect(await runtimeVersion(process.execPath, new AbortController().signal)).toBeTruthy();
    }
  );

  test.skipIf(process.platform === 'win32')(
    'real hanging executable is canceled after its start marker and retains its home',
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'runtime-version-test-'));
      const path = join(fixture, 'hang');
      await Bun.write(
        path,
        '#!/usr/bin/env bun\nawait Bun.write(process.env.MANGO_HOME + "/started", String(process.pid));\nsetInterval(() => {}, 1000);\n'
      );
      await chmod(path, 0o755);
      // The executable writes in its isolated home. The named runner exposes that path to the test.
      let home = '';
      const { runNativeCommand } = await import('../lib/native-bun-qualification-process');
      class StartMarkerRunner {
        readonly run = (options: NativeProcessCommandOptions) => {
          home = options.out;
          return runNativeCommand(options);
        };
      }
      const controller = new AbortController();
      const pending = runtimeVersion(path, controller.signal, {
        cleanupMs: 3000,
        run: new StartMarkerRunner().run,
      });
      let failure: RuntimeVersionError | undefined;
      try {
        const deadline = Date.now() + 3000;
        while (
          (!home || !(await Bun.file(join(home, 'started')).exists())) &&
          Date.now() < deadline
        )
          await Bun.sleep(10);
        expect(home && (await Bun.file(join(home, 'started')).exists())).toBe(true);
        expect(Number(await Bun.file(join(home, 'started')).text())).toBeGreaterThan(0);
        controller.abort(new Error('test cancellation'));
        failure = await retainedFailure(pending);
        expect(failure.safeToRemove).toBe(false);
        expect(failure.commandReceipt?.settlement.empty).toBe(true);
        expect(failure.commandReceipt).not.toBeNull();
        expect(
          failure.commandReceipt &&
            (failure.commandReceipt.exitCode !== null || failure.commandReceipt.signal !== null)
        ).toBe(true);
        expect(await stat(failure.home)).toBeDefined();
      } finally {
        controller.abort();
        if (!failure) {
          try {
            await pending;
          } catch (error) {
            if (error instanceof RuntimeVersionError) failure = error;
          }
        }
        if (failure?.commandReceipt?.settlement.empty)
          await rm(failure.home, { recursive: true, force: true });
        await rm(fixture, { recursive: true, force: true });
      }
    }
  );

  test('held supervisor is bounded and its home remains owned', async () => {
    const fake = new HeldSupervisor();
    const failure = await retainedFailure(
      runtimeVersion('held', new AbortController().signal, {
        platform: 'linux',
        run: fake.run,
        timeoutMs: 5,
        cleanupMs: 5,
      })
    );
    try {
      expect(failure.settlement).toBe('unconfirmed');
      expect(failure.commandReceipt).toBeNull();
      expect(await stat(failure.home)).toBeDefined();
    } finally {
      await fake.release();
      await rm(failure.home, { recursive: true, force: true });
    }
  });
});

test('named receipt fake refuses failed, incomplete, and poll-error results', async () => {
  const base = receipt();
  const failures: NativeCommandReceipt[] = [
    { ...base, exitCode: 1 },
    { ...base, errors: ['Owned process output pipes did not close after command exit'] },
    { ...base, settlement: { ...base.settlement, empty: false } },
    { ...base, settlement: { ...base.settlement, pollErrors: ['census failed'] } },
  ];
  for (const result of failures) {
    const error = await retainedFailure(
      runtimeVersion('fake', new AbortController().signal, {
        platform: 'linux',
        run: new ReceiptSupervisor(result).run,
      })
    );
    try {
      expect(error.commandReceipt).toBe(result);
      expect(error.message).toContain('received:');
      expect(error.safeToRemove).toBe(false);
      expect(await stat(error.home)).toBeDefined();
    } finally {
      await rm(error.home, { recursive: true, force: true });
    }
  }
});

test('invalid deadline options fail before launching the supervisor', async () => {
  const fake = new ReceiptSupervisor(receipt());
  for (const [name, value] of [
    ['timeoutMs', 0],
    ['cleanupMs', Infinity],
  ] as const) {
    await expect(
      runtimeVersion('fake', new AbortController().signal, {
        platform: 'linux',
        run: fake.run,
        [name]: value,
      })
    ).rejects.toThrow(`${name}: expected positive finite milliseconds | received: ${value}`);
  }
});

test('unobserved fast root is refused before accepting empty scope', async () => {
  class UnobservedRunner {
    readonly run = async (options: NativeProcessCommandOptions): Promise<NativeCommandReceipt> => {
      await Bun.write(join(options.out, 'logs', 'runtime-version.stdout.log'), 'version');
      return receipt();
    };
  }
  const error = await retainedFailure(
    runtimeVersion('fake', new AbortController().signal, {
      platform: 'linux',
      run: new UnobservedRunner().run,
    })
  );
  try {
    expect(error.message).toContain('rootObserved');
    expect(error.settlement).toBe('unconfirmed');
  } finally {
    await rm(error.home, { recursive: true, force: true });
  }
});

test('cancellation during version read retains home and preserves abort reason', async () => {
  const controller = new AbortController();
  const base = receipt();
  class SuccessfulRunner {
    readonly run = async (options: NativeProcessCommandOptions): Promise<NativeCommandReceipt> => {
      await Bun.write(join(options.out, 'logs', 'runtime-version.stdout.log'), 'version');
      return { ...base, settlement: { ...base.settlement, rootObserved: true } };
    };
  }
  class CancelingReader {
    readonly read = (_path: string): Promise<string> => {
      controller.abort(new Error('read cancellation'));
      return Promise.resolve('version');
    };
  }
  const error = await retainedFailure(
    runtimeVersion('fake', controller.signal, {
      platform: 'linux',
      run: new SuccessfulRunner().run,
      readVersion: new CancelingReader().read,
    })
  );
  try {
    expect(error.message).toContain('read cancellation');
    expect(await stat(error.home)).toBeDefined();
  } finally {
    await rm(error.home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'real fast child with a live same-group descendant retains its home',
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'runtime-version-descendant-'));
    const path = join(fixture, 'version');
    await Bun.write(
      path,
      `#!/usr/bin/env bun\nconst child = Bun.spawn([process.execPath, '-e', "await Bun.write(process.env.MANGO_HOME + '/descendant-ready', 'ready'); setTimeout(() => {}, 2200)"], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });\nawait Bun.write(process.env.MANGO_HOME + '/descendant-pid', String(child.pid));\nwhile (!(await Bun.file(process.env.MANGO_HOME + '/descendant-ready').exists())) await Bun.sleep(5);\nchild.unref();\nconsole.log('version');\n`
    );
    await chmod(path, 0o755);
    let error: RuntimeVersionError | undefined;
    try {
      error = await retainedFailure(runtimeVersion(path, new AbortController().signal));
      expect(error.commandReceipt?.settlement.rootObserved).toBe(true);
      const pid = Number(await Bun.file(join(error.home, 'descendant-pid')).text());
      expect(pid).toBeGreaterThan(0);
      expect(error.message).toContain('surviving same-group descendants');
      expect(error.commandReceipt?.settlement.empty).toBe(true);
      expect(error.settlement).toBe('confirmed');
    } finally {
      if (error) {
        const pid = Number(await Bun.file(join(error.home, 'descendant-pid')).text());
        const { snapshotNativeProcesses } = await import('../lib/native-bun-qualification-process');
        const deadline = Date.now() + 5000;
        while (
          (await snapshotNativeProcesses()).some((process) => process.pid === pid) &&
          Date.now() < deadline
        )
          await Bun.sleep(25);
        if (!(await snapshotNativeProcesses()).some((process) => process.pid === pid))
          await rm(error.home, { recursive: true, force: true });
      }
      await rm(fixture, { recursive: true, force: true });
    }
  }
);

test('Windows admission refuses before allocating or invoking a command', async () => {
  class UnexpectedRunner {
    calls = 0;
    readonly run = (_options: NativeProcessCommandOptions): Promise<NativeCommandReceipt> => {
      this.calls++;
      return Promise.resolve(receipt());
    };
  }
  const runner = new UnexpectedRunner();
  await expect(
    runtimeVersion('fake', new AbortController().signal, { platform: 'win32', run: runner.run })
  ).rejects.toThrow('expected POSIX process-group containment | received: win32');
  expect(runner.calls).toBe(0);
});

test('platform admission accepts POSIX and rejects Windows', () => {
  expect(() => assertBenchmarkPlatform('linux')).not.toThrow();
  expect(() => assertBenchmarkPlatform('darwin')).not.toThrow();
  expect(() => assertBenchmarkPlatform('win32')).toThrow('received: win32');
});
