/**
 * Spawns a `mangostudio-runtime` child and speaks the protocol over its pipes.
 *
 * The child is an execution target, not a trusted peer of the hub process: it
 * gets a sanitized environment with no connector keys or auth secret, and an
 * argv assembled from discrete arguments rather than a command string.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  createStdioFramePort,
  RuntimeProtocolClient,
  RuntimeRemoteError,
  sanitizeShellEnv,
} from '@mangostudio/runtime';
import type { StdioEnvironmentConfig } from '@mangostudio/shared/environments';
import { RuntimeProtocolError } from '@mangostudio/shared/runtime-protocol';
import { appendBoundedTail } from '../../lib/bounded-tail';
import { createDiagnosticLogger } from '../../lib/logger';
import { resolveRuntimeLaunchCommand } from '../../lib/runtime-paths';

const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Grace between SIGTERM and SIGKILL when a runtime does not unwind on its own. */
const KILL_GRACE_MS = 2_000;
const MAX_STDERR_CHARS = 16_384;
const STDERR_EXCERPT_MAX_CHARS = 1_000;

const logger = createDiagnosticLogger('runtime-stdio');

export interface StdioRuntimeConnection {
  readonly client: RuntimeProtocolClient;
  close(): void;
}

export interface StdioRuntimeLaunchOptions {
  readonly environmentId: string;
  readonly config: StdioEnvironmentConfig;
  readonly hubVersion: string;
  readonly handshakeTimeoutMs?: number;
  /** Fires once when the child or its pipes die after a successful handshake. */
  readonly onClosed: () => void;
}

/** Starts a runtime child and resolves once its handshake completes. */
export async function launchStdioRuntime(
  options: StdioRuntimeLaunchOptions
): Promise<StdioRuntimeConnection> {
  const launch = resolveRuntimeLaunchCommand(options.config.binaryPath);
  const child = spawn(launch.command, [...launch.args, '--stdio'], {
    ...(options.config.cwd ? { cwd: options.config.cwd } : {}),
    env: sanitizeShellEnv({}, process.env),
    stdio: 'pipe',
    windowsHide: true,
  });

  let stderrTail = '';
  let spawnError: Error | null = null;
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = appendBoundedTail(stderrTail, chunk.toString('utf8'), MAX_STDERR_CHARS);
  });
  child.on('error', (error: Error) => {
    spawnError = error;
  });
  // A write racing the child's exit surfaces as EPIPE on stdin. The closed port
  // already reports the loss, so this only keeps the error from going uncaught.
  child.stdin.on('error', () => undefined);

  let connected = false;
  let released = false;
  const release = (notify: boolean, reason: string): void => {
    if (released) return;
    released = true;
    if (notify) {
      logger.warn('connection_lost', {
        environmentId: options.environmentId,
        reason,
        stderr: excerpt(stderrTail),
      });
    }
    // Closing the client ends the child's stdin, which is how a healthy runtime
    // is asked to unwind; the kill covers one that will not.
    client.close();
    terminate(child);
    if (notify) options.onClosed();
  };

  const client = new RuntimeProtocolClient(
    createStdioFramePort({
      input: child.stdout,
      output: child.stdin,
      onClosed: (closure) =>
        // A child that dies before the handshake is reported by the rejected
        // connect attempt; only a connection the hub already handed out needs
        // the loss pushed back to it.
        release(
          connected,
          closure.kind === 'protocol-error' ? closure.error.message : 'The runtime pipe closed.'
        ),
    }),
    {
      hubVersion: options.hubVersion,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    }
  );

  try {
    await client.waitUntilReady();
  } catch (error) {
    release(false, 'handshake failed');
    throw asRuntimeError(
      error,
      describeLaunchFailure({ command: launch.command, error, spawnError, stderr: stderrTail })
    );
  }
  connected = true;

  return {
    client,
    close: () => release(false, 'closed by the hub'),
  };
}

/**
 * Turns a launch failure into a message that names the next step. A missing
 * binary and a runtime that started but never answered need different fixes,
 * and the child's stderr is usually the only place the reason appears.
 */
function describeLaunchFailure(context: {
  readonly command: string;
  readonly error: unknown;
  readonly spawnError: Error | null;
  readonly stderr: string;
}): string {
  if (context.error instanceof RuntimeProtocolError) return context.error.message;

  const spawnCode = (context.spawnError as { code?: string } | null)?.code;
  if (spawnCode === 'ENOENT') {
    return `The runtime binary was not found at ${context.command}. Reinstall MangoStudio so it ships beside the hub, or set a binary path on this environment.`;
  }
  if (spawnCode === 'EACCES') {
    return `The runtime binary at ${context.command} is not executable.`;
  }

  const base = context.spawnError
    ? `The runtime at ${context.command} could not be started: ${context.spawnError.message}`
    : `The runtime at ${context.command} did not complete its handshake: ${
        context.error instanceof Error ? context.error.message : String(context.error)
      }`;
  const tail = excerpt(context.stderr);
  return tail ? `${base}\nRuntime stderr:\n${tail}` : base;
}

/**
 * Keeps a typed protocol code (a version mismatch, say) so the environment's
 * status can say why rather than reporting a generic outage.
 */
function asRuntimeError(error: unknown, message: string): RuntimeRemoteError {
  const typed =
    error instanceof RuntimeProtocolError || error instanceof RuntimeRemoteError ? error : null;
  return new RuntimeRemoteError(typed?.code ?? 'RUNTIME_UNAVAILABLE', message, typed?.details);
}

function excerpt(stderr: string): string {
  return stderr.trim().slice(-STDERR_EXCERPT_MAX_CHARS);
}

/**
 * Windows has no POSIX signals, so `kill` there terminates the runtime itself
 * but not shell children it already spawned. Those are reaped by the runtime's
 * own cancellation path in the normal case; a hard kill can still leave them.
 */
function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');

  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  escalation.unref?.();
  child.once('exit', () => clearTimeout(escalation));
}
