/**
 * Hub launch of a runtime on an SSH host (`transportKind: 'ssh'`).
 *
 * There is no fifth wire protocol here. `ssh` is spawned as a child, the
 * runtime runs on the far side of the pipe it opens, and the stdio transport
 * speaks through it unchanged — the same spawn, handshake, and teardown a WSL
 * distribution goes through, with a different argv in front.
 *
 * Two things differ from a local child. The handshake budget is larger, because
 * a TCP round trip and a key exchange happen before the remote process starts.
 * And release equality is not a gate: the binary on that machine is not part of
 * this hub's distribution, so a drift is reported rather than refused, and the
 * protocol version stays the thing that decides whether the two can talk.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { RuntimeRemoteError } from '@mangostudio/runtime';
import type { SshFailureReason } from '@mangostudio/shared/environments';
import { expandUserPath, sshLaunchCommand } from '@mangostudio/shared/environments';
import { getVersion } from '../../lib/config';
import { environmentConfigFor } from '../../modules/environments/domain/environment-config';
import {
  classifySshFailure,
  describeSshFailure,
} from '../../modules/environments/domain/ssh-failure';
import { RuntimeClient } from './runtime-client';
import { type RuntimeLaunchFailure, spawnRuntimeChild } from './spawn-runtime-child';

/**
 * Longer than a local spawn's five seconds: a connection setup, an
 * authentication exchange, and a process start on the far machine all happen
 * before the first frame, and a busy host on a slow link uses all of it.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/** Minimal definition shape — kept local to avoid a cycle with the manager. */
export interface SshRuntimeDefinition {
  readonly id: string;
  readonly config: unknown;
}

export interface SshRuntimeConnection {
  readonly client: RuntimeClient;
  close(): void | Promise<void>;
}

export async function connectSshRuntime(
  definition: SshRuntimeDefinition,
  onUnavailable: () => void
): Promise<SshRuntimeConnection> {
  const config = environmentConfigFor('ssh', definition.config);
  // OpenSSH expands `~/…` for `-i`; `existsSync` does not. Resolve the same
  // home-relative form before the precheck and pass the expanded path through
  // so the check and the argv agree.
  const identityFile = config.identityFile
    ? expandUserPath(config.identityFile, homedir())
    : undefined;
  const launchConfig = identityFile ? { ...config, identityFile } : config;

  // ssh only warns about an identity file it cannot read and then carries on to
  // fail authentication, which reads back as "the host refused your key" —
  // true, and useless. Checking first names the file instead.
  if (identityFile && !existsSync(identityFile)) {
    throw new RuntimeRemoteError(
      'RUNTIME_UNAVAILABLE',
      `The identity file ${config.identityFile} configured on environment "${definition.id}" does not exist.`,
      { sshFailureReason: 'auth-refused' satisfies SshFailureReason }
    );
  }

  // Set by the describer below, which is the only place that sees the child's
  // stderr and exit status. It travels on the thrown error so the environment
  // card can offer the fix rather than only the sentence.
  let failureReason: SshFailureReason = 'unknown';

  try {
    const connection = await spawnRuntimeChild({
      environmentId: definition.id,
      launch: sshLaunchCommand(launchConfig),
      hubVersion: getVersion(),
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      requireMatchingRelease: false,
      describeFailure: (failure: RuntimeLaunchFailure) => {
        failureReason = classifySshFailure({
          stderr: failure.stderr,
          exitCode: failure.exitCode,
          spawnErrorCode: failure.spawnErrorCode,
        });
        // An unrecognised failure keeps the generic message, which already
        // carries the stderr tail: a protocol mismatch reported by a runtime
        // that did answer is described better there than by anything ssh said.
        return failureReason === 'unknown'
          ? undefined
          : describeSshFailure(failureReason, config, failure.stderr);
      },
      onClosed: onUnavailable,
    });

    return {
      client: new RuntimeClient(connection.client, onUnavailable),
      close: () => connection.close(),
    };
  } catch (error) {
    throw withFailureReason(error, failureReason);
  }
}

/**
 * Re-throws with the classified reason attached, keeping whatever typed code
 * the launch produced. `PROTOCOL_MISMATCH` in particular has to survive: the
 * manager latches on it, and a runtime too old to speak this protocol is not
 * fixed by retrying.
 */
function withFailureReason(error: unknown, reason: SshFailureReason): RuntimeRemoteError {
  if (reason === 'unknown' && error instanceof RuntimeRemoteError) return error;
  const code = error instanceof RuntimeRemoteError ? error.code : 'RUNTIME_UNAVAILABLE';
  const message = error instanceof Error ? error.message : String(error);
  return new RuntimeRemoteError(code, message, {
    ...(error instanceof RuntimeRemoteError ? error.details : {}),
    sshFailureReason: reason,
  });
}
