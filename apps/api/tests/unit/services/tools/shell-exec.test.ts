import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findShellExecutable,
  isShellAvailable,
  runShellCommand,
  ShellExecutionError,
} from '../../../../src/services/tools/builtin/_shell-exec';

const hasBash = isShellAvailable('bash');
const isWindows = process.platform === 'win32';

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
    expect(result.timedOut).toBe(false);
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

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    expect(result.exitCode).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(4000);
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
});
