import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildExternalAgentEnvironment,
  type ExternalAgentManagedProcess,
  killWindowsProcessTree,
  spawnExternalAgentProcess,
  terminateWindowsProcessTree,
} from '../../../src/services/external-agents/process';
import { windowsTaskkillArguments } from '../../../src/services/process-tree';

const fixture = resolve(import.meta.dir, '../../support/external-agent-fixture.ts');
const active: ExternalAgentManagedProcess[] = [];

afterEach(async () => {
  await Promise.all(active.splice(0).map((child) => child.terminate({ graceMs: 10 })));
});

function spawnFixture(
  mode: string,
  options: Partial<Parameters<typeof spawnExternalAgentProcess>[0]> = {}
) {
  const child = spawnExternalAgentProcess({
    argv: [process.execPath, fixture, '--mode', mode],
    cwd: process.cwd(),
    ...options,
  });
  active.push(child);
  return child;
}

describe('external agent process environment', () => {
  it('keeps only the positive base and adapter allowlists', () => {
    expect(
      buildExternalAgentEnvironment(
        {
          PATH: '/bin',
          HOME: '/home/ada',
          LANG: 'en_US.UTF-8',
          LC_MESSAGES: 'pt_BR.UTF-8',
          CONNECTOR_SECRET: 'never-forward-this',
          VENDOR_CONFIG: 'adapter-owned',
        },
        ['VENDOR_CONFIG']
      )
    ).toEqual({
      PATH: '/bin',
      HOME: '/home/ada',
      LANG: 'en_US.UTF-8',
      LC_MESSAGES: 'pt_BR.UTF-8',
      VENDOR_CONFIG: 'adapter-owned',
    });
  });

  it('does not forward a connector secret to the child', async () => {
    const child = spawnFixture('environment', {
      envSource: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CONNECTOR_SECRET: 'never-forward-this',
      },
    });

    const record = await child.stdout.next(1_000);
    expect(record.kind).toBe('line');
    const environment = JSON.parse(record.kind === 'line' ? record.line : '{}') as Record<
      string,
      string
    >;
    expect(environment.CONNECTOR_SECRET).toBeUndefined();
  });
});

describe('external agent line framing', () => {
  it('holds a partial line across chunk boundaries', async () => {
    const child = spawnFixture('partial');

    expect(await child.stdout.next(1_000)).toEqual({ kind: 'line', line: 'first line' });
    expect(await child.stdout.next(1_000)).toEqual({ kind: 'line', line: 'second' });
  });

  it('rejects a line past its byte cap', async () => {
    const child = spawnFixture('oversized', { maxLineBytes: 16 });

    await expect(child.stdout.next(1_000)).rejects.toThrow('16-byte line limit');
  });

  it('rejects aggregate queued output past its buffer cap', async () => {
    const child = spawnFixture('buffered', { maxLineBytes: 32, maxBufferedBytes: 8 });

    await expect(child.stdout.next(1_000)).rejects.toThrow('8-byte buffer limit');
  });

  it('bounds and redacts the stderr tail', async () => {
    const child = spawnFixture('stderr', { maxStderrBytes: 96 });

    await child.exit;
    expect(child.stderrTail()).not.toContain('top-secret');
    expect(child.stderrTail()).not.toContain('another-secret');
    expect(child.stderrTail()).not.toContain('password@');
    expect(child.stderrTail()).toContain('[REDACTED]');
    expect(Buffer.byteLength(child.stderrTail())).toBeLessThanOrEqual(96);
  });
});

