/**
 * The hardened `ssh` argv preset of spec/transports/spawn.md, and the exit
 * classifier that goes with it.
 *
 * Both functions are pure: they build an argv array and read an exit status.
 * Nothing here spawns anything, so a caller can unit-test its launch command.
 */

import type { ExitStatus } from './spawn';
import { lastNonEmptyLine } from './text';

export interface SshArgvOptions {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  /** The remote path first, its arguments after. */
  readonly command: readonly string[];
  readonly connectTimeoutSeconds?: number;
}

/** Reference connect timeout of the preset. */
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;

const PORT_MIN = 1;
const PORT_MAX = 65535;

/** ssh reports every failure of its own with this status, whatever caused it. */
const SSH_OWN_FAILURE = 255;

/** A POSIX login shell says this when it cannot find the command. */
const COMMAND_NOT_FOUND = 127;

/**
 * The argv for launching a peer over the system `ssh` client, with every
 * option spawn.md calls load-bearing.
 *
 * @example
 * sshArgv({ host: 'build-box', command: ['mango-runtime', '--stdio'] });
 * // ['ssh', '-o', 'BatchMode=yes', …, '-T', '--', 'build-box', "'mango-runtime'", "'--stdio'"]
 */
export function sshArgv(options: SshArgvOptions): string[] {
  const host = checkedHost(options.host);
  const user = options.user === undefined ? undefined : checkedUser(options.user);
  const connectTimeout = checkedTimeout(
    options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS
  );
  const [remotePath, ...remoteArgs] = checkedCommand(options.command);

  const argv = [
    'ssh',
    // Nothing on this side can answer a prompt: a connection that would ask
    // must fail rather than hang until the handshake times out.
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${connectTimeout}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    // Set explicitly: the first trust decision belongs to a person at a terminal.
    '-o',
    'StrictHostKeyChecking=yes',
    // Multiplexing is unsupported on Windows OpenSSH, and ambient configuration
    // could otherwise enable it under a long-lived pipe.
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    // An ambient `RemoteCommand` in the user's ssh config collides with the
    // command placed after the destination ("Cannot execute command-line and
    // remote command."), so it is forced off the same way multiplexing is.
    '-o',
    'RemoteCommand=none',
  ];
  if (options.identityFile !== undefined) {
    argv.push('-o', 'IdentitiesOnly=yes', '-i', options.identityFile);
  }
  if (options.port !== undefined) argv.push('-p', String(checkedPort(options.port)));
  // `-T` because stdout carries frames a tty would translate, `--` so a host
  // spelled like an option cannot become one.
  argv.push('-T', '--', user === undefined ? host : `${user}@${host}`);
  // ssh joins everything after the destination with spaces and hands it to the
  // target's login shell, so every word is quoted for that shell.
  argv.push(quoteRemotePath(remotePath));
  for (const argument of remoteArgs) argv.push(singleQuote(argument));
  return argv;
}

/**
 * One sentence naming what an `ssh` exit status means, for the message a
 * launcher shows when a remote peer never completed the handshake.
 *
 * @example
 * classifySshExit({ code: 255, signal: null }, 'ssh: connect to host x port 22: timed out');
 */
export function classifySshExit(status: ExitStatus, stderrTail: string): string {
  if (status.code === SSH_OWN_FAILURE) {
    const detail = lastNonEmptyLine(stderrTail);
    const suffix = detail === undefined ? '' : `: ${detail}`;
    return `ssh exited 255, its own failure (connection, authentication or host key), not a status from the remote command${suffix}.`;
  }
  if (status.code === COMMAND_NOT_FOUND) {
    return 'ssh exited 127: the remote login shell could not find the command; check the remote path and the PATH of a non-interactive shell.';
  }
  if (status.signal !== null) {
    return `ssh was killed by ${status.signal} before the remote command reported a status.`;
  }
  if (status.code === null) {
    return 'ssh ended without an exit status, so the launcher could not observe how the remote command finished.';
  }
  return `ssh exited ${status.code}, which is the status the remote command returned.`;
}

function checkedHost(host: string): string {
  if (host.length === 0 || host.startsWith('-') || /\s/.test(host)) {
    throw new Error(
      `ssh host is ${JSON.stringify(host)}; expected a non-empty host name without whitespace and not beginning with "-"`
    );
  }
  return host;
}

function checkedUser(user: string): string {
  if (user.length === 0 || user.startsWith('-') || /\s/.test(user)) {
    throw new Error(
      `ssh user is ${JSON.stringify(user)}; expected a non-empty user name without whitespace and not beginning with "-"`
    );
  }
  return user;
}

function checkedPort(port: number): number {
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    throw new Error(`ssh port is ${port}; expected an integer between ${PORT_MIN} and ${PORT_MAX}`);
  }
  return port;
}

function checkedTimeout(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new Error(
      `ssh connectTimeoutSeconds is ${seconds}; expected an integer of at least 1 second`
    );
  }
  return seconds;
}

function checkedCommand(command: readonly string[]): readonly [string, ...string[]] {
  const [remotePath, ...rest] = command;
  if (remotePath === undefined || remotePath.length === 0) {
    throw new Error(
      `ssh command is ${JSON.stringify(command)}; expected [remotePath, ...remoteArgs] with a non-empty remote path`
    );
  }
  return [remotePath, ...rest];
}

/**
 * The remote path, quoted for the target's login shell. A leading `~/` stays
 * outside the quotes so the shell still expands it.
 */
function quoteRemotePath(remotePath: string): string {
  if (remotePath.startsWith('~/')) return `~/${singleQuote(remotePath.slice(2))}`;
  return singleQuote(remotePath);
}

/** POSIX single quoting: everything is literal, and a quote closes and reopens. */
function singleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
