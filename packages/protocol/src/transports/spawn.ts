/**
 * The spawn launcher of spec/transports/spawn.md: start a child process and
 * speak stdio through its pipes. SSH, WSL and container launches are this
 * transport with a different argv in front.
 *
 * The launcher observes and reports; it never guesses why a child failed. It
 * exposes the exit status, a bounded tail of stderr and a termination sequence,
 * and leaves the classification to the caller (see `classifySshExit`).
 */

import {
  type ChildProcess,
  type SpawnOptions as ChildSpawnOptions,
  spawn,
} from 'node:child_process';
import { CLOSE_CODES } from '../close';
import { resolveIntegerAtLeast } from '../codec/limits';
import { DEFAULT_MAX_FRAME_BYTES, MIN_MAX_FRAME_BYTES } from '../codec/ndjson';
import type { Port, PortClosure } from '../port';
import type { Frame } from '../schemas/frames';
import { type ByteSink, createNdjsonPort, type NdjsonPortHandle } from './ndjson-port';
import { asError, createStreamPort, toBytes } from './node-stream';
import { lastNonEmptyLine } from './text';

/** How the child ended: an exit code, or the signal that killed it. */
export interface ExitStatus {
  readonly code: number | null;
  readonly signal: string | null;
}

/**
 * What a launch that never reached a handshake left behind, in the one shape a
 * caller needs to say why: the child's status, whether it ever became a
 * process, and the last thing it said.
 */
export interface SpawnStartError {
  /**
   * How the child ended, or **undefined** when the exit had not landed inside
   * the grace. The pipes closing and the exit are not ordered, so "not known
   * yet" is a state of its own rather than an exit with no code.
   */
  readonly exit: ExitStatus | undefined;
  /**
   * `code` of the spawn error when the command never became a process
   * (`ENOENT`, `EACCES`); undefined whenever a child was created, however
   * badly it then behaved. A remote shell that prints `ENOENT` for its own
   * reasons never lands here: this is the launcher's own observation, not a
   * reading of the child's bytes.
   */
  readonly spawnErrorCode: string | undefined;
  /** Last non-empty line of the stderr tail; empty when the child said nothing. */
  readonly stderrLine: string;
}

export interface SpawnOptions {
  /** The command and its arguments. Never a shell string: arguments stay data. */
  readonly argv: readonly string[];
  readonly cwd?: string;
  /** The child's whole environment. `sanitizedEnv()` when omitted. */
  readonly env?: Readonly<Record<string, string>>;
  /** Largest line the decoder accepts; the 16 MiB default of §11 when absent. */
  readonly maxFrameBytes?: number;
  /** How much of the child's stderr to keep for an error report; 16 KiB. */
  readonly stderrTailBytes?: number;
  /** How long end of stdin has to work before `SIGTERM`; 2 seconds. */
  readonly terminateGraceMs?: number;
  /** How long `SIGTERM` has to work before `SIGKILL`; 2 seconds. */
  readonly killGraceMs?: number;
  /**
   * How long `terminate()` waits for the exit once `SIGKILL` has been sent,
   * before giving up and resolving `undefined`; 2 seconds. A child stuck in
   * `D` state, or a Windows process whose `kill()` returns `false`, may never
   * exit at all — this bounds the wait so a shutdown awaiting `terminate()`
   * is delayed but never blocked forever. `exited` is unaffected: it keeps
   * waiting for the real exit.
   */
  readonly exitGraceMs?: number;
  /** Called with every stderr chunk, for a launcher that streams diagnostics. */
  readonly onStderr?: (chunk: Uint8Array) => void;
  /**
   * Hide the child's console window on Windows; `true` by default. A peer that
   * speaks NDJSON on stdio has nothing to show, and a wrapper launched through
   * a console host would otherwise flash a window at whoever is watching.
   */
  readonly windowsHide?: boolean;
}

/**
 * The one child-process call the launcher makes, injected so a test can see
 * what the launcher hands it without starting a process.
 *
 * @example
 * spawnPort({ argv: ['runtime'] }, (command, args, options) => fake(command, args, options));
 */
export type SpawnChild = (
  command: string,
  args: string[],
  options: ChildSpawnOptions
) => ChildProcess;

