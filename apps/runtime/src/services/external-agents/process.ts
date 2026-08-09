import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { HIDDEN_WINDOW } from '../process-window';

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const DEFAULT_STDERR_BYTES = 16 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;

const BASE_ENVIRONMENT_KEYS = new Set([
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  // Required for ordinary process creation on Windows. These are operating
  // system paths and command metadata, not application configuration.
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
]);

interface ExternalAgentProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

type ExternalAgentLineRead =
  | { readonly kind: 'line'; readonly line: string }
  | { readonly kind: 'eof' }
  | { readonly kind: 'timeout' };

interface ExternalAgentLineReader {
  next(timeoutMs: number, signal?: AbortSignal): Promise<ExternalAgentLineRead>;
  close(): void;
}

export interface ExternalAgentManagedProcess {
  readonly pid: number;
  readonly stdout: ExternalAgentLineReader;
  readonly exit: Promise<ExternalAgentProcessExit>;
  writeLine(value: unknown): Promise<void>;
  stderrTail(): string;
  terminate(options?: {
    readonly graceful?: () => void | Promise<void>;
    readonly graceMs?: number;
  }): Promise<void>;
}

export interface SpawnExternalAgentProcessOptions {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly envSource?: NodeJS.ProcessEnv;
  /** Adapter-owned, documented variables. Hub requests never populate this. */
  readonly vendorEnvironmentKeys?: readonly string[];
  readonly maxLineBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly maxStderrBytes?: number;
  readonly spawnProcess?: typeof spawn;
}

/**
 * The positive environment allowlist for vendor processes.
 *
 * A vendor adapter may name additional documented variables in its own code.
 * There is deliberately no map of values in the runtime method contract: a
 * hub cannot use this seam to smuggle a connector credential into a child.
 */
export function buildExternalAgentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  vendorKeys: readonly string[] = []
): Record<string, string> {
  const allowed = new Set([...BASE_ENVIRONMENT_KEYS, ...vendorKeys]);
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!allowed.has(key) && !key.startsWith('LC_')) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Redacts credential-shaped stderr before it crosses a diagnostic boundary.
 * The unredacted tail is never logged; callers receive this bounded form.
 */
function redactExternalAgentStderr(value: string): string {
  const redacted = value
    .replace(/\b(authorization\s*:\s*bearer)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|secret|token|password|passwd|credential)\s*[=:]\s*[^\s,;]+/gi,
      '$1=[REDACTED]'
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/?#]+:)[^\s@/?#]+@/gi, '$1[REDACTED]@');
  return [...redacted]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 0x09 ||
        codePoint === 0x0a ||
        (codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f))
      );
    })
    .join('');
}

/**
 * Spawns one adapter-owned process with common safety policy.
 *
 * POSIX children lead a new process group, so escalation targets the complete
 * tree. Windows escalation explicitly invokes `taskkill /T /F`; Node's direct
 * child handle does not imply descendant ownership there.
 */
export function spawnExternalAgentProcess(
  options: SpawnExternalAgentProcessOptions
): ExternalAgentManagedProcess {
  const spawnProcess = options.spawnProcess ?? spawn;
  const child = spawnProcess(options.argv[0], [...options.argv.slice(1)], {
    cwd: options.cwd,
    env: buildExternalAgentEnvironment(options.envSource, options.vendorEnvironmentKeys),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    ...HIDDEN_WINDOW,
  });
  const exit = waitForExit(child);
  const stdout = createBoundedLineReader(child.stdout, {
    maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
    maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
  });
  const stderr = createBoundedStderrTail(child, options.maxStderrBytes ?? DEFAULT_STDERR_BYTES);

  child.stdin.on('error', () => {
    // EPIPE after a vendor crash is reported by `exit`, not as an uncaught
    // stream error from a late protocol response.
  });

  let termination: Promise<void> | undefined;
  return {
    pid: child.pid ?? -1,
    stdout,
    exit,
    async writeLine(value) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('External agent process is no longer running.');
      }
      const line = `${JSON.stringify(value)}\n`;
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
      });
    },
    stderrTail: () => redactExternalAgentStderr(stderr.read()),
    terminate(terminateOptions = {}) {
      termination ??= terminateProcessTree(child, exit, terminateOptions);
      return termination;
    },
  };
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<ExternalAgentProcessExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function createBoundedStderrTail(
  child: ChildProcessWithoutNullStreams,
  maxBytes: number
): { read(): string } {
  let tail = Buffer.alloc(0);
  child.stderr.on('data', (chunk: Buffer | string) => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    tail = Buffer.concat([tail, incoming]).subarray(-maxBytes);
  });
  return { read: () => tail.toString('utf8') };
}

