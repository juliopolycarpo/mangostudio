import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { settleBenchmarkWork } from '../bench/benchmark-child-scope';
import { assertBenchmarkPlatform } from '../bench/benchmark-platform';
import { runtimeVersion, RuntimeVersionError } from '../bench/runtime-version';
import {
  type NativeCommandReceipt,
  type NativeProcess,
  type NativeProcessCommandOptions,
  runNativeCommand,
  snapshotNativeProcesses,
} from '../lib/native-bun-qualification-process';
import { fixtureChildEnvironment } from './support/child-supervision';

async function retainedFailure(
  promise: Promise<string>,
  describeUnexpected?: () => string
): Promise<RuntimeVersionError> {
  let version: string;
  try {
    version = await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeVersionError);
    if (!(error instanceof RuntimeVersionError)) throw error;
    return error;
  }
  throw new Error(
    `version probe: expected RuntimeVersionError | received resolved version: ${JSON.stringify(version)}${describeUnexpected ? `; ${describeUnexpected()}` : ''}`
  );
}

test('unexpected version resolution reports the received value', async () => {
  await expect(retainedFailure(Promise.resolve('resolved-fixture-version'))).rejects.toThrow(
    'version probe: expected RuntimeVersionError | received resolved version: "resolved-fixture-version"'
  );
});

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

const VERSION_DESCENDANT_PROGRAM = `
import { join } from 'node:path';
const directory = process.env.VERSION_DESCENDANT_FIXTURE;
const { snapshotNativeProcesses, captureSnapshot } = await import(process.env.VERSION_PROCESS_MODULE);
class NativeSelfCensus {
  run = (_command, budget) => captureSnapshot(['ps', '-p', String(process.pid), '-o', 'pid=,ppid=,pgid=,lstart=,args='], budget);
}
const own = (await snapshotNativeProcesses({ platform: process.platform, findExecutable: (name) => Bun.which(name), capture: new NativeSelfCensus().run })).find((row) => row.pid === process.pid);
if (!own) throw new Error('version fixture: expected native self identity');
await Bun.write(join(directory, 'descendant-process.json'), JSON.stringify(own));
await Bun.write(join(directory, 'descendant-ready'), 'ready');
while (!(await Bun.file(join(directory, 'descendant-release')).exists())) await Bun.sleep(5);
`;

const VERSION_PARENT_PROGRAM = `#!/usr/bin/env bun
import { join } from 'node:path';
const directory = process.env.VERSION_DESCENDANT_FIXTURE;
const child = Bun.spawn([process.execPath, join(directory, 'descendant.ts')], {
  stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  env: { ...process.env, BUN_FEATURE_FLAG_NO_ORPHANS: '0' },
});
while (!(await Bun.file(join(directory, 'descendant-ready')).exists())) await Bun.sleep(5);
child.unref();
console.log('version');
`;

class ControlledVersionDescendant {
  readonly binary: string;
  private identity: Pick<NativeProcess, 'pid' | 'identity'> | undefined;

  constructor(
    readonly directory: string,
    private readonly host = {
      snapshot: snapshotNativeProcesses,
      kill: (pid: number) => process.kill(pid, 'SIGKILL'),
    }
  ) {
    this.binary = join(directory, 'version');
  }

  async create(): Promise<void> {
    await Bun.write(this.binary, VERSION_PARENT_PROGRAM);
    await Bun.write(join(this.directory, 'descendant.ts'), VERSION_DESCENDANT_PROGRAM);
    await chmod(this.binary, 0o755);
  }

  async observe(rows: readonly NativeProcess[]): Promise<NativeProcess | undefined> {
    const own = await this.readIdentity();
    return rows.find((process) => process.pid === own.pid && process.identity === own.identity);
  }

  private async readIdentity(): Promise<Pick<NativeProcess, 'pid' | 'identity'>> {
    if (this.identity) return this.identity;
    const value: unknown = JSON.parse(
      await readFile(join(this.directory, 'descendant-process.json'), 'utf8')
    );
    if (
      typeof value !== 'object' ||
      value === null ||
      !('pid' in value) ||
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      !('identity' in value) ||
      typeof value.identity !== 'string'
    )
      throw new Error(
        `version fixture identity: expected native pid and birth identity | received: ${JSON.stringify(value)}`
      );
    this.identity = { pid: value.pid, identity: value.identity };
    return this.identity;
  }

