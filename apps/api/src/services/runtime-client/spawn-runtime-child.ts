/**
 * Spawns a runtime child and speaks the protocol over its pipes.
 *
 * The command to run is resolved by the caller, so a launcher that reaches its
 * target through a wrapper — a WSL distro, an SSH host — supplies its own argv
 * and reuses everything here. The child is an execution target, not a trusted
 * peer of the hub process: it gets a sanitized environment with no connector
 * keys or auth secret, and an argv assembled from discrete arguments rather
 * than a command string.
 *
 * The launcher itself is the SDK's: it observes and reports — the exit status,
 * a bounded stderr tail, the termination sequence — and never guesses why a
 * child failed. Turning what it observed into a sentence somebody can act on is
 * this file's job, and a wrapper that knows more says so through
 * `describeFailure`.
 */

import { statSync } from 'node:fs';
import { RESERVED_ERROR_CODES, RemoteError, type SessionClosure } from '@mangostudio/protocol';
import { type SpawnedPeer, spawnPort } from '@mangostudio/protocol/spawn';
import { sanitizeShellEnv } from '@mangostudio/runtime';
import { createDiagnosticLogger } from '../../lib/logger';
import type { RuntimeLaunchCommand } from '../../lib/runtime-paths';
import { type HubSession, openHubSession, type ProtocolHubSession } from './hub-session';

const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Grace between end of stdin and SIGTERM when a runtime does not unwind on its own. */
const TERMINATE_GRACE_MS = 2_000;
/** Further wait after SIGTERM before the launcher escalates to SIGKILL. */
const KILL_GRACE_MS = 2_000;
const MAX_STDERR_BYTES = 16_384;
const STDERR_EXCERPT_MAX_CHARS = 2_000;
/** How long a failed launch waits for the child's exit status before reporting. */
const EXIT_OBSERVATION_GRACE_MS = 250;

/** Spawn failures the built-in explanation can tell apart, read off the stderr tail. */
const SPAWN_ERROR_CODES = ['ENOENT', 'EACCES'] as const;

const logger = createDiagnosticLogger('runtime-stdio');

export interface SpawnedRuntimeConnection {
  readonly hub: HubSession;
  /** Resolves once the child process is gone, so shutdown can wait for it. */
  close(): Promise<void>;
}

/** What a launch left behind when it did not reach a handshake. */
export interface RuntimeLaunchFailure {
  readonly command: string;
  /** Bounded tail of the child's stderr; often the only account of the cause. */
  readonly stderr: string;
  /** Exit status of the child, or null when it had not exited yet. */
  readonly exitCode: number | null;
  /** `code` of a spawn error, when the command could not be started at all. */
  readonly spawnErrorCode: string | undefined;
  /** The handshake failure itself, typed when the child got far enough to say. */
  readonly error: unknown;
}

export interface SpawnRuntimeChildOptions {
  readonly environmentId: string;
  readonly launch: RuntimeLaunchCommand;
  readonly cwd?: string;
  readonly hubVersion: string;
  readonly handshakeTimeoutMs?: number;
  /**
   * Whether a runtime from another release is refused. True for a runtime that
   * ships inside this hub's own distribution — a mismatch there is a stale
   * install, not a peer to negotiate with. A launcher that reaches a machine
   * the hub does not install onto turns it off: release equality cannot gate a
   * binary someone else owns, and the protocol version still does.
   */
  readonly requireMatchingRelease?: boolean;
  /**
   * Replaces the explanation a failed launch reports. A launcher that runs
   * through a wrapper knows things this file cannot — that `ssh` says
   * everything through exit 255, say — so it reads the same bounded stderr and
   * says what to do about it. Returning undefined keeps the built-in message,
   * which is the right answer whenever the wrapper has nothing to add.
   */
  readonly describeFailure?: (failure: RuntimeLaunchFailure) => string | undefined;
  /** Fires once when the child or its pipes die after a successful handshake. */
  readonly onClosed: () => void;
}