function createBoundedLineReader(
  input: NodeJS.ReadableStream,
  limits: { readonly maxLineBytes: number; readonly maxBufferedBytes: number }
): ExternalAgentLineReader {
  const lines: Array<{ readonly line: string; readonly bytes: number }> = [];
  const waiters = new Set<() => void>();
  let pending = Buffer.alloc(0);
  let queuedBytes = 0;
  let ended = false;
  let failure: Error | undefined;

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
    waiters.clear();
  };
  const fail = (message: string) => {
    if (failure) return;
    failure = new Error(message);
    input.pause?.();
    wake();
  };

  input.on('data', (chunk: Buffer | string) => {
    if (failure || ended) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = Buffer.concat([pending, incoming]);
    if (pending.byteLength + queuedBytes > limits.maxBufferedBytes) {
      fail(`External agent stdout exceeded the ${limits.maxBufferedBytes}-byte buffer limit.`);
      return;
    }

    let newline = pending.indexOf(0x0a);
    while (newline >= 0) {
      let record = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (record.at(-1) === 0x0d) record = record.subarray(0, -1);
      if (record.byteLength > limits.maxLineBytes) {
        fail(`External agent stdout exceeded the ${limits.maxLineBytes}-byte line limit.`);
        return;
      }
      const line = record.toString('utf8');
      lines.push({ line, bytes: record.byteLength });
      queuedBytes += record.byteLength;
      newline = pending.indexOf(0x0a);
    }
    if (pending.byteLength > limits.maxLineBytes) {
      fail(`External agent stdout exceeded the ${limits.maxLineBytes}-byte line limit.`);
      return;
    }
    wake();
  });
  input.on('end', () => {
    if (pending.byteLength > 0 && !failure) {
      if (pending.byteLength > limits.maxLineBytes) {
        fail(`External agent stdout exceeded the ${limits.maxLineBytes}-byte line limit.`);
        return;
      }
      const line = pending.toString('utf8');
      lines.push({ line, bytes: pending.byteLength });
      queuedBytes += pending.byteLength;
      pending = Buffer.alloc(0);
    }
    ended = true;
    wake();
  });
  input.on('error', (error: Error) => {
    failure = error;
    wake();
  });

  return {
    async next(timeoutMs, signal) {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (true) {
        if (failure) throw failure;
        const next = lines.shift();
        if (next) {
          queuedBytes -= next.bytes;
          return { kind: 'line', line: next.line };
        }
        if (ended) return { kind: 'eof' };
        if (signal?.aborted) throw new DOMException('External agent read cancelled.', 'AbortError');

        const remaining = deadline - Date.now();
        if (remaining <= 0) return { kind: 'timeout' };
        const arrived = await new Promise<boolean>((resolve, reject) => {
          const waiter = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
          };
          const onAbort = () => {
            clearTimeout(timer);
            waiters.delete(waiter);
            reject(new DOMException('External agent read cancelled.', 'AbortError'));
          };
          const timer = setTimeout(() => {
            waiters.delete(waiter);
            signal?.removeEventListener('abort', onAbort);
            resolve(false);
          }, remaining);
          timer.unref?.();
          waiters.add(waiter);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        if (!arrived) return { kind: 'timeout' };
      }
    },
    close() {
      ended = true;
      input.pause?.();
      wake();
    },
  };
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<ExternalAgentProcessExit>,
  options: { readonly graceful?: () => void | Promise<void>; readonly graceMs?: number }
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const graceMs = Math.max(0, options.graceMs ?? DEFAULT_KILL_GRACE_MS);

  await Promise.resolve(options.graceful?.()).catch(() => undefined);
  if (await exitedWithin(exit, graceMs)) return;

  if (process.platform === 'win32') {
    const pid = child.pid;
    if (pid === undefined || pid <= 1) {
      throw new Error('External agent process has no valid PID.');
    }
    await terminateWindowsProcessTree(pid, exit, () => child.kill('SIGKILL'), graceMs);
    return;
  }

  signalProcessTree(child, 'SIGTERM');
  if (await exitedWithin(exit, graceMs)) return;

  signalProcessTree(child, 'SIGKILL');
  await exit.catch(() => undefined);
}

