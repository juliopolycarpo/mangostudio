import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixtureChildEnvironment } from './support/child-supervision';
import {
  disposeFixtureJob,
  FIXTURE_COMMAND_TIMEOUT_MS,
  type FixtureChild,
  type FixtureCommandHost,
  fixtureCommandHost,
  FixtureCommands,
  FixtureSettlementError,
} from './support/fixture-command';
import type { FixtureJob } from './support/fixture-windows-job';

class FailedWindowsCensusJob implements FixtureJob {
  readonly name = 'failed-census';
  readonly events: string[] = [];
  cleanupFails = false;
  empty(): boolean {
    this.events.push('census');
    throw new Error('original member census unavailable');
  }
  stop(): void {
    this.events.push('stop');
    if (this.cleanupFails) throw new Error('termination request failed');
  }
  close(): void {
    this.events.push('close');
    if (this.cleanupFails) throw new Error('handle disposal failed');
  }
}

class DelayedFixtureCommand implements FixtureCommandHost {
  stops = 0;
  deadlineMs = 0;
  private expire: () => void = () => undefined;
  private complete: (result: { stdout: string; stderr: string; exitCode: number }) => void = () =>
    undefined;
  private readonly completed = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve) => {
      this.complete = resolve;
    }
  );

  start(): FixtureChild {
    return {
      completed: this.completed,
      stop: () => {
        this.stops++;
      },
    };
  }

  deadline(callback: () => void, ms: number): () => void {
    this.expire = callback;
    this.deadlineMs = ms;
    return () => {
      this.expire = () => undefined;
    };
  }

  timeout(): void {
    this.expire();
  }
  close(): void {
    this.complete({ stdout: 'last output', stderr: '', exitCode: 1 });
  }
}