export interface SpawnedPeer {
  readonly port: Port;
  /** Undefined when the child never started. */
  readonly pid: number | undefined;
  /**
   * Resolves exactly once with how the child ended. A child that never started
   * resolves `{ code: null, signal: null }`; `stderrTail()` carries the reason.
   * Unlike `terminate()`, this is unbounded on purpose: it is the one promise
   * that always tells the truth about whether the child actually exited.
   */
  readonly exited: Promise<ExitStatus>;
  /**
   * The last `stderrTailBytes` bytes the child wrote, decoded as UTF-8. Read it
   * next to `exited`; the very last chunk of a child that died mid-write is
   * best effort, as any tail of a pipe is.
   */
  stderrTail(): string;
  /**
   * Closes stdin, then escalates to `SIGTERM` and `SIGKILL`. Idempotent: the
   * escalation runs once however many times this is called.
   *
   * Resolves with the exit status once the child is gone, or `undefined` once
   * `exitGraceMs` has passed since the last kill request without one landing —
   * a child stuck in `D` state, or a Windows process whose `kill()` returned
   * `false`, must not leave a caller awaiting `terminate()` stuck forever.
   * `undefined` is what this call observed, not a verdict: asking again once
   * the child has finally exited answers with its status. `exited` is the
   * promise to await for the real exit; it has no deadline.
   */
  terminate(): Promise<ExitStatus | undefined>;
}

/**
 * A peer this launcher started, which knows why a launch failed as well as
 * everything a peer of any origin exposes.
 *
 * The two are separate so that `SpawnedPeer` stays the shape a caller can
 * implement — an in-process peer, a test double — and what this SDK learns by
 * running a child lands here instead of on their side of the contract.
 */
export interface LaunchedPeer extends SpawnedPeer {
  /**
   * Changes the stdin-to-SIGTERM grace before termination starts. Returns
   * false if a closed port has already started the escalation sequence.
   *
   * @example
   * peer.setTerminateGraceMs(27_000); // after a successful handshake
   */
  setTerminateGraceMs(ms: number): boolean;
  /**
   * Why a launch that never reached a handshake failed, read once the child
   * has had `graceMs` to report how it ended. A refused launch is nearly
   * always gone already — a wrapper that could not start its target exits at
   * once — but the pipe closing and the exit are not ordered, and a caller
   * reading the status before it lands would see nothing at all.
   */
  startError(graceMs?: number): Promise<SpawnStartError>;
}

/** Reference size of the stderr tail a launcher keeps (spawn.md, Launching). */
const DEFAULT_STDERR_TAIL_BYTES = 16 * 1024;

/** Reference grace periods of the termination sequence (spawn.md, Termination). */
const DEFAULT_TERMINATE_GRACE_MS = 2000;
const DEFAULT_KILL_GRACE_MS = 2000;
const DEFAULT_EXIT_GRACE_MS = 2000;

/** How long `startError` waits for an exit status that has not landed yet. */
const DEFAULT_START_ERROR_GRACE_MS = 250;

const WINDOWS = process.platform === 'win32';

/** Variables a child is allowed to inherit (spawn.md, Launching). */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'TERM',
  'SHELL',
  'XDG_RUNTIME_DIR',
];

/** Locale variables are a family, not a fixed list. */
const LOCALE_PREFIX = 'LC_';

/** Secret-shaped names, stripped even when they survived the allowlist. */
const SECRET_PATTERNS: readonly RegExp[] = [/_TOKEN$/, /_SECRET$/, /_KEY$/, /PASSWORD/];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The environment a launched child inherits: an allowlist of the variables a
 * program needs to run, with secret-shaped names removed, plus whatever the
 * application adds on purpose.
 *
 * Names are matched case-insensitively because Windows spells its variables in
 * mixed case (`Path`, `SystemRoot`); the original spelling is what the child
 * receives.
 *
 * @example
 * sanitizedEnv(process.env, { MANGO_TOKEN: token }); // PATH, HOME, … plus the token
 */
export function sanitizedEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Readonly<Record<string, string>> = {}
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (!ENV_ALLOWLIST.includes(upper) && !upper.startsWith(LOCALE_PREFIX)) continue;
    if (SECRET_PATTERNS.some((pattern) => pattern.test(upper))) continue;
    kept[name] = value;
  }
  return { ...kept, ...extra };
}

/**
 * Starts a child process and speaks stdio through its pipes.
 *
 * stdout is the frame stream, stdin is the frame stream in the other direction,
 * and stderr goes to a bounded tail plus `onStderr`. A child that cannot start
 * (`ENOENT`, `EACCES`) closes the port, resolves `exited` with
 * `{ code: null, signal: null }` and puts the spawn error in `stderrTail()`.
 *
 * `spawnChild` is the child-process call itself, injected so a test can assert
 * what the launcher asks for without starting anything.
 *
 * @example
 * const peer = spawnPort({ argv: ['bun', 'runtime.ts'] });
 * const session = new Session(peer.port, { peer: { name: 'hub', version: '1', role: 'hub' } });
 * await peer.terminate();
 */
