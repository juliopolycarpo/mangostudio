/**
 * Reads why an SSH launch failed out of what the client left behind.
 *
 * Exit codes barely help: OpenSSH reports every failure of its own — refused
 * authentication, an unverified host key, a timeout, a name that does not
 * resolve — as exit 255, and passes a remote command's status through
 * otherwise. So the signal is stderr, matched against a table of the client's
 * own message forms, with the exit status used only where it is unambiguous
 * (127 and 126 are the remote shell's "cannot execute" pair).
 *
 * A match must never be a guess. OpenSSH's text is locale-dependent in theory,
 * and a signature that misses falls through to `unknown` with the bounded
 * stderr tail attached — a user reading their own ssh output is better served
 * than one reading a confident wrong diagnosis.
 */

import { RUNTIME_SETUP_PENDING_SIGNATURE } from '@mangostudio/runtime';
import type { SshEnvironmentConfig, SshFailureReason } from '@mangostudio/shared/environments';
import {
  sshDestination,
  sshPreflightCommands,
  sshRuntimePath,
} from '@mangostudio/shared/environments';

export interface SshFailureContext {
  /** Bounded tail of the client's stderr; may be empty. */
  readonly stderr: string;
  /** Exit status of `ssh` itself, or null when it had not exited yet. */
  readonly exitCode: number | null;
  /** `code` of a spawn error, when the hub could not start `ssh` at all. */
  readonly spawnErrorCode?: string | undefined;
}

/** Exit statuses a POSIX shell uses for "found it but could not run it". */
const SHELL_NOT_FOUND_EXIT = 127;
const SHELL_NOT_EXECUTABLE_EXIT = 126;

const HOST_KEY_SIGNATURES = [
  /host key verification failed/i,
  /remote host identification has changed/i,
  /host key for .* has changed/i,
];

const AUTH_SIGNATURES = [
  // The parenthesised method list is what makes this ssh's own refusal rather
  // than a remote shell reporting a file it may not execute.
  /permission denied \(/i,
  /permission denied, please try again/i,
  /no supported authentication methods available/i,
  /too many authentication failures/i,
  /^.*authentication failed/im,
];

const UNREACHABLE_SIGNATURES = [
  /could not resolve hostname/i,
  /name or service not known/i,
  /nodename nor servname provided/i,
  /connection timed out/i,
  /operation timed out/i,
  /connection refused/i,
  /network is unreachable/i,
  /no route to host/i,
  /connection closed by remote host/i,
  /connection reset by peer/i,
  /banner exchange/i,
];

/** How a shell reports a command it could not find, across bash, dash, and zsh. */
const RUNTIME_MISSING_SIGNATURES = [
  /no such file or directory/i,
  /command not found/i,
  /:\s*not found\s*$/im,
];

/** `bash: /path: Permission denied` — present, but without the executable bit. */
const NOT_EXECUTABLE_SIGNATURES = [/permission denied\s*$/im, /cannot execute binary file/i];

export function classifySshFailure(context: SshFailureContext): SshFailureReason {
  if (context.spawnErrorCode === 'ENOENT') return 'client-missing';

  const stderr = withoutClientWarnings(context.stderr);

  // Ours before anyone's: only this runtime prints that phrase, and its stderr
  // also carries a path, which the missing-binary table would otherwise claim.
  if (stderr.toLowerCase().includes(RUNTIME_SETUP_PENDING_SIGNATURE)) return 'setup-pending';

  if (matchesAny(stderr, HOST_KEY_SIGNATURES)) return 'host-key-unverified';

  if (context.exitCode === SHELL_NOT_FOUND_EXIT) return 'runtime-missing';
  if (context.exitCode === SHELL_NOT_EXECUTABLE_EXIT) return 'runtime-not-executable';

  if (matchesAny(stderr, RUNTIME_MISSING_SIGNATURES)) return 'runtime-missing';
  if (matchesAny(stderr, NOT_EXECUTABLE_SIGNATURES)) return 'runtime-not-executable';
  if (matchesAny(stderr, AUTH_SIGNATURES)) return 'auth-refused';
  if (matchesAny(stderr, UNREACHABLE_SIGNATURES)) return 'unreachable';

  return 'unknown';
}

/**
 * Turns a reason into a sentence that names the next step.
 *
 * The remediation is the whole point of classifying: an unverified host key and
 * a missing binary both surface as "the runtime is unavailable", and the two
 * have nothing in common except that neither is fixed by pressing Connect
 * again.
 */
export function describeSshFailure(
  reason: SshFailureReason,
  config: SshEnvironmentConfig,
  stderrExcerpt: string
): string {
  const destination = sshDestination(config);
  const preflight = sshPreflightCommands(config);
  const base = ((): string => {
    switch (reason) {
      case 'client-missing':
        return 'No ssh client was found on this machine. Install OpenSSH (it ships with Windows 10 and later as an optional feature) and make sure ssh is on PATH.';
      case 'auth-refused':
        return `${destination} refused the credentials this machine offered. MangoStudio never types a password: add a key the host accepts, or point this environment at one with an identity file. Check it with: ${preflight.reach}`;
      case 'host-key-unverified':
        return `The host key for ${destination} is not in known_hosts, or no longer matches the one recorded there. MangoStudio will not accept an unknown key on your behalf — connect once by hand and confirm the fingerprint: ${preflight.reach}`;
      case 'unreachable':
        return `${destination} did not answer. Check the address, the port, and that this machine can route to it: ${preflight.reach}`;
      case 'runtime-missing':
        return `${destination} has no runtime at ${sshRuntimePath(config)}. Install one there, or set a runtime path on this environment pointing at the binary you already have. Check it with: ${preflight.runtime}`;
      case 'runtime-not-executable':
        return `The runtime at ${sshRuntimePath(config)} on ${destination} is not executable. Run chmod +x on it there.`;
      case 'setup-pending':
        return `The runtime on ${destination} is installed but has not been set up. Run "mangostudio-runtime setup" on that machine to say what it may do, then connect again.`;
      default:
        return `The runtime on ${destination} could not be started over ssh.`;
    }
  })();
  // A classified failure has already said what to do; repeating ssh's own words
  // under it is noise. An unclassified one has nothing else to offer.
  return reason === 'unknown' && stderrExcerpt ? `${base}\nssh stderr:\n${stderrExcerpt}` : base;
}

/**
 * Drops OpenSSH's non-fatal warnings before matching.
 *
 * `Warning: Identity file /x not accessible: No such file or directory.` is the
 * one that matters: ssh prints it and carries on, and leaving it in would make
 * every failure after it look like a missing remote binary.
 */
function withoutClientWarnings(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => !/^\s*Warning:/i.test(line))
    .join('\n');
}

function matchesAny(stderr: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(stderr));
}