  async settle(): Promise<void> {
    await Bun.write(join(this.directory, 'descendant-release'), 'release');
    if (
      !this.identity &&
      (await Bun.file(join(this.directory, 'descendant-process.json')).exists())
    )
      await this.readIdentity();
    if (!this.identity) return;
    const deadline = performance.now() + 5_000;
    let row: NativeProcess | undefined;
    do {
      row = (await this.host.snapshot()).find(
        (process) => process.identity === this.identity?.identity
      );
      if (!row) return;
      try {
        this.host.kill(row.pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await Bun.sleep(20);
    } while (performance.now() < deadline);
    throw new Error(
      `version fixture cleanup: expected exited identity | received: ${row?.identity}; retained ${this.directory}`
    );
  }
}

async function settleVersionFixture(
  fixture: Pick<ControlledVersionDescendant, 'settle'>,
  pending: Promise<NativeCommandReceipt> | undefined,
  drain = settleBenchmarkWork
): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    await fixture.settle();
  } catch (error) {
    errors.push(error);
  }
  if (pending) {
    const error = await drain(pending, 5_000);
    if (error) errors.push(error);
  }
  return errors;
}

class ExitingDescendantHost {
  calls = 0;
  readonly row: NativeProcess = {
    pid: 12345,
    parentPid: 1,
    group: 12344,
    identity: '12345:fixture-birth',
    command: 'fixture',
  };
  readonly snapshot = (): Promise<NativeProcess[]> => Promise.resolve(this.calls ? [] : [this.row]);
  readonly kill = (_pid: number): never => {
    this.calls++;
    throw Object.assign(new Error('fixture exited after census'), { code: 'ESRCH' });
  };
}

