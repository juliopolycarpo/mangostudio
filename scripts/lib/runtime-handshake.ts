// Drives one NDJSON handshake against a runtime binary the way the hub does,
// and reports *why* it failed when it does.
//
// The frame's shape is smoke policy and stays with the caller; what lives here
// is the mechanics that used to be unobservable — the concurrent stderr drain,
// the timeout-versus-exit discrimination, and the branch-specific cleanup.
//
// Deliberately hand-rolled rather than reusing the SDK's codec: the smoke
// script runs in the smoke matrix with `--no-install`, so everything reachable
// from it must import nothing but `node:`/`bun` builtins and other `scripts/lib`
// modules — `scripts/tests/smoke-dependencies.unit.test.ts` enforces that.

import {
  type FirstLineResult,
  type PumpedStream,
  pumpStream,
  readFirstLine,
} from './child-streams';
import { pickPlatformBudgetMs } from './platform-budget';

/** How long a child that closed stdout gets to exit before it is killed. */
const DEFAULT_EXIT_GRACE_MS = 2_000;

/** Budget for the first stdout record everywhere but Windows. */
export const DEFAULT_HANDSHAKE_BUDGET_MS = 10_000;

/**
 * Windows-specific handshake budget.
 *
 * The same cold start `wait-for-health.ts` already bumps for (issue #377):
 * process spawn plus first-run JIT and disk warmup on a GitHub `windows-*`
 * runner routinely costs multiples of what Linux and macOS pay, and the runtime
 * pays it on `--stdio` rather than on `--version`, which short-circuits.
 *
 * The evidence this is timing and not a bad binary: on PR #1039 the runtime exe
 * with digest `443930e2…` timed out here on one run and handshook on the next,
 * byte-identical both times. Being generous costs a slower red on a genuinely
 * hung runtime and nothing at all on a healthy one, which greets in about a
 * second — so this matches `WIN32_READY_BUDGET_MS` rather than splitting the
 * difference and guessing again in a month.
 */
export const WIN32_HANDSHAKE_BUDGET_MS = 60_000;

/**
 * The platform's default handshake budget. Exported separately from the probe
 * so a test can pin both branches without spawning anything.
 *
 * // Usage: const timeoutMs = resolveHandshakeBudgetMs();
 */
export function resolveHandshakeBudgetMs(): number {
  return pickPlatformBudgetMs(DEFAULT_HANDSHAKE_BUDGET_MS, WIN32_HANDSHAKE_BUDGET_MS);
}

export interface RuntimeHandshakeProbeOptions {
  /** Full argv, e.g. `[runtimeBinaryPath, '--stdio']`. */
  readonly command: readonly string[];
  /** Budget for the first stdout record. Overrides the platform default. */
  readonly timeoutMs?: number;
  /** How long a child that closed stdout gets to exit; defaults to 2s. */
  readonly exitGraceMs?: number;
}

export interface RuntimeHandshakeProbe {
  /** The handshake line, or `null` when none arrived. */
  readonly hello: string | null;
  /** Human-readable cause; `null` exactly when `hello` is not `null` — an
   * empty `hello` is still a line the child wrote, not a failure. */
  readonly failure: string | null;
  /** Anything written to stdout without a terminating newline. */
  readonly partial: string;
  /** Everything the child wrote to stderr. */
  readonly stderr: string;
  /** The child's own exit code, or `null` when our kill got there first. */
  readonly exitCode: number | null;
  /** The signal the child died on, when it died on one of its own. */
  readonly signal: string | null;
  /**
   * How long the probe waited, in milliseconds. Reported on success too: what
   * headroom a passing handshake actually leaves is the measurement every
   * argument about this budget has so far had to do without.
   */
  readonly elapsedMs: number;
}

/**
 * Runs the handshake and returns a verdict plus full diagnostics.
 *
 * Never exits the process — the caller decides what a failure means — so the
 * whole matrix of child behaviours is unit-testable.
 *
 * @example
 * const probe = await probeRuntimeHandshake({ command: [runtimePath, '--stdio'] });
 * if (!probe.hello) console.error(probe.failure, probe.stderr);
 */
