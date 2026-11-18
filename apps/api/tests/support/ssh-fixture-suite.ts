/**
 * What every real-sshd integration suite shares around {@link startThrowawaySshd}:
 * the `MANGOSTUDIO_SSH_FIXTURE` switch, the target a config points at, the
 * localhost probe the suites fall back to, and a command runner that trusts the
 * fixture's host key.
 *
 * Two contracts, decided once here:
 *
 * - `MANGOSTUDIO_SSH_FIXTURE=1`: the suite owns a throwaway sshd. A missing
 *   sshd or a broken login throws at load, so the file fails with the cause
 *   rather than skipping.
 * - Unset: the suite probes the machine's own `localhost` and skips when it is
 *   not reachable, as before the fixture existed.
 *
 * // Usage (top of a suite file):
 * //   const fixture = await startSshFixtureIfRequested(process.env, afterAll);
 * //   const canReachSshd = fixture !== undefined || (await probeLocalhostSsh());
 * //   const config = { ...sshTargetFor(fixture), remoteRuntimePath: '/x' };
 * //   const run = sshCommandRunnerFor(fixture, config);
 */

import { spawn } from 'node:child_process';

import type { SshEnvironmentConfig } from '@mangostudio/shared/environments';
import { HIDDEN_WINDOW } from '@mangostudio/shared/process';

import {
  createSshCommandRunner,
  type SshChild,
} from '../../src/modules/environments/infrastructure/ssh-command-runner';
import { sshClientPrefix, startThrowawaySshd, type ThrowawaySshd } from './ssh-fixture';

/** True when the caller asked for the throwaway sshd (`MANGOSTUDIO_SSH_FIXTURE=1`). */
export function sshFixtureRequested(environment: NodeJS.ProcessEnv): boolean {
  return environment.MANGOSTUDIO_SSH_FIXTURE === '1';
}

/**
 * Starts the fixture when it was requested, and hands its `stop` to
 * `registerCleanup` straight after the start so no later failure can leave the
 * server running. Returns undefined when it was not requested.
 *
 * Suites call this at load rather than in `beforeAll` because `it.skipIf` is
 * decided while the file is collected.
 *
 * @param registerCleanup - Pass `afterAll`.
 * @throws {SshFixtureUnavailableError} when it was requested and cannot start.
 */
export async function startSshFixtureIfRequested(
  environment: NodeJS.ProcessEnv,
  registerCleanup: (cleanup: () => Promise<void>) => void
): Promise<ThrowawaySshd | undefined> {
  if (!sshFixtureRequested(environment)) return undefined;
  const fixture = await startThrowawaySshd();
  registerCleanup(() => fixture.stop());
  return fixture;
}

/**
 * Where a config should point: the fixture's address and key, or the
 * machine's own `localhost` when there is no fixture.
 */
export function sshTargetFor(fixture: ThrowawaySshd | undefined): SshEnvironmentConfig {
  return fixture
    ? {
        host: fixture.host,
        port: fixture.port,
        user: fixture.user,
        identityFile: fixture.identityFile,
      }
    : { host: 'localhost' };
}

/**
 * The hub's real `createSshCommandRunner`; with a fixture, only its trust
 * options (`-F /dev/null`, a private `known_hosts`) are put in front of the
 * argv the runner built, so `~/.ssh` is never read or written.
 */
export function sshCommandRunnerFor(
  fixture: ThrowawaySshd | undefined,
  config: SshEnvironmentConfig
) {
  return createSshCommandRunner(
    config,
    fixture ? { spawnSsh: (args) => spawnFixtureSsh(fixture, args) } : {}
  );
}

function spawnFixtureSsh(fixture: ThrowawaySshd, args: readonly string[]): SshChild {
  return spawn('ssh', [...sshClientPrefix(fixture.knownHostsFile), ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...HIDDEN_WINDOW,
  });
}

/**
 * Whether the machine's own `ssh localhost` works as the hub would run it:
 * batch mode, and a host key that must already be trusted. Anything laxer would
 * let a suite run under conditions the launcher itself refuses.
 */
export async function probeLocalhostSsh(searchPath = process.env.PATH): Promise<boolean> {
  // `Bun.which` and `Bun.spawn` both resolve against the `PATH` the process
  // started with, so the search path is named and the absolute result spawned.
  const ssh = Bun.which('ssh', { PATH: searchPath ?? '' });
  if (ssh === null) return false;
  const child = Bun.spawn(
    [
      ssh,
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=yes',
      '-T',
      '--',
      'localhost',
      'true',
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  );
  return (await child.exited) === 0;
}
