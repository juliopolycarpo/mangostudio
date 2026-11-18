import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

import { isProcessAbsent, type ProcessLivenessProbe } from '../process-liveness';
import { createReleaseDiagnostics, readRootIdentity } from './managed-process-diagnostics';

const DEFAULT_DIAGNOSTIC_LIMIT_BYTES = 32 * 1024;
const DEFAULT_EXIT_TIMEOUT_MS = 5_000;
/** Fresh ports a collided child is relaunched on before `waitUntilReady` gives up on the port. */
const MAX_PORT_RELAUNCHES = 3;
/**
 * What the Hub prints when it loses the bind (`listenOrExit` in `src/server/start-server.ts`).
 * It names the address, which tells it apart from the capture-lock refusal ("User data is
 * already in use"), a failure a new port would not cure.
 */
const PORT_TAKEN_PATTERN = /Address \S+ is already in use\./;

export interface ManagedSpawnOptions {
  cmd: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface ManagedProcessFixture {
  /**
   * The loopback port the child is meant to bind. It changes when the child loses the race for
   * it and `waitUntilReady` relaunches it, so read it where it is used, never once up front.
   */
  readonly port: number;
  readonly tempDir: string;
  readonly child: Bun.Subprocess | null;
  /**
   * Starts the child. A server that binds `port` passes a function of the port: the fixture
   * reserves the port a moment before the child binds it, so another process can take it in
   * between, and `waitUntilReady` then relaunches the function on a fresh port.
   */
  spawn(options: ManagedSpawnOptions | ((port: number) => ManagedSpawnOptions)): Bun.Subprocess;
  /**
   * Polls `probe` until it holds. A probe must read `child` and `port` from the fixture on
   * every call, because a port collision replaces both.
   */
  waitUntilReady(
    probe: () => boolean | Promise<boolean>,
    options: { label: string; timeoutMs: number; intervalMs?: number }
  ): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<number>;
  stop(signal?: NodeJS.Signals, timeoutMs?: number): Promise<number>;
  diagnostics(): string;
  cleanup(): Promise<void>;
  assertReleased(): Promise<void>;
}

/** Allocates an OS-selected loopback port and releases the reservation immediately. */
async function reserveEphemeralPort(): Promise<number> {
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
  /** Inject removal failures/postconditions without racing the host filesystem. */
  removeTempDir?: (path: string) => Promise<void>;
}): Promise<ManagedProcessFixture> {
  let port = await reserveEphemeralPort();
  const tempDir = await mkdtemp(join(tmpdir(), options.tempPrefix));
  const limit = options.diagnosticLimitBytes ?? DEFAULT_DIAGNOSTIC_LIMIT_BYTES;
  let child: Bun.Subprocess | null = null;
  let stdout = '';
  let stderr = '';
  let stdoutCapture: Promise<void> | null = null;
  let stderrCapture: Promise<void> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let buildSpawnOptions: ((port: number) => ManagedSpawnOptions) | null = null;
  const lostPorts: number[] = [];
  const releaseDiagnostics = createReleaseDiagnostics(tempDir);

  const assertResourcesReleased = async (): Promise<void> => {
    if (child && isRunning(child)) {
      throw new Error(`Child process ${child.pid} is still running.`);
    }
    if (readRootIdentity(tempDir)) {
      throw new Error(`Fixture temp directory still exists: ${tempDir}`);
    }
    await assertPortAvailable(port);
  };

  const releaseError = (message: string, cause: unknown): Error =>
    new Error(
      `${message}: ${cause}\n${releaseDiagnostics.describe(child)}\n${fixture.diagnostics()}`,
      { cause }
    );

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

  const startChild = (spawnOptions: ManagedSpawnOptions): Bun.Subprocess => {
    const started = Bun.spawn({
      cmd: spawnOptions.cmd,
      env: spawnOptions.env,
      cwd: spawnOptions.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child = started;
    if (!started.stdout || typeof started.stdout === 'number') {
      throw new Error('Managed child stdout was not piped.');
    }
    if (!started.stderr || typeof started.stderr === 'number') {
      throw new Error('Managed child stderr was not piped.');
    }
    stdoutCapture = capture(started.stdout, (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    stderrCapture = capture(started.stderr, (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    return started;
  };

  /**
   * When the child already exited because another process holds its port, reserves a fresh
   * port and starts it again. Only a child started from a function of the port is relaunched,
   * and only for the Hub's own "Address ... is already in use" refusal.
   */
  const relaunchAfterPortCollision = async (): Promise<boolean> => {
    if (!buildSpawnOptions || !child || isRunning(child)) return false;
    if (lostPorts.length >= MAX_PORT_RELAUNCHES) return false;
    await Promise.all([stdoutCapture, stderrCapture]);
    if (!PORT_TAKEN_PATTERN.test(stderr)) return false;
    lostPorts.push(port);
    port = await reserveEphemeralPort();
    stdout = '';
    stderr = '';
    startChild(buildSpawnOptions(port));
    return true;
  };

  const fixture: ManagedProcessFixture = {
    get port() {
      return port;
    },
    tempDir,
    get child() {
      return child;
    },
    spawn(spawnOptions) {
      if (cleanupPromise) throw new Error('Managed process fixture cleanup has started.');
      if (child) throw new Error('Managed process fixture already has a child.');
      if (typeof spawnOptions === 'function') {
        buildSpawnOptions = spawnOptions;
        return startChild(spawnOptions(port));
      }
      return startChild(spawnOptions);
    },
    async waitUntilReady(probe, readiness) {
      const deadline = Date.now() + readiness.timeoutMs;
      while (Date.now() < deadline) {
        // Before the probe: a probe that accepts "the child exited" must not take a lost
        // port for the outcome it is waiting for.
        if (await relaunchAfterPortCollision()) continue;
        if (await probe()) return;
        await Bun.sleep(readiness.intervalMs ?? 25);
      }
      throw new Error(
        `${readiness.label} was not ready within ${readiness.timeoutMs}ms.\n${fixture.diagnostics()}`
      );
    },
    async waitForExit(timeoutMs = DEFAULT_EXIT_TIMEOUT_MS) {
      if (!child) throw new Error('Managed process fixture has not spawned a child.');
      releaseDiagnostics.observeProcesses(child);
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
    stop(signal = 'SIGTERM', timeoutMs) {
      if (!child) throw new Error('Managed process fixture has not spawned a child.');
      releaseDiagnostics.observeProcesses(child);
      if (isRunning(child)) child.kill(signal);
      return fixture.waitForExit(timeoutMs);
    },
    diagnostics() {
      const lost = lostPorts.map(
        (lostPort) => `port ${lostPort} was taken before the child bound it; relaunched`
      );
      return [...lost, `stdout:\n${stdout || '<empty>'}`, `stderr:\n${stderr || '<empty>'}`].join(
        '\n'
      );
    },
    cleanup() {
      cleanupPromise ??= (async () => {
        try {
          releaseDiagnostics.observeProcesses(child);
          if (child && isRunning(child)) {
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
          releaseDiagnostics.beforeRemoval();
          if (options.removeTempDir) {
            await options.removeTempDir(tempDir);
          } else {
            // Bun's fs.rm can resolve early when a child disappears during its
            // walk (oven-sh/bun#35800). The shell builtin continues that walk.
            await $`rm -rf ${tempDir}`.quiet();
          }
          await assertResourcesReleased();
        } catch (error) {
          throw releaseError('Fixture cleanup failed', error);
        }
      })();
      return cleanupPromise;
    },
    async assertReleased() {
      try {
        await assertResourcesReleased();
      } catch (error) {
        throw releaseError('Fixture release assertion failed', error);
      }
    },
  };

  return fixture;
}

/**
 * Waits for a library-owned PID to be proven absent; unknown probe errors reject immediately.
 *
 * @example
 * await waitForProcessExit(serverPid);
 */
export async function waitForProcessExit(
  pid: number,
  timeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
  probe: ProcessLivenessProbe = process.kill
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isProcessAbsent(pid, probe)) return;
    await Bun.sleep(25);
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms.`);
}

/**
 * Whether `child` has not ended yet. A child ended by a signal reports no exit
 * code, only the signal, which is every forced stop on Windows.
 *
 * @example
 * if (isRunning(child)) child.kill('SIGTERM');
 */
function isRunning(child: Bun.Subprocess): boolean {
  return child.exitCode === null && child.signalCode === null;
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