/**
 * Starts a runtime child over stdio and resolves once its handshake completes.
 *
 * @example
 * const connection = await spawnRuntimeChild({
 *   environmentId: 'devbox',
 *   launch: resolveRuntimeLaunchCommand(),
 *   hubVersion: getVersion(),
 *   onClosed: () => manager.markUnavailable(),
 * });
 * await connection.hub.request('runtime.health', {});
 */
export async function spawnRuntimeChild(
  options: SpawnRuntimeChildOptions
): Promise<SpawnedRuntimeConnection> {
  const { launch } = options;
  const peer = spawnPort({
    argv: [launch.command, ...launch.args, '--stdio'],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    // The hub's own denylist rather than the SDK's allowlist: this child is a
    // MangoStudio runtime, and the allowlist would strip the VERSION and
    // MANGO_HOME it resolves its release and its slot from. What it must not
    // inherit is a credential, and `sanitizeShellEnv` is the stricter of the
    // two about those — it also catches values that carry one in a URL.
    env: sanitizeShellEnv({}, process.env),
    stderrTailBytes: MAX_STDERR_BYTES,
    terminateGraceMs: TERMINATE_GRACE_MS,
    killGraceMs: KILL_GRACE_MS,
  });

  let hub: ProtocolHubSession;
  try {
    hub = await openHubSession(peer.port, {
      hubVersion: options.hubVersion,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      // Defaults to on: the runtime ships inside the hub's own distribution, so
      // a binary from another release is a stale install rather than a peer to
      // negotiate with.
      requireMatchingRelease: options.requireMatchingRelease ?? true,
    });
  } catch (error) {
    // Asked of the launcher rather than left to the session: a port that closed
    // on its own has already put the session in `closed`, which makes the
    // session's own `close()` — and the terminate behind it — a no-op.
    void peer.terminate();
    const failure = await observeLaunchFailure(peer, launch.command, error);
    throw asRemoteFailure(
      error,
      options.describeFailure?.(failure) ?? describeLaunchFailure(failure, options.cwd)
    );
  }

  let released = false;
  let exited: Promise<void> = Promise.resolve();
  const release = (notify: boolean, reason: string): Promise<void> => {
    if (released) return exited;
    released = true;
    if (notify) {
      logger.warn('connection_lost', {
        environmentId: options.environmentId,
        reason,
        stderr: excerpt(peer.stderrTail()),
      });
    }
    // Closing the session ends the child's stdin, which is how a healthy
    // runtime is asked to unwind; the launcher's escalation covers one that
    // will not.
    hub.close();
    exited = peer.terminate().then(() => undefined);
    if (notify) options.onClosed();
    return exited;
  };
  // A child that dies before the handshake is reported by the rejected connect
  // attempt above; only a connection the hub already handed out needs the loss
  // pushed back to it.
  hub.session.onClose((closure) => {
    void release(true, describeSessionClosure(closure));
  });

  return {
    hub,
    close: () => release(false, 'closed by the hub'),
  };
}

/**
 * Everything a describer needs about a launch that never handshaked, read once
 * the child has had a moment to report how it ended.
 *
 * The child is nearly always gone already — a wrapper that could not start its
 * target exits at once — but the pipe closing and the exit race, and a describer
 * reading the status before it lands would see nothing. The termination the
 * caller has just started settles this quickly either way, and the report goes
 * out on the grace when it does not.
 *
 * @example
 * const failure = await observeLaunchFailure(peer, 'ssh', error);
 * classifySshFailure({ stderr: failure.stderr, exitCode: failure.exitCode });
 */
async function observeLaunchFailure(
  peer: SpawnedPeer,
  command: string,
  error: unknown
): Promise<RuntimeLaunchFailure> {
  const status = await settledWithin(peer.exited, EXIT_OBSERVATION_GRACE_MS);
  const stderr = peer.stderrTail();
  return {
    command,
    stderr,
    exitCode: status?.code ?? null,
    spawnErrorCode: spawnErrorCodeOf(peer, stderr),
    error,
  };
}

/**
 * The `code` of a spawn error, when the command could not be started at all.
 *
 * `pid` is undefined exactly when no process was created, and the launcher puts
 * the spawn error's message — which always names its code — in the stderr tail.
 * Reading both is what keeps a remote shell that happens to print `ENOENT` from
 * being mistaken for a wrapper the hub could not start.
 *
 * @example
 * spawnErrorCodeOf(peer, 'spawn wsl.exe ENOENT'); // 'ENOENT' when peer.pid is undefined
 */
