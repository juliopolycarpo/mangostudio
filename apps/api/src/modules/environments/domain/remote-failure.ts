/**
 * Classifies a failed remote (SSH) command into a cause a user can act on,
 * without ever returning the text it read.
 *
 * The signature tables live in {@link classifySshFailure}, which the connect
 * path already uses; this maps its reasons onto the smaller set a client-facing
 * refusal needs and pairs each with fixed copy. Input is stderr (or a thrown
 * error's message) plus the exit code when there is one. The raw text stays with
 * the caller for the hub log, and an unrecognised or localized line falls back
 * to `remote-command-failed`.
 */

import type { SshFailureReason } from '@mangostudio/shared/environments';

import { classifySshFailure } from './ssh-failure';

export const REMOTE_FAILURE_REASONS = [
  /** DNS, connect, timeout or a connection dropped before authentication. */
  'host-unreachable',
  /** The host key differs from the one on record, or could not be verified. */
  'host-key-mismatch',
  /** The server refused the SSH credentials. */
  'auth-failed',
  /** The command ran and the remote OS refused it, for example on the runtime directory. */
  'remote-permission-denied',
  /** Anything else, including output this classifier does not recognise. */
  'remote-command-failed',
] as const;

export type RemoteFailureReason = (typeof REMOTE_FAILURE_REASONS)[number];

export interface RemoteFailure {
  readonly reason: RemoteFailureReason;
  /** The cause and the fix as fixed text. Ends with the pointer to the hub log. */
  readonly message: string;
}

const REASON_BY_SSH_FAILURE: Readonly<Partial<Record<SshFailureReason, RemoteFailureReason>>> = {
  unreachable: 'host-unreachable',
  'host-key-unverified': 'host-key-mismatch',
  'auth-refused': 'auth-failed',
  // `rm: cannot remove …: Permission denied` ends in the shell's own refusal,
  // which the connect classifier reads as "present but not executable".
  'runtime-not-executable': 'remote-permission-denied',
};

const CAUSE_MESSAGES: Readonly<
  Record<Exclude<RemoteFailureReason, 'remote-command-failed'>, string>
> = {
  'host-unreachable':
    'The hub could not reach the machine over SSH. Check the host name, port and network, then try again. Details are in the hub log.',
  'host-key-mismatch':
    "The machine's SSH host key is not trusted or no longer matches the one on record. If the machine was rebuilt, remove its old entry from the hub user's known_hosts and connect once by hand to confirm the new key. Details are in the hub log.",
  'auth-failed':
    'The machine rejected the SSH credentials. Check the user name and identity file on the environment, then try again. Details are in the hub log.',
  'remote-permission-denied':
    "The machine refused the operation: permission denied for the SSH user. Check the owner and permissions of the runtime directory in that user's home, then try again. Details are in the hub log.",
};

/**
 * A step of a hub-driven remote sequence whose command exited non-zero.
 *
 * `message` is worded for the hub operator and embeds the command's output, so
 * it belongs in the hub log. A client-facing line is built from `step` and a
 * {@link classifyRemoteFailure} of `remote`, never from `message`.
 *
 * @example
 * throw new RemoteStepError('Pairing', 'Pairing failed: …', { exitCode: 255, output: stderr });
 */
export class RemoteStepError extends Error {
  constructor(
    /** The hub's own name for the step, such as `Pairing`. Never remote text. */
    readonly step: string,
    message: string,
    readonly remote: { readonly exitCode: number; readonly output: string }
  ) {
    super(message);
    this.name = 'RemoteStepError';
  }
}

/**
 * @example
 * classifyRemoteFailure({ exitCode: 255, output: 'Host key verification failed.' });
 * // { reason: 'host-key-mismatch', message: "The machine's SSH host key …" }
 */
export function classifyRemoteFailure(input: {
  readonly exitCode?: number;
  readonly output: string;
}): RemoteFailure {
  const reason =
    REASON_BY_SSH_FAILURE[
      classifySshFailure({ stderr: input.output, exitCode: input.exitCode ?? null })
    ];
  if (reason && reason !== 'remote-command-failed') {
    return { reason, message: CAUSE_MESSAGES[reason] };
  }
  // The exit code is a number the hub read, so it is safe to show.
  const exit =
    input.exitCode === undefined || !Number.isInteger(input.exitCode)
      ? ''
      : ` (exit code ${input.exitCode})`;
  return {
    reason: 'remote-command-failed',
    message: `The command on the machine failed${exit}. Check the machine, then try again. Details are in the hub log.`,
  };
}