export function spawnPort(options: SpawnOptions, spawnChild: SpawnChild = spawn): LaunchedPeer {
  const command = options.argv[0];
  if (command === undefined || command.length === 0) {
    throw new Error(
      `spawn argv is ${JSON.stringify(options.argv)}; expected [command, ...args] with a non-empty command`
    );
  }
  // Resolved before `start()` runs, not after: `createStreamPort` is what
  // would otherwise throw on a sub-floor value, and by then the child is
  // already a running process this function has thrown away every handle
  // to — nothing left to signal it.
  const maxFrameBytes = resolveIntegerAtLeast(
    'maxFrameBytes',
    options.maxFrameBytes,
    DEFAULT_MAX_FRAME_BYTES,
    MIN_MAX_FRAME_BYTES
  );
  const tail = new BoundedTail(
    resolveIntegerAtLeast('stderrTailBytes', options.stderrTailBytes, DEFAULT_STDERR_TAIL_BYTES, 1)
  );
  // Resolved here for the same reason as `maxFrameBytes`: a grace the
  // sequence cannot honour must be refused at the call that set it, not
  // discovered by a shutdown that reports a healthy child as unreaped.
  const graces = resolveGraces(options);
  const exit = deferredExit();
  const launch = new LaunchRecord();

  const child = start(spawnChild, command, options.argv.slice(1), options, tail, exit, launch);
  const limit = { maxFrameBytes };
  const handle =
    child?.stdin && child.stdout
      ? createStreamPort(child.stdout, child.stdin, limit)
      : createNdjsonPort({ sink: unspawnedSink(), ...limit });
  wire(child, handle, options, tail, exit, launch);

  let termination: Promise<ExitStatus | undefined> | undefined;
  let terminateGraceMs = graces.terminateMs;
  const terminate = async (): Promise<ExitStatus | undefined> => {
    // The escalation runs once, but its answer is not cached: a child that
    // outlived the graces and exited afterwards has an exit status now, and
    // a caller who asks again deserves it rather than the `undefined` the
    // first call was right about at the time.
    termination ??= escalate(child, handle, exit.promise, {
      ...graces,
      terminateMs: terminateGraceMs,
    });
    return (await termination) ?? (await settledStatus(exit.promise));
  };
  // The launcher owns the child's lifetime whichever side ended the port: a
  // refused line or a stdout the child closed ends the session, and a child
  // that then ignores the end of its stdin must still be escalated.
  handle.port.onClosed(() => void terminate());

  return {
    port: launcherPort(handle, terminate),
    pid: child?.pid,
    exited: exit.promise,
    stderrTail: () => tail.text(),
    startError: (graceMs = DEFAULT_START_ERROR_GRACE_MS) =>
      observeStartError(exit.promise, tail, launch, graceMs),
    setTerminateGraceMs: (ms) => {
      const next = resolveIntegerAtLeast('terminateGraceMs', ms, terminateGraceMs, 0);
      if (termination !== undefined) return false;
      terminateGraceMs = next;
      return true;
    },
    terminate,
  };
}

/**
 * Reads the launch failure once the exit has had its grace to land. The status
 * is left undefined rather than invented when the grace runs out, because a
 * caller telling somebody what to do about the failure must be able to tell
 * "the child exited without a code" from "the child had not exited yet".
 */
async function observeStartError(
  exited: Promise<ExitStatus>,
  tail: BoundedTail,
  launch: LaunchRecord,
  graceMs: number
): Promise<SpawnStartError> {
  const landed = await settledWithin(exited, graceMs);
  return {
    exit: landed ? await exited : undefined,
    spawnErrorCode: launch.spawnErrorCode,
    stderrLine: lastNonEmptyLine(tail.text()) ?? '',
  };
}

/**
 * Spawns the child, or records the failure. A synchronous throw and an
 * asynchronous `error` event mean the same thing to the launcher, and Bun and
 * Node do not agree on which one an unusable argv produces.
 */
function start(
  spawnChild: SpawnChild,
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  tail: BoundedTail,
  exit: DeferredExit,
  launch: LaunchRecord
): ChildProcess | undefined {
  try {
    return spawnChild(command, [...args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env !== undefined ? { ...options.env } : sanitizedEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: options.windowsHide ?? true,
    });
  } catch (cause) {
    const error = withErrorCode(asError(cause));
    launch.refused(error);
    tail.appendText(`\n${error.message}\n`);
    exit.settle({ code: null, signal: null });
    return undefined;
  }
}