describe('external agent process teardown', () => {
  it('lets the adapter request graceful shutdown before signals', async () => {
    const child = spawnFixture('graceful');

    // The grace window is a deadline, not a sleep: `terminate` returns the
    // moment the child exits. A tight 100ms only decided how much scheduler
    // jitter it took to escalate to a signal and turn a clean `code: 0` into
    // `signal: 'SIGTERM'` — which is what happened under a loaded full-suite
    // run. The claim is that the adapter's hook is given its chance first, not
    // that the child is scheduled within a tenth of a second.
    await child.terminate({
      graceful: () => child.writeLine({ type: 'shutdown' }),
      graceMs: 5_000,
    });

    expect(await child.exit).toEqual({ code: 0, signal: null });
  });

  it.skipIf(process.platform === 'win32')(
    'kills the POSIX process group including descendants',
    async () => {
      const child = spawnFixture('tree');
      const record = await child.stdout.next(1_000);
      const descendantPid = Number(record.kind === 'line' ? record.line : '0');
      expect(descendantPid).toBeGreaterThan(1);

      await child.terminate({ graceMs: 20 });

      // `terminate` resolves on the *child's* exit. Every other member of the
      // process group was signalled at the same moment, but the kernel delivers
      // and reaps on its own schedule, so a descendant can still be winding down
      // here — reliably on a loaded machine, rarely on an idle one. The claim
      // under test is that the group dies, not that it dies within one tick.
      await waitUntilDead(child.pid);
      await waitUntilDead(descendantPid);
    }
  );

  it('builds an explicit taskkill tree command for Windows escalation', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    await killWindowsProcessTree(42, (command, args) => {
      calls.push({ command, args });
      return Promise.resolve(0);
    });

    expect(windowsTaskkillArguments(42)).toEqual(['/PID', '42', '/T', '/F']);
    expect(calls).toEqual([{ command: 'taskkill', args: ['/PID', '42', '/T', '/F'] }]);
    expect(() => windowsTaskkillArguments(1)).toThrow(/invalid Windows process tree PID/);
  });

  it('aborts a taskkill command that never settles', async () => {
    let taskkillSignal: AbortSignal | undefined;
    const taskkill = killWindowsProcessTree(
      42,
      (_command, _args, signal) => {
        taskkillSignal = signal;
        return new Promise<never>(() => undefined);
      },
      5
    );

    await expect(taskkill).rejects.toThrow(/taskkill timed out/);
    expect(taskkillSignal?.aborted).toBe(true);
  });

  it('surfaces taskkill failure without waiting indefinitely for child exit', async () => {
    const failure = new Error('taskkill unavailable');
    let directKills = 0;
    const termination = terminateWindowsProcessTree(
      42,
      new Promise<never>(() => undefined),
      () => {
        directKills += 1;
      },
      5,
      () => Promise.reject(failure)
    );

    const outcome = await Promise.race([
      termination.then(
        () => 'resolved' as const,
        (error: unknown) => error
      ),
      Bun.sleep(250).then(() => 'timed-out' as const),
    ]);
    expect(outcome).toBe(failure);
    expect(directKills).toBe(1);
  });

  it('bounds a taskkill invocation that never settles before direct-child fallback', async () => {
    let directKills = 0;
    const termination = terminateWindowsProcessTree(
      42,
      new Promise<never>(() => undefined),
      () => {
        directKills += 1;
      },
      5,
      () => new Promise<never>(() => undefined)
    );

    const outcome = await Promise.race([
      termination.then(
        () => 'resolved' as const,
        (error: unknown) => error
      ),
      Bun.sleep(250).then(() => 'timed-out' as const),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('taskkill timed out');
    expect(directKills).toBe(1);
  });

  it('still surfaces taskkill failure when the direct child is already reaped', async () => {
    const failure = new Error('taskkill denied');

    await expect(
      terminateWindowsProcessTree(
        42,
        Promise.resolve(),
        () => undefined,
        5,
        () => Promise.reject(failure)
      )
    ).rejects.toBe(failure);
  });

  it.skipIf(process.platform !== 'win32')(
    'kills the Windows process tree including descendants through taskkill',
    async () => {
      const child = spawnFixture('tree');
      const record = await child.stdout.next(1_000);
      const descendantPid = Number(record.kind === 'line' ? record.line : '0');
      expect(descendantPid).toBeGreaterThan(1);

      await child.terminate({ graceMs: 100 });

      expect(isAlive(child.pid)).toBe(false);
      expect(isAlive(descendantPid)).toBe(false);
    }
  );
});

/** Waits for a signalled process to actually be gone, rather than assuming it is. */
async function waitUntilDead(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Process ${pid} was still alive ${timeoutMs}ms after its group was killed.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2];
      if (state === 'Z') return false;
    }
    return true;
  } catch {
    return false;
  }
}