export function windowsTaskkillArguments(pid: number): readonly string[] {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`Cannot terminate invalid Windows process tree PID ${pid}.`);
  }
  return ['/PID', String(pid), '/T', '/F'];
}

type WindowsTaskkillRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal
) => Promise<number | null>;

/** Terminates a Windows process and all descendants through the system tree-kill primitive. */
export async function killWindowsProcessTree(
  pid: number,
  run: WindowsTaskkillRunner = runWindowsTaskkill,
  timeoutMs: number = DEFAULT_KILL_GRACE_MS
): Promise<void> {
  const args = windowsTaskkillArguments(pid);
  const controller = new AbortController();
  let code: number | null;
  try {
    code = await promiseWithin(
      run('taskkill', args, controller.signal),
      timeoutMs,
      `taskkill timed out for external agent process tree ${pid}.`
    );
  } finally {
    controller.abort();
  }
  if (code !== 0) {
    throw new Error(
      `taskkill failed for external agent process tree ${pid} with exit code ${code}.`
    );
  }
}

/**
 * Escalates Windows cleanup without ever waiting indefinitely on a child
 * handle after `taskkill` fails or returns without reaping the process.
 */
export async function terminateWindowsProcessTree(
  pid: number,
  exit: Promise<unknown>,
  killDirectChild: () => unknown,
  graceMs: number,
  killTree?: (pid: number) => Promise<void>
): Promise<void> {
  let treeKillError: unknown;
  try {
    const terminateTree =
      killTree ?? ((treePid) => killWindowsProcessTree(treePid, runWindowsTaskkill, graceMs));
    await promiseWithin(
      terminateTree(pid),
      graceMs,
      `taskkill timed out for external agent process tree ${pid}.`
    );
  } catch (error) {
    treeKillError = error;
  }

  if (!treeKillError && (await exitedWithin(exit, graceMs))) return;

  // Last-resort direct-child cleanup. This does not claim descendant
  // coverage: a taskkill failure remains visible even if this reaps the child.
  try {
    killDirectChild();
  } catch {
    // The bounded exit wait below determines whether another close path won.
  }
  const directChildExited = await exitedWithin(exit, graceMs);
  if (treeKillError) throw treeKillError;
  if (!directChildExited) {
    throw new Error(`taskkill did not terminate external agent process tree ${pid}.`);
  }
}

async function runWindowsTaskkill(
  command: string,
  args: readonly string[],
  signal: AbortSignal
): Promise<number | null> {
  const taskkill = spawn(command, [...args], {
    stdio: 'ignore',
    ...HIDDEN_WINDOW,
  });
  return await new Promise<number | null>((resolveExit, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      try {
        taskkill.kill('SIGKILL');
      } catch {
        // The taskkill process may have exited between the timeout and abort.
      }
      reject(new Error('taskkill was cancelled after exceeding its deadline.'));
    };
    taskkill.once('error', (error) => {
      cleanup();
      reject(error);
    });
    taskkill.once('close', (code) => {
      cleanup();
      resolveExit(code);
    });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function promiseWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return await Promise.race([
    promise,
    delay(Math.max(0, timeoutMs), undefined, { ref: false }).then(() => {
      throw new Error(message);
    }),
  ]);
}

async function exitedWithin(exit: Promise<unknown>, timeoutMs: number) {
  return await Promise.race([exit.then(() => true), delay(timeoutMs, false, { ref: false })]);
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid !== undefined && pid > 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group may already have exited; fall back to the direct handle so a
      // process that never became group leader is still released.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Another close path won the race.
  }
}
