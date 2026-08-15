import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findShellExecutable,
  isShellAvailable,
  runShellCommand,
  runShellCommandWithDeps,
  ShellExecutionError,
} from '../../../src/services/shell';
import {
  createFakeClock,
  createFakeShellDeps,
  createHangingFakeShellProcess,
} from './support/fake-shell-exec';

const hasBash = isShellAvailable('bash');
const isWindows = process.platform === 'win32';

/** Polls until the pid is gone, or the budget runs out. */
async function waitUntilGone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'shell-exec-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('findShellExecutable', () => {
  it.skipIf(!hasBash)('returns an absolute path when bash is available', () => {
    const path = findShellExecutable('bash');
    expect(typeof path).toBe('string');
    expect(path).toContain('bash');
  });

  it.skipIf(isWindows)('returns null for powershell off Windows', () => {
    expect(findShellExecutable('powershell')).toBeNull();
  });
});

describe('isShellAvailable', () => {
  it.skipIf(isWindows)('reports powershell unavailable off Windows', () => {
    expect(isShellAvailable('powershell')).toBe(false);
  });
});

describe('runShellCommand', () => {
  it.skipIf(isWindows)('rejects when the requested shell is unavailable', async () => {
    // PowerShell is never available off Windows.
    const run = runShellCommand({
      kind: 'powershell',
      command: 'echo hi',
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    });
    await expect(run).rejects.toBeInstanceOf(ShellExecutionError);
    await expect(run).rejects.toThrow('not available');
  });

  it.skipIf(!hasBash)('captures stdout, exit code, and timing', async () => {
    const result = await runShellCommand({
      kind: 'bash',
      command: 'echo hello',
      timeoutMs: 5000,
      maxOutputBytes: 65_536,
    });

    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.termination).toEqual({ kind: 'exited' });
    expect(result.truncated).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(!hasBash)('reports a non-zero exit code', async () => {
    const result = await runShellCommand({
      kind: 'bash',
      command: 'exit 3',
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.termination).toEqual({ kind: 'exited' });
  });

  it.skipIf(!hasBash)('captures stderr separately from stdout', async () => {
    const result = await runShellCommand({
      kind: 'bash',
      command: 'echo oops 1>&2',
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    expect(result.stderr.trim()).toBe('oops');
    expect(result.stdout).toBe('');
  });

  it.skipIf(!hasBash)('runs in the provided working directory', async () => {
    await runShellCommand({
      kind: 'bash',
      command: 'echo marker > created.txt',
      cwd: tempDir,
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    expect(existsSync(join(tempDir, 'created.txt'))).toBe(true);
  });

  it.skipIf(!hasBash)('truncates output beyond the byte cap', async () => {
    const result = await runShellCommand({
      kind: 'bash',
      command: "printf '%01000d' 0",
      timeoutMs: 5000,
      maxOutputBytes: 100,
    });
    expect(result.stdout.length).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it.skipIf(!hasBash)('kills the process when it exceeds the timeout', async () => {
    const startedAt = Date.now();
    const result = await runShellCommand({
      kind: 'bash',
      command: 'sleep 5',
      timeoutMs: 300,
      maxOutputBytes: 1000,
    });

    expect(result.termination).toEqual({ kind: 'timed_out' });
    expect(result.signal).toBe('SIGKILL');
    expect(result.exitCode).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });

  it.skipIf(!hasBash)('kills the process when the abort signal fires', async () => {
    const controller = new AbortController();
    const run = runShellCommand({
      kind: 'bash',
      command: 'echo $$; sleep 5',
      timeoutMs: 30_000,
      maxOutputBytes: 1000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);

    const result = await run;
    expect(result.termination).toEqual({ kind: 'aborted' });

    const pid = Number(result.stdout.trim().split('\n')[0]);
    expect(Number.isFinite(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.skipIf(!hasBash)(
    'returns when a surviving descendant holds the pipes open',
    async () => {
      // The child backgrounds a process that inherits stdout and stderr, so
      // killing the shell alone never brings either stream to EOF. Both sleeps
      // outlast the assertions by far: without the fix this call does not return
      // at all, and the test fails on its own timeout rather than an expectation.
      const startedAt = Date.now();
      const result = await runShellCommand({
        kind: 'bash',
        command: 'sleep 60 & echo $!; sleep 60',
        timeoutMs: 2000,
        maxOutputBytes: 1000,
      });

      expect(result.termination).toEqual({ kind: 'timed_out' });
      expect(Date.now() - startedAt).toBeLessThan(30_000);
      // Whatever was captured is what arrived before the kill, never the whole
      // stream, so the result has to say so.
      expect(result.truncated).toBe(true);

      const descendant = Number(result.stdout.trim().split('\n')[0]);
      expect(Number.isFinite(descendant)).toBe(true);
      // Signalling the group and reaping it are not the same instant, so this
      // waits for the descendant to go rather than asserting on the first look.
      // `kill(pid, 0)` succeeds on a zombie, so this also fails if the leader
      // was killed before it could waitpid the children.
      expect(await waitUntilGone(descendant, 10_000)).toBe(true);
    },
    60_000
  );

  it.skipIf(!hasBash)(
    'returns when the shell exits but a descendant still holds the pipes',
    async () => {
      // `sleep 60 & echo done` is a successful shell: it backgrounds the work
      // and exits 0. The descendant keeps the pipes, so waiting for EOF is
      // waiting for the sleep. The wall-clock budget still has to end the call.
      const startedAt = Date.now();
      const result = await runShellCommand({
        kind: 'bash',
        command: 'sleep 60 & echo $!',
        timeoutMs: 400,
        maxOutputBytes: 1000,
      });

      expect(result.termination).toEqual({ kind: 'exited' });
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(10_000);

      const descendant = Number(result.stdout.trim().split('\n')[0]);
      expect(Number.isFinite(descendant)).toBe(true);
      expect(await waitUntilGone(descendant, 10_000)).toBe(true);
    },
    30_000
  );

  it.skipIf(!hasBash)(
    'stops capture on abort after the shell has already exited',
    async () => {
      const marker = join(tempDir, 'exited');
      const controller = new AbortController();
      const startedAt = Date.now();
      const run = runShellCommand({
        kind: 'bash',
        command: `sleep 60 & echo $!; echo ready > "${marker}"`,
        timeoutMs: 30_000,
        maxOutputBytes: 1000,
        signal: controller.signal,
      });

      const deadline = Date.now() + 5_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(existsSync(marker)).toBe(true);
      // The marker is written just before bash exits; give that exit a turn
      // so this abort lands on the naturally-exited path, not the running one.
      await Bun.sleep(50);
      controller.abort();

      const result = await run;
      expect(result.termination).toEqual({ kind: 'exited' });
      expect(result.truncated).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(10_000);

      const descendant = Number(result.stdout.trim().split('\n')[0]);
      expect(Number.isFinite(descendant)).toBe(true);
      expect(await waitUntilGone(descendant, 10_000)).toBe(true);
    },
    30_000
  );

  it.skipIf(!hasBash)(
    'keeps a signalled exit when leftover descendants hold the pipes',
    async () => {
      const startedAt = Date.now();
      const result = await runShellCommand({
        kind: 'bash',
        command: 'sleep 60 & kill -TERM $$',
        timeoutMs: 400,
        maxOutputBytes: 1000,
      });

      expect(result.termination.kind).not.toBe('timed_out');
      expect(result.truncated).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      if (result.termination.kind === 'signalled') {
        expect(result.termination.signal).toBe('SIGTERM');
      } else {
        // bash may convert the signal into a 128+n exit instead of dying of it.
        expect(result.termination).toEqual({ kind: 'exited' });
        expect(result.exitCode).toBe(143);
      }
    },
    30_000
  );

  it.skipIf(!hasBash)('kills the process when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    const result = await runShellCommand({
      kind: 'bash',
      command: 'sleep 5',
      timeoutMs: 30_000,
      maxOutputBytes: 1000,
      signal: controller.signal,
    });
    // Without the already-aborted guard the child would run the full sleep.
    expect(result.termination).toEqual({ kind: 'aborted' });
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });
});

describe('runShellCommand termination races', () => {
  const baseInput = {
    kind: 'bash' as const,
    command: 'sleep 5',
    timeoutMs: 1000,
    maxOutputBytes: 1000,
  };

  it.skipIf(!hasBash)('reports exited when the child finishes before the timer', async () => {
    const proc = createHangingFakeShellProcess();
    const clock = createFakeClock();
    const run = runShellCommandWithDeps(baseInput, createFakeShellDeps(proc, clock));
    proc.complete(0);
    const result = await run;

    expect(result.termination).toEqual({ kind: 'exited' });
    expect(clock.pendingCount()).toBe(0);
  });

  it.skipIf(!hasBash)('claims timed_out when the owned timer fires first', async () => {
    const proc = createHangingFakeShellProcess();
    const clock = createFakeClock();
    const run = runShellCommandWithDeps(baseInput, createFakeShellDeps(proc, clock));
    clock.advance(1000);
    const result = await run;

    expect(result.termination).toEqual({ kind: 'timed_out' });
    expect(proc.killCalls).toBe(1);
    expect(clock.pendingCount()).toBe(0);
  });

  it.skipIf(!hasBash)('claims aborted when the parent signal fires first', async () => {
    const proc = createHangingFakeShellProcess();
    const clock = createFakeClock();
    const controller = new AbortController();
    const run = runShellCommandWithDeps(
      { ...baseInput, signal: controller.signal },
      createFakeShellDeps(proc, clock)
    );
    controller.abort();
    const result = await run;

    expect(result.termination).toEqual({ kind: 'aborted' });
    expect(proc.killCalls).toBe(1);
  });

  it.skipIf(!hasBash)('keeps aborted when abort wins the race with the timer', async () => {
    const proc = createHangingFakeShellProcess();
    const clock = createFakeClock();
    const controller = new AbortController();
    const run = runShellCommandWithDeps(
      { ...baseInput, signal: controller.signal },
      createFakeShellDeps(proc, clock)
    );
    controller.abort();
    clock.advance(1000);
    const result = await run;

    expect(result.termination).toEqual({ kind: 'aborted' });
  });

  it.skipIf(!hasBash)('keeps timed_out when the timer wins the race with abort', async () => {
    const proc = createHangingFakeShellProcess();
    const clock = createFakeClock();
    const controller = new AbortController();
    const run = runShellCommandWithDeps(
      { ...baseInput, signal: controller.signal },
      createFakeShellDeps(proc, clock)
    );
    clock.advance(1000);
    controller.abort();
    const result = await run;

    expect(result.termination).toEqual({ kind: 'timed_out' });
  });

  it.skipIf(!hasBash)('swallows kill errors after the child already exited', async () => {
    const proc = createHangingFakeShellProcess();
    const clock = createFakeClock();
    const run = runShellCommandWithDeps(baseInput, createFakeShellDeps(proc, clock));
    proc.complete(0);
    clock.advance(1000);
    const result = await run;

    expect(result.termination).toEqual({ kind: 'exited' });
  });
});

describe('runShellCommand env sanitization', () => {
  const SECRET_KEY = 'SHELLTEST_API_KEY_LEAK';
  const PUBLIC_KEY = 'SHELLTEST_PUBLIC_MARKER';

  beforeEach(() => {
    process.env[SECRET_KEY] = 'sk-must-not-leak';
    process.env[PUBLIC_KEY] = 'visible';
  });

  afterEach(() => {
    delete process.env[SECRET_KEY];
    delete process.env[PUBLIC_KEY];
  });

  it.skipIf(!hasBash)('withholds connector secrets from the spawned shell', async () => {
    const result = await runShellCommand({
      kind: 'bash',
      command: `echo "[$${SECRET_KEY}]"`,
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    // The variable is unset in the child, so it expands to empty.
    expect(result.stdout.trim()).toBe('[]');
  });

  it.skipIf(!hasBash)('still forwards non-secret environment variables', async () => {
    const result = await runShellCommand({
      kind: 'bash',
      command: `echo "[$${PUBLIC_KEY}]"`,
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    expect(result.stdout.trim()).toBe('[visible]');
  });

  it.skipIf(!hasBash)('forwards a secret variable named in the allow policy', async () => {
    const result = await runShellCommand({
      kind: 'bash',
      command: `echo "[$${SECRET_KEY}]"`,
      timeoutMs: 5000,
      maxOutputBytes: 1000,
      envPolicy: { allow: [SECRET_KEY] },
    });
    expect(result.stdout.trim()).toBe('[sk-must-not-leak]');
  });

  it.skipIf(!hasBash)('withholds a non-secret variable named in the deny policy', async () => {
    const result = await runShellCommand({
      kind: 'bash',
      command: `echo "[$${PUBLIC_KEY}]"`,
      timeoutMs: 5000,
      maxOutputBytes: 1000,
      envPolicy: { deny: [PUBLIC_KEY] },
    });
    expect(result.stdout.trim()).toBe('[]');
  });
});