class FailedWindowsCleanupCommand extends DelayedFixtureCommand {
  constructor(readonly job: FailedWindowsCensusJob) {
    super();
  }
  override start(): FixtureChild {
    return {
      completed: Promise.resolve().then(() => {
        disposeFixtureJob(this.job);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      stop: () => this.job.stop(),
    };
  }
}

class UnverifiableFixtureCommand extends DelayedFixtureCommand {
  override start(): FixtureChild {
    return {
      completed: Promise.reject(
        new FixtureSettlementError('fixture census unavailable; storage retained')
      ),
      stop: () => undefined,
    };
  }
}

class FailedProcessCensus {
  settle(): Promise<never> {
    return Promise.reject(new Error('process table unavailable'));
  }
}

test('real command output preserves UTF-8 characters split across pipe reads', async () => {
  const commands = new FixtureCommands();
  try {
    const result = await commands.run(
      [process.execPath, join(import.meta.dir, 'support/split-utf8-fixture-command.ts')],
      import.meta.dir
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout, 'stdout: expected intact UTF-8 euro sign').toBe('€');
    expect(result.stderr, 'stderr: expected intact UTF-8 euro sign').toBe('€');
  } finally {
    await commands.settle();
  }
});

test.skipIf(process.platform === 'win32')(
  'a generic Unix census error retains real command storage ownership',
  async () => {
    const census = new FailedProcessCensus();
    const commands = new FixtureCommands({ ...fixtureCommandHost, settleUnix: census.settle });
    await expect(
      commands.run([process.execPath, '-e', 'process.exit(0)'], import.meta.dir)
    ).rejects.toThrow(
      'fixture process-group settlement failed; storage retained: Error: process table unavailable'
    );
    await expect(commands.settle()).rejects.toThrow('remains unsettled; storage retained');
  }
);

test('a failed settlement census refuses fixture storage cleanup', async () => {
  const commands = new FixtureCommands(new UnverifiableFixtureCommand());
  await expect(commands.run(['fake-check'], 'fixture')).rejects.toThrow(
    'fixture census unavailable'
  );
  await expect(commands.settle()).rejects.toThrow('fake-check remains unsettled; storage retained');
});

test('a timed-out fixture command retains storage ownership until its child closes', async () => {
  const host = new DelayedFixtureCommand();
  const commands = new FixtureCommands(host);
  const result = commands.run(['fake-check'], 'fixture');
  expect(host.deadlineMs).toBe(FIXTURE_COMMAND_TIMEOUT_MS);
  let returned = false;
  const observed = result.catch((error: Error) => {
    returned = true;
    return error.message;
  });
  host.timeout();
  let storageRemoved = false;
  const disposal = commands.settle().then(() => {
    storageRemoved = true;
  });
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  expect(host.stops).toBe(1);
  expect(returned, 'command must remain owned until child close').toBe(false);
  expect(storageRemoved, 'storage must survive while child is running').toBe(false);
  host.close();
  expect(await observed).toContain(`fake-check exceeded ${FIXTURE_COMMAND_TIMEOUT_MS}ms`);
  await disposal;
  expect(storageRemoved).toBe(true);
});

test('failed child settlement rejects cleanup and retains fixture storage', async () => {
  const host = new DelayedFixtureCommand();
  const commands = new FixtureCommands(host);
  const observed = commands.run(['fake-check'], 'fixture').catch((error: Error) => error.message);
  host.timeout();
  host.timeout();
  expect(await observed).toContain('did not settle within 5000ms after stop; storage retained');
  await expect(commands.settle()).rejects.toThrow('fake-check remains unsettled; storage retained');
  host.close();
});

test('a settled fixture command cancels its deadline and preserves captured output', async () => {
  const host = new DelayedFixtureCommand();
  const commands = new FixtureCommands(host);
  const result = commands.run(['fake-check'], 'fixture');
  host.close();
  expect(await result).toEqual({ stdout: 'last output', stderr: '', exitCode: 1 });
  host.timeout();
  expect(host.stops).toBe(0);
  await commands.settle();
});

test(
  'the real command deadline stops descendants before fixture storage is removed',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'mango-command-settlement-'));
    const commands = new FixtureCommands(undefined, 2_000);
    try {
      await expect(
        commands.run(
          [process.execPath, join(import.meta.dir, 'support/holding-fixture-command.ts')],
          root,
          fixtureChildEnvironment()
        )
      ).rejects.toThrow('exceeded 2000ms');
      expect(
        existsSync(join(root, 'ready')),
        'grandchild must reach its fixture directory before cancellation'
      ).toBe(true);
      await commands.settle();
      rmSync(root, { recursive: true });
      expect(existsSync(root)).toBe(false);
    } finally {
      await commands.settle();
      rmSync(root, { recursive: true, force: true });
    }
  },
  FIXTURE_COMMAND_TIMEOUT_MS + 5_000 + 5_000
);

test(
  'a root that exits with a closed-stdio descendant fails after that descendant settles',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'mango-command-orphan-'));
    const commands = new FixtureCommands();
    try {
      const result = await commands.run(
        [process.execPath, join(import.meta.dir, 'support/holding-fixture-command.ts'), 'orphan'],
        root,
        fixtureChildEnvironment()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('left running descendants; terminated and settled');
      await commands.settle();
      rmSync(root, { recursive: true });
      expect(existsSync(root)).toBe(false);
    } finally {
      await commands.settle();
      rmSync(root, { recursive: true, force: true });
    }
  },
  FIXTURE_COMMAND_TIMEOUT_MS + 5_000 + 5_000
);

test('failed Windows census disposes handles after termination while retaining storage', async () => {
  const job = new FailedWindowsCensusJob();
  const commands = new FixtureCommands(new FailedWindowsCleanupCommand(job));
  await expect(commands.run(['failed-census'], 'fixture')).rejects.toThrow(
    'original member census unavailable'
  );
  expect(job.events).toEqual(['census', 'stop', 'close']);
  await expect(commands.settle()).rejects.toThrow('remains unsettled; storage retained');
});

test('failed Windows census preserves its error when termination and disposal also fail', () => {
  const job = new FailedWindowsCensusJob();
  job.cleanupFails = true;
  expect(() => disposeFixtureJob(job)).toThrow(
    'original member census unavailable; cleanup errors: Error: termination request failed; Error: handle disposal failed'
  );
  expect(job.events).toEqual(['census', 'stop', 'close']);
});