function spawnErrorCodeOf(peer: SpawnedPeer, stderrTail: string): string | undefined {
  if (peer.pid !== undefined) return undefined;
  return SPAWN_ERROR_CODES.find((code) => stderrTail.includes(code));
}

/**
 * Turns a launch failure into a message that names the next step. A missing
 * binary and a runtime that started but never answered need different fixes,
 * and the child's stderr is usually the only place the reason appears.
 *
 * @example
 * describeLaunchFailure(failure, '/srv/project');
 */
function describeLaunchFailure(failure: RuntimeLaunchFailure, cwd: string | undefined): string {
  const spawnCode = failure.spawnErrorCode;
  // A working directory the target cannot enter fails the spawn with the same
  // codes a bad executable does, so blame it before the binary: telling someone
  // to reinstall over a mistyped cwd sends them to the wrong fix entirely.
  if (spawnCode !== undefined && cwd && !isUsableDir(cwd)) {
    return `The working directory ${cwd} configured on this environment is missing or not readable.`;
  }
  if (spawnCode === 'ENOENT') {
    return `The runtime binary was not found at ${failure.command}. Reinstall MangoStudio so it ships beside the hub, or set a binary path on this environment.`;
  }
  if (spawnCode === 'EACCES') {
    return `The runtime binary at ${failure.command} is not executable.`;
  }
  if (isReleaseMismatch(failure.error)) {
    return `${failure.error.message} Reinstall MangoStudio so the hub and runtime come from the same release.`;
  }
  // A wire major nobody shares: refused by a runtime that did answer, so the
  // protocol said what disagreed better than a closed pipe ever could.
  if (
    failure.error instanceof RemoteError &&
    failure.error.code === RESERVED_ERROR_CODES.PROTOCOL_MISMATCH
  ) {
    return failure.error.message;
  }

  const base = `The runtime at ${failure.command} did not complete its handshake: ${
    failure.error instanceof Error ? failure.error.message : String(failure.error)
  }`;
  const tail = excerpt(failure.stderr);
  return tail ? `${base}\nRuntime stderr:\n${tail}` : base;
}

/**
 * True when the peer speaks this wire version but ships a different release.
 *
 * That check is the launcher's own — it asked for release equality because it
 * installed the binary — so the remediation is the launcher's to add. A wire
 * major nobody shares is a different failure with a different fix, and
 * `openHubSession` names the two versions only for the release case.
 *
 * @example
 * isReleaseMismatch(new RemoteError('PROTOCOL_MISMATCH', '…', { runtimeVersion: '0.1.0' }));
 */
function isReleaseMismatch(error: unknown): error is RemoteError {
  return (
    error instanceof RemoteError &&
    error.code === RESERVED_ERROR_CODES.PROTOCOL_MISMATCH &&
    typeof error.details?.runtimeVersion === 'string'
  );
}

/** One sentence naming why a live session ended, for the connection-lost log. */
function describeSessionClosure(closure: SessionClosure): string {
  if (closure.error) return closure.error.message;
  return closure.reason ?? 'The runtime pipe closed.';
}

/**
 * Keeps a typed protocol code (a version mismatch, say) so the environment's
 * status can say why rather than reporting a generic outage.
 */
function asRemoteFailure(error: unknown, message: string): RemoteError {
  const typed = error instanceof RemoteError ? error : null;
  return new RemoteError(typed?.code ?? RESERVED_ERROR_CODES.UNAVAILABLE, message, typed?.details);
}

function excerpt(stderr: string): string {
  return stderr.trim().slice(-STDERR_EXCERPT_MAX_CHARS);
}

/** The promise's value when it settles inside the grace, undefined when it does not. */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const grace = setTimeout(() => resolve(undefined), ms);
    grace.unref?.();
    void promise.then(
      (value: T) => {
        clearTimeout(grace);
        resolve(value);
      },
      () => {
        clearTimeout(grace);
        resolve(undefined);
      }
    );
  });
}

function isUsableDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