/** Connects the child's three pipes to the port, the tail and the exit promise. */
function wire(
  child: ChildProcess | undefined,
  handle: NdjsonPortHandle,
  options: SpawnOptions,
  tail: BoundedTail,
  exit: DeferredExit,
  launch: LaunchRecord
): void {
  if (child === undefined) {
    // Nothing will ever drive the port, so report the closure once the caller
    // has had the chance to subscribe.
    queueMicrotask(() => handle.failed(new Error(tail.text().trim() || 'the child never started')));
    return;
  }
  // `exit` rather than `close`: a descendant that inherited the pipes can hold
  // `close` off for as long as it likes, and a shutdown must not wait on one.
  // Node documents that `exit` may precede the stdio close, but Bun and Node
  // both delivered the child's whole stderr first in every probe up to 1 MiB,
  // so the tail a caller reads at `exited` was complete each time.
  child.on('exit', (code, signal) => exit.settle({ code, signal }));
  child.on('error', (cause) => {
    const error = withErrorCode(asError(cause));
    // `pid` is undefined exactly when no process was created, which is what
    // separates a command that could not be started from a later failure —
    // a signal that could not be delivered — on a child that did start.
    if (child.pid === undefined) launch.refused(error);
    tail.appendText(`\n${error.message}\n`);
    handle.failed(error);
    exit.settle({ code: null, signal: null });
  });
  child.stdout?.on('data', (chunk: unknown) => {
    console.error('DIAG raw stdout bytes', toBytes(chunk).length, Date.now());
  });
  if (child.stderr) {
    child.stderr.on('data', (chunk: unknown) => {
      const bytes = toBytes(chunk);
      tail.append(bytes);
      options.onStderr?.(bytes);
    });
    child.stderr.on('error', () => {
      // Diagnostics are best effort; a broken stderr must not fail the session.
    });
  }
}

/**
 * The port the launcher hands out: the NDJSON port, plus a `close` that starts
 * the termination sequence the child's lifetime depends on.
 */
function launcherPort(
  handle: NdjsonPortHandle,
  terminate: () => Promise<ExitStatus | undefined>
): Port {
  const inner = handle.port;
  return {
    ...(inner.maxFrameBytes !== undefined ? { maxFrameBytes: inner.maxFrameBytes } : {}),
    send: (frame: Frame) => inner.send(frame),
    onFrame: (listener: (frame: Frame) => void) => inner.onFrame(listener),
    onClosed: (listener: (closure: PortClosure) => void) => inner.onClosed(listener),
    close: (code: number, reason?: string) => {
      inner.close(code, reason);
      void terminate();
    },
  };
}

/**
 * End of stdin, then `SIGTERM`, then `SIGKILL`, each after its grace period.
 * Windows has no POSIX signals, so both signal steps collapse into terminating
 * the process (spawn.md, Termination).
 */
async function escalate(
  child: ChildProcess | undefined,
  handle: NdjsonPortHandle,
  exited: Promise<ExitStatus>,
  graces: Graces
): Promise<ExitStatus | undefined> {
  // A `close` frame first, so a conforming child knows why it is leaving; the
  // port ends stdin behind it, which is step 1 of the sequence.
  handle.port.close(CLOSE_CODES.RELEASED, 'launcher terminating');
  if (child?.stdin?.writable) child.stdin.end();
  // The spawn-error path already settles `exited` synchronously-ish, so a
  // child that never started never reaches the bounded wait below.
  if (child === undefined) return await exited;

  if (await settledWithin(exited, graces.terminateMs)) return await exited;
  kill(child, 'SIGTERM');

  if (await settledWithin(exited, graces.killMs)) return await exited;
  kill(child, 'SIGKILL');

  // Bounded from here: a child that ignores SIGKILL (a process stuck in `D`
  // state, a Windows `kill()` that returned `false`) must not keep a shutdown
  // awaiting `terminate()` stuck forever. `exited` itself stays unbounded.
  return (await settledWithin(exited, graces.exitMs)) ? await exited : undefined;
}

function kill(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Windows terminates rather than signals; `kill('SIGKILL')` there would be
  // the same call with a name the platform cannot deliver.
  if (WINDOWS) child.kill();
  else child.kill(signal);
}

/** The three bounded waits of spawn.md's termination sequence, in milliseconds. */
interface Graces {
  readonly terminateMs: number;
  readonly killMs: number;
  readonly exitMs: number;
}

