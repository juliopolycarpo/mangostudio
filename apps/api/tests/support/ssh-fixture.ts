/**
 * A throwaway `sshd` for the suites that need a real SSH server.
 *
 * Everything the server needs lives in one temp directory created for the run:
 * a generated host key, a generated client key authorised for the current user,
 * the config, and a `known_hosts` file that trusts exactly that host key. The
 * server binds 127.0.0.1 on a free high port, runs as the calling user (no
 * sudo, no PAM, no system sshd touched), and `stop()` kills the one process this
 * helper started and deletes the directory.
 *
 * The client side is not ambient either. `ssh` reads `~/.ssh/known_hosts` from
 * the passwd entry, not from `$HOME`, so the hermetic test home does not move
 * it, and writing a throwaway key into the developer's real file is not
 * acceptable. {@link ThrowawaySshd.spawnPort} instead puts `-F /dev/null` and a
 * private `UserKnownHostsFile` in front of the argv the hub's launcher built,
 * which leaves the launcher's own options (BatchMode, `StrictHostKeyChecking=yes`)
 * exactly as they ship.
 *
 * The pure pieces — the config text, the `known_hosts` line, the argv prefix —
 * are exported and unit-tested; the process-owning part is exercised by
 * `connect-ssh-runtime.integration.test.ts`, which runs it in CI.
 *
 * // Usage: const sshd = await startThrowawaySshd();
 * //        try { await connectSshRuntime(def, cb, {}, { spawnPort: sshd.spawnPort }); }
 * //        finally { await sshd.stop(); }
 */

import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { type LaunchedPeer, type SpawnOptions, spawnPort } from '@mangostudio/protocol/spawn';

import { removeFixtureDir } from './remove-fixture-dir';

/** Loopback only: the fixture is never reachable from another machine. */
const LOOPBACK_HOST = '127.0.0.1';

/** Where a distribution puts `sshd`, after the caller's `PATH` has been searched. */
const SSHD_FALLBACK_PATHS = [
  '/usr/sbin/sshd',
  '/usr/local/sbin/sshd',
  '/opt/homebrew/sbin/sshd',
] as const;

/** Directories that hold `sshd-session` and `sshd-auth` relative to the `sshd` binary. */
const SSHD_HELPER_DIRECTORIES = ['../lib/openssh', '../libexec/openssh', '../libexec'] as const;

const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 50;
const START_ATTEMPTS = 3;
const STOP_GRACE_MS = 3_000;
const STDERR_TAIL_CHARS = 4_000;

/** The fixture cannot run here; the message names what is missing or what failed. */
export class SshFixtureUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshFixtureUnavailableError';
  }
}

export interface SshdConfigInput {
  readonly port: number;
  readonly hostKeyPath: string;
  readonly authorizedKeysPath: string;
  readonly pidFilePath: string;
  /** The only account the server admits: the one that owns the process. */
  readonly user: string;
  /**
   * OpenSSH 9.8 split the daemon into `sshd`, `sshd-session` and `sshd-auth`
   * and compiles in where the two helpers live. A relocated install (an
   * extracted package, Homebrew, Nix) needs them named.
   */
  readonly helperPaths?: { readonly session: string; readonly auth: string };
}

/**
 * The `sshd_config` text for a server that admits one user with one key.
 *
 * `StrictModes no` because the temp directory's ancestors (`/tmp`, a
 * hermetic home) are not the owner-only chain StrictModes demands; `UsePAM no`
 * because an unprivileged daemon cannot open a PAM session. Passwords and
 * keyboard-interactive are off so the key is the only way in.
 *
 * @example
 * buildSshdConfig({ port: 2222, hostKeyPath: '/t/host', authorizedKeysPath: '/t/ak',
 *   pidFilePath: '/t/pid', user: 'runner' });
 */