export async function probeRuntimeHandshake(
  options: RuntimeHandshakeProbeOptions
): Promise<RuntimeHandshakeProbe> {
  const {
    command,
    timeoutMs = resolveHandshakeBudgetMs(),
    exitGraceMs = DEFAULT_EXIT_GRACE_MS,
  } = options;
  const startedAt = Date.now();

  const child = Bun.spawn({
    cmd: [...command],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Drain stderr from the first tick: an unread pipe fills, and whatever the
  // child wrote on its way to not handshaking is the diagnostic we came for.
  const stderr = pumpStream(child.stderr);

  let read: FirstLineResult;
  try {
    read = await readFirstLine(child.stdout, timeoutMs);
  } catch (caught) {
    // A thrown read leaves the child running and the stderr pump attached; a
    // rejection is not one of `readFirstLine`'s reported outcomes, so it gets
    // the same cleanup as every other exit path instead of leaking both.
    child.kill();
    await finish(child, stderr, exitGraceMs);
    throw caught;
  }
  // Taken before any cleanup: what this is evidence of is how long the child
  // took to speak, not how long we then spent waiting for it to die.
  const elapsedMs = Date.now() - startedAt;
  child.stdin.end();

  if (read.kind === 'line') {
    child.kill();
    await finish(child, stderr, exitGraceMs);
    return {
      hello: read.line,
      failure: null,
      partial: '',
      stderr: stderr.text(),
      exitCode: null,
      signal: null,
      elapsedMs,
    };
  }

  // The child is usually still alive on `timeout` and probably dead on `eof`,
  // so the two paths cannot share a cleanup: killing a hung child first makes
  // its exit code ours, not its own.
  if (read.kind === 'timeout') {
    // A child that already died while a grandchild kept the stdout pipe open
    // still has a real status, and that status is the whole diagnostic — read
    // it before our own kill replaces it with ours.
    const diedOnItsOwn = await hasExited(child);
    const exitCode = diedOnItsOwn ? child.exitCode : null;
    const signal = diedOnItsOwn ? child.signalCode : null;
    child.kill();
    await finish(child, stderr, exitGraceMs);
    return {
      hello: null,
      failure: diedOnItsOwn
        ? `wrote no handshake frame within ${timeoutMs}ms and left stdout open; ${describeExit(exitCode, signal)}`
        : `wrote no handshake frame within ${timeoutMs}ms and was killed`,
      partial: read.partial,
      stderr: stderr.text(),
      exitCode,
      signal,
      elapsedMs,
    };
  }

  const exited = await settledWithin(child.exited, exitGraceMs);
  if (!exited) {
    child.kill();
    await finish(child, stderr, exitGraceMs);
    return {
      hello: null,
      failure: `closed stdout without a handshake frame and did not exit within ${exitGraceMs}ms; killed`,
      partial: read.partial,
      stderr: stderr.text(),
      exitCode: null,
      signal: null,
      elapsedMs,
    };
  }

  await drain(stderr, exitGraceMs);
  const exitCode = child.exitCode;
  const signal = child.signalCode;
  return {
    hello: null,
    failure: `closed stdout without a handshake frame; ${describeExit(exitCode, signal)}`,
    partial: read.partial,
    stderr: stderr.text(),
    exitCode,
    signal,
    elapsedMs,
  };
}

function describeExit(exitCode: number | null, signal: string | null): string {
  if (signal) return `killed by ${signal}`;
  if (exitCode === null) return 'exit status unavailable';
  return `exited with code ${exitCode}`;
}

/** True when the child is already gone, without waiting on one that is not. */
function hasExited(child: { exited: Promise<number> }): Promise<boolean> {
  return settledWithin(child.exited, 0);
}

/** Waits out a killed child and its stderr, bounded so cleanup cannot hang. */
async function finish(
  child: { exited: Promise<number> },
  stderr: PumpedStream,
  graceMs: number
): Promise<void> {
  await settledWithin(child.exited, graceMs);
  await drain(stderr, graceMs);
}

/** Bounded, because a grandchild holding the pipe would otherwise block us. */
async function drain(stderr: PumpedStream, graceMs: number): Promise<void> {
  await settledWithin(stderr.done, graceMs);
}

/** Resolves `true` if `promise` settled within `timeoutMs`, `false` otherwise. */
async function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([promise.then(() => true).catch(() => true), grace]);
  } finally {
    clearTimeout(timer);
  }
}