/**
 * Reads the three termination graces, refusing anything that is not a
 * whole, non-negative number of milliseconds where it was written. A
 * negative `exitGraceMs` would otherwise fire its timer before any exit
 * could land, so `terminate()` would report every child as unreaped — a
 * healthy one that left on the end of its stdin included.
 *
 * `0` is admitted and reads as "do not wait" — the same meaning
 * `settledStatus` gives `settledWithin(exited, 0)` — because a caller asking
 * the sequence to move straight to its next step is asking for something the
 * sequence can honour. A negative value is not that; it is a mistake.
 *
 * @example
 * resolveGraces({ argv: ['runtime'], exitGraceMs: 500 }).exitMs; // 500
 */
function resolveGraces(options: SpawnOptions): Graces {
  return {
    terminateMs: resolveIntegerAtLeast(
      'terminateGraceMs',
      options.terminateGraceMs,
      DEFAULT_TERMINATE_GRACE_MS,
      0
    ),
    killMs: resolveIntegerAtLeast('killGraceMs', options.killGraceMs, DEFAULT_KILL_GRACE_MS, 0),
    exitMs: resolveIntegerAtLeast('exitGraceMs', options.exitGraceMs, DEFAULT_EXIT_GRACE_MS, 0),
  };
}

/** The exit status if it has already landed, `undefined` while it has not. */
async function settledStatus(exited: Promise<ExitStatus>): Promise<ExitStatus | undefined> {
  return (await settledWithin(exited, 0)) ? await exited : undefined;
}

/** True when the promise settled inside the grace, false when the grace ran out. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const grace = setTimeout(() => resolve(false), ms);
    grace.unref();
    void promise.then(
      () => {
        clearTimeout(grace);
        resolve(true);
      },
      () => {
        clearTimeout(grace);
        resolve(true);
      }
    );
  });
}

/** The sink of a child that never started: every write is a broken pipe. */
function unspawnedSink(): ByteSink {
  return {
    write: () => {
      throw new Error(
        'the child process never started; expected a running child, received a failed spawn'
      );
    },
    end: () => {
      // There is no pipe to release.
    },
  };
}

interface DeferredExit {
  readonly promise: Promise<ExitStatus>;
  settle(status: ExitStatus): void;
}

/** Resolves exactly once, whichever of `exit`, `error` or a throw came first. */
function deferredExit(): DeferredExit {
  let resolve: (status: ExitStatus) => void = () => undefined;
  const promise = new Promise<ExitStatus>((settle) => {
    resolve = settle;
  });
  let settled = false;
  return {
    promise,
    settle: (status) => {
      if (settled) return;
      settled = true;
      resolve(status);
    },
  };
}

/**
 * What the launcher itself observed about a launch that never produced a
 * process. Kept apart from the stderr tail on purpose: the tail is the child's
 * account of things, and a remote shell is free to print `ENOENT` in it.
 */
class LaunchRecord {
  #spawnErrorCode: string | undefined;

  /** Records the error of a command that never became a process. */
  refused(error: Error): void {
    this.#spawnErrorCode ??= errorCode(error);
  }

  get spawnErrorCode(): string | undefined {
    return this.#spawnErrorCode;
  }
}

/** The last N bytes written to it, so a diagnostic never grows without bound. */
class BoundedTail {
  readonly #limit: number;
  #bytes = new Uint8Array(0);

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.#bytes.byteLength + chunk.byteLength);
    merged.set(this.#bytes, 0);
    merged.set(chunk, this.#bytes.byteLength);
    this.#bytes =
      merged.byteLength <= this.#limit ? merged : merged.slice(merged.byteLength - this.#limit);
  }

  appendText(text: string): void {
    this.append(encoder.encode(text));
  }

  text(): string {
    return decoder.decode(this.#bytes);
  }
}

/**
 * A spawn error whose message names its code. Node says `spawn x ENOENT`,
 * Bun on Windows says `Executable not found in $PATH: "x"` with the code only
 * on the object; a launcher that reports the message needs the code in it.
 *
 * @example
 * withErrorCode(Object.assign(new Error('not found'), { code: 'ENOENT' })).message; // 'ENOENT: not found'
 */
export function withErrorCode(error: Error): Error {
  const code = errorCode(error);
  if (code === undefined || error.message.includes(code)) return error;
  const named = new Error(`${code}: ${error.message}`, { cause: error });
  (named as { code?: string }).code = code;
  return named;
}

/** The `code` an operating-system error carries, when it carries one. */
function errorCode(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}