export function buildSshdConfig(input: SshdConfigInput): string {
  if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65_535) {
    throw new RangeError(
      `sshd fixture port is ${input.port}; expected an integer from 1024 to 65535 (an unprivileged high port)`
    );
  }
  if (input.user.length === 0 || /\s/.test(input.user)) {
    throw new RangeError(
      `sshd fixture user is ${JSON.stringify(input.user)}; expected a non-empty account name without whitespace`
    );
  }
  const lines = [
    `Port ${input.port}`,
    `ListenAddress ${LOOPBACK_HOST}`,
    `HostKey ${input.hostKeyPath}`,
    `PidFile ${input.pidFilePath}`,
    `AuthorizedKeysFile ${input.authorizedKeysPath}`,
    `AllowUsers ${input.user}`,
    'AuthenticationMethods publickey',
    'PubkeyAuthentication yes',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PermitRootLogin no',
    'PermitUserEnvironment no',
    'UsePAM no',
    'StrictModes no',
    'X11Forwarding no',
    'LogLevel ERROR',
  ];
  if (input.helperPaths) {
    lines.push(
      `SshdSessionPath ${input.helperPaths.session}`,
      `SshdAuthPath ${input.helperPaths.auth}`
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The `known_hosts` line that trusts one host key on a non-default port.
 * OpenSSH writes and matches such entries as `[host]:port`.
 *
 * @example
 * buildKnownHostsLine('127.0.0.1', 2222, 'ssh-ed25519 AAAA… comment');
 * // '[127.0.0.1]:2222 ssh-ed25519 AAAA…'
 */
export function buildKnownHostsLine(host: string, port: number, hostPublicKey: string): string {
  const [type, key] = hostPublicKey.trim().split(/\s+/);
  if (!type || !key) {
    throw new RangeError(
      `sshd host public key is ${JSON.stringify(hostPublicKey)}; expected "<type> <base64 key> [comment]"`
    );
  }
  return `[${host}]:${port} ${type} ${key}\n`;
}

/**
 * The options that make `ssh` trust the fixture and nothing ambient. They go
 * right after the executable name; every option the launcher sets itself
 * differs from these, so first-value-wins never hides one of its own.
 *
 * @example
 * sshClientPrefix('/t/known_hosts'); // ['-F', '/dev/null', '-o', 'UserKnownHostsFile=/t/known_hosts', …]
 */
export function sshClientPrefix(knownHostsPath: string): string[] {
  return [
    '-F',
    '/dev/null',
    '-o',
    `UserKnownHostsFile=${knownHostsPath}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
  ];
}

/**
 * The same launch with {@link sshClientPrefix} spliced in behind the `ssh`
 * executable. Anything that is not an `ssh` launch is returned untouched.
 *
 * @example
 * withSshClientPrefix(['ssh', '-o', 'BatchMode=yes', '--', 'h', 'cmd'], '/t/kh');
 */
export function withSshClientPrefix(argv: readonly string[], knownHostsPath: string): string[] {
  const [executable, ...rest] = argv;
  if (executable !== 'ssh') return [...argv];
  return [executable, ...sshClientPrefix(knownHostsPath), ...rest];
}

/**
 * Where the `sshd` binary is: an explicit `MANGOSTUDIO_SSHD_PATH`, then `PATH`,
 * then the places distributions install it (it is usually in `sbin`, which an
 * unprivileged `PATH` omits).
 *
 * @example
 * locateSshd(process.env); // '/usr/sbin/sshd' | undefined
 */
export function locateSshd(environment: NodeJS.ProcessEnv): string | undefined {
  const configured = environment.MANGOSTUDIO_SSHD_PATH?.trim();
  if (configured) return existsSync(configured) ? configured : undefined;
  const onPath = Bun.which('sshd');
  if (onPath) return onPath;
  return SSHD_FALLBACK_PATHS.find((candidate) => existsSync(candidate));
}

/**
 * The `sshd-session` and `sshd-auth` that belong to this `sshd`, when they are
 * installed where a relocated layout puts them. Undefined for an OpenSSH older
 * than 9.8 (no helpers, and the directives would be a config error) and for a
 * stock install, where the compiled-in default is already right.
 *
 * @example
 * locateSshdHelpers('/opt/ssh/usr/sbin/sshd');
 */
export function locateSshdHelpers(
  sshdPath: string
): { readonly session: string; readonly auth: string } | undefined {
  for (const relative of SSHD_HELPER_DIRECTORIES) {
    const directory = resolve(dirname(sshdPath), relative);
    const session = join(directory, 'sshd-session');
    const auth = join(directory, 'sshd-auth');
    if (existsSync(session) && existsSync(auth)) return { session, auth };
  }
  return undefined;
}

/** A running throwaway server and everything a client needs to reach it. */
export interface ThrowawaySshd {
  readonly host: string;
  readonly port: number;
  /** The account the server admits; also `ssh`'s default, so a config may omit it. */
  readonly user: string;
  /** The private key the server's `authorized_keys` holds. */
  readonly identityFile: string;
  readonly knownHostsFile: string;
  /**
   * A drop-in for the launcher's `spawnPort` dependency: it runs the argv the
   * launcher built, with the client prefix in front.
   */
  spawnPort(options: SpawnOptions): LaunchedPeer;
  /** Kills the server this helper started and removes its directory. Idempotent. */
  stop(): Promise<void>;
}

export interface StartThrowawaySshdOptions {
  /** Defaults to {@link locateSshd} over `process.env`. */
  readonly sshdPath?: string;
}

/**
 * Starts the server and proves a key login works before returning, so a broken
 * fixture fails here, naming what broke, rather than as six unrelated
 * connection errors.
 *
 * @throws {SshFixtureUnavailableError} when `sshd`, `ssh` or `ssh-keygen` is
 *   missing, the server never listens, or the login probe is refused.
 */
export async function startThrowawaySshd(
  options: StartThrowawaySshdOptions = {}
): Promise<ThrowawaySshd> {
  const sshdPath = options.sshdPath ?? locateSshd(process.env);
  if (!sshdPath) {
    const configured = process.env.MANGOSTUDIO_SSHD_PATH?.trim();
    throw new SshFixtureUnavailableError(
      `sshd binary: expected one at MANGOSTUDIO_SSHD_PATH, on PATH or in ${SSHD_FALLBACK_PATHS.join(', ')} | received: ${configured ? `MANGOSTUDIO_SSHD_PATH=${configured}, which does not exist` : 'none'}. ` +
        'Install openssh-server (apt install openssh-server); the package does not need to be started as a service.'
    );
  }
  for (const tool of ['ssh', 'ssh-keygen']) {
    if (Bun.which(tool) === null) {
      throw new SshFixtureUnavailableError(
        `${tool} on PATH: expected an OpenSSH client | received: none`
      );
    }
  }

  const directory = await mkdtemp(join(tmpdir(), 'mango-sshd-'));
  await chmod(directory, 0o700);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const stop = async (): Promise<void> => {
    const running = child;
    child = undefined;
    if (running?.exitCode === null) {
      running.kill('SIGTERM');
      const settled = await Promise.race([
        running.exited.then(() => true),
        Bun.sleep(STOP_GRACE_MS).then(() => false),
      ]);
      if (!settled) {
        running.kill('SIGKILL');
        await running.exited;
      }
    }
    await removeFixtureDir({ role: 'ssh-fixture', path: directory });
  };

  try {
    const hostKeyPath = join(directory, 'ssh_host_ed25519_key');
    const identityFile = join(directory, 'client_ed25519_key');
    await generateKey(hostKeyPath);
    await generateKey(identityFile);

    const authorizedKeysPath = join(directory, 'authorized_keys');
    await writeFile(authorizedKeysPath, await readFile(`${identityFile}.pub`, 'utf8'));
    const user = userInfo().username;
    const helperPaths = locateSshdHelpers(sshdPath);

    let started: { port: number; process: ReturnType<typeof Bun.spawn>; stderr: () => string };
    for (let attempt = 1; ; attempt += 1) {
      const port = await pickFreePort();
      const configPath = join(directory, 'sshd_config');
      await writeFile(
        configPath,
        buildSshdConfig({
          port,
          hostKeyPath,
          authorizedKeysPath,
          pidFilePath: join(directory, 'sshd.pid'),
          user,
          ...(helperPaths ? { helperPaths } : {}),
        })
      );
      const attemptProcess = Bun.spawn([sshdPath, '-f', configPath, '-D', '-e'], {
        stdout: 'ignore',
        stderr: 'pipe',
      });
      child = attemptProcess;
      const stderr = collectTail(attemptProcess.stderr as ReadableStream<Uint8Array>);
      const outcome = await waitUntilListening(port, attemptProcess);
      if (outcome === 'listening') {
        started = { port, process: attemptProcess, stderr };
        break;
      }
      // The port was free when picked and may have been taken since; the
      // config is rewritten with a new one rather than waiting on a race.
      await attemptProcess.exited;
      child = undefined;
      if (attempt >= START_ATTEMPTS) {
        throw new SshFixtureUnavailableError(
          `sshd at ${sshdPath}: expected to listen on ${LOOPBACK_HOST} | received: ${outcome} after ${attempt} attempts; stderr: ${stderr() || '(empty)'}`
        );
      }
    }

    const knownHostsFile = join(directory, 'known_hosts');
    await writeFile(
      knownHostsFile,
      buildKnownHostsLine(LOOPBACK_HOST, started.port, await readFile(`${hostKeyPath}.pub`, 'utf8'))
    );

    await assertKeyLogin({
      port: started.port,
      user,
      identityFile,
      knownHostsFile,
      serverStderr: started.stderr,
    });

    return {
      host: LOOPBACK_HOST,
      port: started.port,
      user,
      identityFile,
      knownHostsFile,
      spawnPort: (spawnOptions) =>
        spawnPort({
          ...spawnOptions,
          argv: withSshClientPrefix(spawnOptions.argv, knownHostsFile),
        }),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function generateKey(path: string): Promise<void> {
  const keygen = Bun.spawn(
    ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'mango-sshd-fixture', '-f', path],
    { stdout: 'ignore', stderr: 'pipe' }
  );
  const stderr = await new Response(keygen.stderr).text();
  if ((await keygen.exited) !== 0) {
    throw new SshFixtureUnavailableError(
      `ssh-keygen for ${path}: expected exit 0 | received: ${keygen.exitCode}; stderr: ${stderr.trim()}`
    );
  }
}

/** Asks the OS for a free loopback port. Another process may take it before sshd does. */
function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, LOOPBACK_HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close(() => {
        if (port === undefined) {
          reject(
            new Error(`expected a numeric loopback port | received: ${JSON.stringify(address)}`)
          );
        } else {
          resolvePort(port);
        }
      });
    });
  });
}

/** Keeps the last few KB of a stream; the part of a failed start worth reading. */
function collectTail(stream: ReadableStream<Uint8Array>): () => string {
  let tail = '';
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of stream) {
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
      }
    } catch {
      // The pipe closing with the process is the normal end.
    }
  })();
  return () => tail.trim();
}

/** Polls until the port answers with an SSH banner, or the server exits or the budget runs out. */
async function waitUntilListening(
  port: number,
  server: ReturnType<typeof Bun.spawn>
): Promise<'listening' | 'exited before listening' | 'timed out'> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) return 'exited before listening';
    if (await answersWithBanner(port)) return 'listening';
    await Bun.sleep(READY_POLL_MS);
  }
  return 'timed out';
}

function answersWithBanner(port: number): Promise<boolean> {
  return new Promise((settle) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port });
    const done = (result: boolean): void => {
      socket.destroy();
      settle(result);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once('error', () => done(false));
    socket.once('data', (data) => done(data.toString('latin1').startsWith('SSH-')));
  });
}

/** One real login with the launcher's trust rules, so a bad fixture names itself. */
async function assertKeyLogin(input: {
  readonly port: number;
  readonly user: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
  readonly serverStderr: () => string;
}): Promise<void> {
  const probe = Bun.spawn(
    [
      'ssh',
      ...sshClientPrefix(input.knownHostsFile),
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-i',
      input.identityFile,
      '-p',
      String(input.port),
      '-T',
      '--',
      `${input.user}@${LOOPBACK_HOST}`,
      'true',
    ],
    { stdout: 'ignore', stderr: 'pipe' }
  );
  const clientStderr = await new Response(probe.stderr).text();
  if ((await probe.exited) !== 0) {
    throw new SshFixtureUnavailableError(
      `ssh key login to ${input.user}@${LOOPBACK_HOST}:${input.port}: expected exit 0 | received: ${probe.exitCode}; ` +
        `client: ${clientStderr.trim() || '(empty)'}; sshd: ${input.serverStderr() || '(empty)'}`
    );
  }
}
