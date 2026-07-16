import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_DIAGNOSTIC_LIMIT_BYTES = 32 * 1024;
const DEFAULT_EXIT_TIMEOUT_MS = 5_000;

export interface ManagedProcessFixture {
  readonly port: number;
  readonly tempDir: string;
  readonly child: Bun.Subprocess | null;
  spawn(options: {
    cmd: string[];
    env?: Record<string, string | undefined>;
    cwd?: string;
  }): Bun.Subprocess;
  waitUntilReady(
    probe: () => boolean | Promise<boolean>,
    options: { label: string; timeoutMs: number; intervalMs?: number }
  ): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<number>;
  stop(signal?: NodeJS.Signals): Promise<number>;
  diagnostics(): string;
  cleanup(): Promise<void>;
  assertReleased(): Promise<void>;
}

/** Allocates an OS-selected loopback port and releases the reservation immediately. */
export async function reserveEphemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate an ephemeral fixture port.');
  }
  return address.port;
}

/**
 * Owns one child process, its ephemeral port, bounded diagnostics, and temp
 * storage. Teardown escalates from SIGTERM to SIGKILL and supports a final
 * leak assertion for both the child and port.
 */
export async function createManagedProcessFixture(options: {
  tempPrefix: string;
  diagnosticLimitBytes?: number;
}): Promise<ManagedProcessFixture> {
  const port = await reserveEphemeralPort();
  const tempDir = await mkdtemp(join(tmpdir(), options.tempPrefix));
  const limit = options.diagnosticLimitBytes ?? DEFAULT_DIAGNOSTIC_LIMIT_BYTES;
  let child: Bun.Subprocess | null = null;
  let stdout = '';
  let stderr = '';
  let stdoutCapture: Promise<void> | null = null;
  let stderrCapture: Promise<void> | null = null;
  let cleaned = false;

  const appendBounded = (current: string, chunk: string): string => {
    const combined = current + chunk;
    return combined.length <= limit ? combined : combined.slice(-limit);
  };

  const capture = async (
    stream: ReadableStream<Uint8Array>,
    append: (chunk: string) => void
  ): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      append(decoder.decode(value, { stream: true }));
    }
    append(decoder.decode());
  };

  const fixture: ManagedProcessFixture = {
    port,
    tempDir,
    get child() {
      return child;
    },
    spawn(spawnOptions) {
      if (child) throw new Error('Managed process fixture already has a child.');
      child = Bun.spawn({
        cmd: spawnOptions.cmd,
        env: spawnOptions.env,
        cwd: spawnOptions.cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (!child.stdout || typeof child.stdout === 'number') {
        throw new Error('Managed child stdout was not piped.');
      }
      if (!child.stderr || typeof child.stderr === 'number') {
        throw new Error('Managed child stderr was not piped.');
      }
      stdoutCapture = capture(child.stdout, (chunk) => {
        stdout = appendBounded(stdout, chunk);
      });
      stderrCapture = capture(child.stderr, (chunk) => {
        stderr = appendBounded(stderr, chunk);
      });
      return child;
    },
    async waitUntilReady(probe, readiness) {
      const deadline = Date.now() + readiness.timeoutMs;
      while (Date.now() < deadline) {
        if (await probe()) return;
        await Bun.sleep(readiness.intervalMs ?? 25);
      }
      throw new Error(
        `${readiness.label} was not ready within ${readiness.timeoutMs}ms.\n${fixture.diagnostics()}`
      );
    },
    async waitForExit(timeoutMs = DEFAULT_EXIT_TIMEOUT_MS) {
      if (!child) throw new Error('Managed process fixture has not spawned a child.');
      const timedOut = Symbol('timed-out');
      // A ref'd timer is cleared once the child exits so the loser of the race
      // does not keep the event loop alive for the full timeout after teardown.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      });
      try {
        const result = await Promise.race([child.exited, timeout]);
        if (typeof result !== 'number') {
          throw new Error(
            `Child process did not exit within ${timeoutMs}ms.\n${fixture.diagnostics()}`
          );
        }
        await Promise.all([stdoutCapture, stderrCapture]);
        return result;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    stop(signal = 'SIGTERM') {
      if (!child) throw new Error('Managed process fixture has not spawned a child.');
      if (child.exitCode === null) child.kill(signal);
      return fixture.waitForExit();
    },
    diagnostics() {
      return [`stdout:\n${stdout || '<empty>'}`, `stderr:\n${stderr || '<empty>'}`].join('\n');
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (child?.exitCode === null) {
        child.kill('SIGTERM');
        try {
          await fixture.waitForExit();
        } catch {
          child.kill('SIGKILL');
          await fixture.waitForExit();
        }
      } else if (child) {
        await Promise.all([stdoutCapture, stderrCapture]);
      }
      await rm(tempDir, { force: true, recursive: true });
    },
    async assertReleased() {
      if (child?.exitCode === null) throw new Error(`Child process ${child.pid} is still running.`);
      if (existsSync(tempDir)) throw new Error(`Fixture temp directory still exists: ${tempDir}`);
      await assertPortAvailable(port);
    },
  };

  return fixture;
}

/** Waits for a process owned by another library (for example the MCP SDK) to exit. */
export async function waitForProcessExit(pid: number, timeoutMs = DEFAULT_EXIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await Bun.sleep(25);
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms.`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertPortAvailable(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