test('descendant cleanup accepts exit between census and signal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-version-cleanup-'));
  const host = new ExitingDescendantHost();
  const fixture = new ControlledVersionDescendant(directory, host);
  try {
    await Bun.write(join(directory, 'descendant-process.json'), JSON.stringify(host.row));
    await fixture.settle();
    expect(host.calls).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class FailedDescendantCleanup {
  readonly error = Object.assign(new Error('fixture signal refused'), { code: 'EPERM' });
  readonly settle = (): Promise<void> => Promise.reject(this.error);
}

class SupervisorDrainWitness {
  drained = false;
  readonly pending = Promise.resolve(receipt());
  readonly drain = async (operation: Promise<unknown>, budget: number): Promise<string | null> => {
    expect(operation).toBe(this.pending);
    expect(budget).toBe(5_000);
    this.drained = true;
    return settleBenchmarkWork(operation, budget);
  };
}

test('descendant cleanup failure still drains the supervisor and retains its cause', async () => {
  const fixture = new FailedDescendantCleanup();
  const supervisor = new SupervisorDrainWitness();
  const errors = await settleVersionFixture(fixture, supervisor.pending, supervisor.drain);
  expect(supervisor.drained).toBe(true);
  expect(errors).toEqual([fixture.error]);
});

class FixtureVersionRunner {
  private started = false;
  private decisionHeld = false;
  home = '';
  pending: Promise<NativeCommandReceipt> | undefined;
  receipt: NativeCommandReceipt | undefined;
  before: NativeProcess | undefined;
  decision: NativeProcess | undefined;
  wrapperPid = 0;

  constructor(private readonly fixture: ControlledVersionDescendant) {}

  readonly describe = (): string =>
    JSON.stringify({
      retainedFixture: this.fixture.directory,
      probeHome: this.home,
      before: this.before ?? null,
      decision: this.decision ?? null,
      wrapperPid: this.wrapperPid,
    });

  readonly run = async (options: NativeProcessCommandOptions): Promise<NativeCommandReceipt> => {
    this.home = options.out;
    const original = options.snapshot;
    if (!original) throw new Error('version fixture: expected production snapshot callback');
    this.pending = runNativeCommand({
      ...options,
      env: fixtureChildEnvironment({
        ...options.env,
        VERSION_DESCENDANT_FIXTURE: this.fixture.directory,
        VERSION_PROCESS_MODULE: resolve(
          import.meta.dir,
          '../lib/native-bun-qualification-process.ts'
        ),
      }),
      snapshot: async () => {
        const decision = this.started && !this.decisionHeld;
        if (decision) {
          this.decisionHeld = true;
          const deadline = performance.now() + 5_000;
          while (!(await Bun.file(join(this.home, 'version-done')).exists())) {
            if (performance.now() >= deadline)
              throw new Error('version fixture: expected direct-child completion before decision');
            await Bun.sleep(5);
          }
          this.before = await this.fixture.observe(await snapshotNativeProcesses());
          this.wrapperPid = Number(await readFile(join(this.home, 'version-wrapper-pid'), 'utf8'));
          // The old fixture's 2200 ms timer expires while this decision census is held.
          await Bun.sleep(2300);
        }
        const rows = await original();
        if (decision) {
          this.decision = await this.fixture.observe(rows);
          await Bun.write(
            join(this.fixture.directory, 'decision.json'),
            JSON.stringify({
              before: this.before ?? null,
              decision: this.decision ?? null,
              wrapperPid: this.wrapperPid,
            })
          );
        }
        this.started ||= await Bun.file(join(this.home, 'version-start')).exists();
        return rows;
      },
    });
    this.receipt = await this.pending;
    return this.receipt;
  };
}

test.skipIf(process.platform === 'win32')(
  'real fast child with a live same-group descendant retains its home',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-version-descendant-'));
    const fixture = new ControlledVersionDescendant(directory);
    await fixture.create();
    const runner = new FixtureVersionRunner(fixture);
    let passed = false;
    let primary: Error | undefined;
    let cleanupErrors: unknown[];
    try {
      const error = await retainedFailure(
        runtimeVersion(fixture.binary, new AbortController().signal, { run: runner.run }),
        runner.describe
      );
      expect(
        runner.before,
        `version fixture: expected live descendant before held census; retained ${directory}`
      ).toBeDefined();
      expect(
        runner.decision,
        `version fixture: expected live descendant at decision; retained ${directory}`
      ).toBeDefined();
      expect(runner.decision?.identity).toBe(runner.before?.identity);
      expect(runner.describe()).toContain(runner.before?.identity ?? 'missing-native-identity');
      expect(runner.decision?.group).toBe(runner.wrapperPid);
      expect(error.commandReceipt?.settlement.rootObserved).toBe(true);
      expect(error.message).toContain('surviving same-group descendants');
      expect(error.commandReceipt?.settlement.empty).toBe(true);
      expect(error.settlement).toBe('confirmed');
      expect(await stat(error.home)).toBeDefined();
      passed = true;
    } catch (error) {
      primary = error instanceof Error ? error : new Error(String(error), { cause: error });
    } finally {
      cleanupErrors = await settleVersionFixture(fixture, runner.pending);
      const settled = runner.receipt?.settlement.empty && runner.receipt.settlement.rootObserved;
      if (!cleanupErrors.length && runner.home && settled)
        await rm(runner.home, { recursive: true, force: true });
      if (!cleanupErrors.length && passed && settled)
        await rm(directory, { recursive: true, force: true });
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        primary === undefined ? cleanupErrors : [primary, ...cleanupErrors],
        `version fixture cleanup: expected settled child and supervisor; retained ${directory}`
      );
    if (primary !== undefined) throw primary;
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

test('an already canceled version probe never invokes its supervisor', async () => {
  class UnstartedSupervisor {
    calls = 0;
    readonly run = (_options: NativeProcessCommandOptions): Promise<NativeCommandReceipt> => {
      this.calls++;
      return Promise.resolve(receipt());
    };
  }
  const supervisor = new UnstartedSupervisor();
  const controller = new AbortController();
  controller.abort(new Error('before launch cancellation'));
  const error = await retainedFailure(
    runtimeVersion('unstarted', controller.signal, { platform: 'linux', run: supervisor.run })
  );
  try {
    expect(error.message).toContain('before launch cancellation');
    expect(supervisor.calls).toBe(0);
  } finally {
    await rm(error.home, { recursive: true, force: true });
  }
});

test('cancellation bounds a version read that has not settled', async () => {
  class HeldVersionReader {
    private begin!: () => void;
    private reject!: (error: Error) => void;
    readonly started = new Promise<void>((resolve) => {
      this.begin = resolve;
    });
    readonly result = new Promise<string>((_resolve, reject) => {
      this.reject = reject;
    });
    readonly read = (_path: string): Promise<string> => {
      this.begin();
      return this.result;
    };
    async release(): Promise<void> {
      this.reject(new Error('controlled late read failure'));
      await this.result.catch(() => {});
    }
  }
  const reader = new HeldVersionReader();
  const base = receipt();
  const supervisor = new ReceiptSupervisor({
    ...base,
    settlement: { ...base.settlement, rootObserved: true },
  });
  const controller = new AbortController();
  const pending = runtimeVersion('held-read', controller.signal, {
    platform: 'linux',
    run: supervisor.run,
    readVersion: reader.read,
    cleanupMs: 5,
  });
  let failure: RuntimeVersionError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(await settleBenchmarkWork(reader.started, 2_000)).toBeNull();
    controller.abort(new Error('held read cancellation'));
    const observed = await Promise.race([
      retainedFailure(pending),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 50);
      }),
    ]);
    expect(observed).not.toBeNull();
    if (!observed) return;
    failure = observed;
    expect(failure.message).toContain('held read cancellation');
    expect(await stat(failure.home)).toBeDefined();
  } finally {
    if (timer) clearTimeout(timer);
    await reader.release();
    failure ??= await retainedFailure(pending);
    await rm(failure.home, { recursive: true, force: true });
  }
});
