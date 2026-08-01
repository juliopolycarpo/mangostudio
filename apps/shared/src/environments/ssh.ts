/**
 * How the hub reaches a runtime over the system `ssh` client.
 *
 * SSH is a launcher, not a fifth protocol: what comes out of here is fed to the
 * same stdio spawn every other hub-started runtime uses, which appends its own
 * `--stdio`. Everything OpenSSH already solved — keys, agents, `~/.ssh/config`,
 * `ProxyJump`, `known_hosts` — is reused rather than reimplemented in JS.
 *
 * The builder lives in shared because two callers need one answer: the hub
 * spawns this argv, and the Add Environment dialog prints the reachability test
 * a user runs by hand. A second copy of the option list would drift the moment
 * one of them changed.
 */

import type { SshEnvironmentConfig } from './schemas';

/**
 * Where a runtime placed on a remote machine lives. `current` is a symlink the
 * installer swaps, so the default never embeds a version that dangles after an
 * upgrade. The field stays overridable for a machine that keeps it elsewhere.
 */
export const DEFAULT_SSH_RUNTIME_PATH = '~/.mango/runtime/remote/current/mangostudio-runtime';

/**
 * Options the hub sets on every SSH launch, whatever the user's `ssh_config`
 * says. Each one is load-bearing:
 *
 * - `BatchMode=yes` — nothing on the hub can answer a prompt, so a connection
 *   that would ask must fail instead of hanging until the handshake times out.
 * - `StrictHostKeyChecking=yes` is forced rather than left at the default
 *   `ask`, which fails under BatchMode anyway but only after a delay, and could
 *   be relaxed to `no` by ambient config. An unknown host key is refused: the
 *   first trust decision belongs to a human at a terminal, not to a server
 *   process accepting whatever answered on port 22.
 * - `ControlMaster=no ControlPath=none` — connection multiplexing is
 *   unsupported by Windows OpenSSH (no AF_UNIX sockets there) and a user's
 *   ambient config could otherwise switch it on for a long-lived pipe.
 * - The keepalives make a dead network surface as a closed pipe within ~45s
 *   rather than as a runtime that never answers again.
 */
export const SSH_FORCED_OPTIONS: readonly string[] = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  // Ambient `RemoteCommand` would collide with the runtime argv we always
  // supply after the destination (`Cannot execute command-line and remote
  // command.`). Force it off the same way multiplexing is forced off.
  '-o',
  'RemoteCommand=none',
];

export interface SshLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** `user@host` or bare `host`. Both halves are argv entries, never interpolated. */
export function sshDestination(config: SshEnvironmentConfig): string {
  return config.user ? `${config.user}@${config.host}` : config.host;
}

export function sshRuntimePath(config: SshEnvironmentConfig): string {
  return config.remoteRuntimePath?.trim() || DEFAULT_SSH_RUNTIME_PATH;
}

/**
 * argv that starts a runtime on an SSH host.
 *
 * Two different quoting worlds meet here. Hub-side, every value is a discrete
 * argv entry and nothing is interpolated — a host named `-oProxyCommand=…`
 * would otherwise be remote code execution on the hub, which is why the schema
 * refuses a leading dash, `--` ends option parsing, and the argv is an array.
 * Remote-side the rules are OpenSSH's, not ours: ssh joins everything after the
 * destination with spaces and hands the result to the target's login shell.
 * That is why `~` expands at all — and why the runtime path has to be quoted
 * here, or a path containing a space would arrive as two words and one holding
 * `;` or a backtick would arrive as a command.
 */
export function sshLaunchCommand(config: SshEnvironmentConfig): SshLaunchCommand {
  return {
    command: 'ssh',
    args: [
      ...SSH_FORCED_OPTIONS,
      // `IdentitiesOnly` keeps the agent from offering every key it holds
      // before the one that was configured, which is what exhausts a server's
      // `MaxAuthTries` and reads back as an authentication failure.
      ...(config.identityFile ? ['-o', 'IdentitiesOnly=yes', '-i', config.identityFile] : []),
      ...(config.port ? ['-p', String(config.port)] : []),
      // No pseudo-terminal: stdout carries protocol frames, and a tty would
      // translate them.
      '-T',
      '--',
      sshDestination(config),
      quoteForRemoteShell(sshRuntimePath(config)),
    ],
  };
}

/**
 * The reachability test to run by hand, and what it is for.
 *
 * It deliberately omits the forced options above. Running it interactively is
 * how a host key gets into `known_hosts` in the first place — the thing the hub
 * refuses to do on the user's behalf — so the copyable form has to be the one
 * that can prompt.
 */
export function sshPreflightCommands(config: SshEnvironmentConfig): {
  readonly reach: string;
  readonly runtime: string;
} {
  // These strings are pasted into a local interactive shell. Quote every value
  // the way that shell will parse it; the hub argv path never interpolates.
  const prefix = [
    'ssh',
    // Same collision as the hub launch path: ambient `RemoteCommand` plus a
    // trailing command argument fails before reach/runtime probes can run.
    '-o',
    'RemoteCommand=none',
    ...(config.port ? ['-p', String(config.port)] : []),
    ...(config.identityFile ? ['-i', quoteForLocalShell(config.identityFile)] : []),
    quoteForLocalShell(sshDestination(config)),
  ].join(' ');
  return {
    reach: `${prefix} true`,
    runtime: `${prefix} ${quoteRemoteCommandForLocalPaste(sshRuntimePath(config))} --version`,
  };
}

/**
 * Single-quotes a value for the target's login shell, keeping a leading `~/`
 * outside the quotes.
 *
 * A fully quoted `'~/…'` is a literal tilde — no shell expands one inside
 * quotes — so quoting the whole path would break the default the installer
 * writes. Tilde expansion applies to a word's unquoted prefix up to the first
 * slash, so `~/'.mango/…'` expands the home directory and leaves the rest
 * inert. Only an exact `~/` prefix is treated this way: `~user/…` is quoted
 * whole and fails as a path that does not exist, which is a clearer outcome
 * than guessing at another shell's expansion rules.
 */
export function quoteForRemoteShell(value: string): string {
  if (value.startsWith('~/')) return `~/${singleQuote(value.slice(2))}`;
  return singleQuote(value);
}

/**
 * Quotes a value for a command the user pastes into their own shell.
 *
 * Unlike {@link quoteForRemoteShell}, a leading `~/` stays inside the quotes:
 * identity files and destinations are expanded (or not) on the hub side, and
 * an unquoted tilde in a copied command would expand before `ssh` starts.
 */
export function quoteForLocalShell(value: string): string {
  return singleQuote(value);
}

/**
 * Remote command fragment for a copyable preflight line.
 *
 * The path still uses remote-shell quoting so the target expands `~/`, but a
 * leading tilde is escaped so the *local* shell does not rewrite it to the
 * hub user's home before `ssh` sees the argument.
 */
export function quoteRemoteCommandForLocalPaste(value: string): string {
  const remote = quoteForRemoteShell(value);
  return remote.startsWith('~/') ? `\\${remote}` : remote;
}

/**
 * Expands a leading `~/` the way OpenSSH does for `-i`, so a hub-side
 * existence check sees the same path the client will open.
 *
 * Only the current-user form is handled: `~other/` stays literal, matching
 * the remote-path quoting policy that refuses to guess another account's home.
 */
/**
 * Expands a leading `~/` the way OpenSSH does for `-i`, so a hub-side
 * existence check sees the same path the client will open.
 *
 * Only the current-user form is handled: `~other/` stays literal, matching
 * the remote-path quoting policy that refuses to guess another account's home.
 * `home` is injected so this helper stays free of `node:os` (the frontend
 * imports the rest of this module).
 */
export function expandUserPath(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return `${home}/${value.slice(2)}`;
  return value;
}

function singleQuote(value: string): string {
  // A single quote cannot appear inside single quotes, so each one closes the
  // string, contributes an escaped quote, and reopens it.
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
