import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { SshFixtureUnavailableError, type ThrowawaySshd } from '../../support/ssh-fixture';
import {
  probeLocalhostSsh,
  sshCommandRunnerFor,
  sshFixtureRequested,
  sshTargetFor,
  startSshFixtureIfRequested,
} from '../../support/ssh-fixture-suite';

/** A fixture that was never started: only the fields the helpers read. */
const FIXTURE_FACADE: ThrowawaySshd = {
  host: '127.0.0.1',
  port: 40_222,
  user: 'runner',
  identityFile: '/t/client_key',
  knownHostsFile: '/t/known_hosts',
  spawnPort: () => {
    throw new Error('spawnPort is not part of these tests');
  },
  stop: () => Promise.resolve(),
};

const scratch: string[] = [];
const originalPath = process.env.PATH;
const originalSshdPath = process.env.MANGOSTUDIO_SSHD_PATH;

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mango-ssh-suite-test-'));
  scratch.push(directory);
  return directory;
}

/** Puts a directory in front of `PATH` for the test; `afterEach` restores it. */
function prependToPath(directory: string): void {
  process.env.PATH = `${directory}${delimiter}${originalPath ?? ''}`;
}

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalSshdPath === undefined) delete process.env.MANGOSTUDIO_SSHD_PATH;
  else process.env.MANGOSTUDIO_SSHD_PATH = originalSshdPath;
  await Promise.all(scratch.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

describe('sshFixtureRequested', () => {
  it('is true only for the literal 1', () => {
    expect(sshFixtureRequested({ MANGOSTUDIO_SSH_FIXTURE: '1' })).toBe(true);
    expect(sshFixtureRequested({ MANGOSTUDIO_SSH_FIXTURE: 'true' })).toBe(false);
    expect(sshFixtureRequested({ MANGOSTUDIO_SSH_FIXTURE: '' })).toBe(false);
    expect(sshFixtureRequested({})).toBe(false);
  });
});

describe('startSshFixtureIfRequested', () => {
  it('starts nothing and registers no cleanup when the fixture was not requested', async () => {
    const cleanups: Array<() => Promise<void>> = [];

    const fixture = await startSshFixtureIfRequested({}, (cleanup) => cleanups.push(cleanup));

    expect(fixture).toBeUndefined();
    expect(cleanups).toHaveLength(0);
  });

  it('fails with the sshd cause, not a skip, when it was requested and sshd is missing', async () => {
    const directory = await scratchDirectory();
    const absent = join(directory, 'absent-sshd');
    process.env.MANGOSTUDIO_SSHD_PATH = absent;
    const cleanups: Array<() => Promise<void>> = [];

    const error = await startSshFixtureIfRequested({ MANGOSTUDIO_SSH_FIXTURE: '1' }, (cleanup) =>
      cleanups.push(cleanup)
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(SshFixtureUnavailableError);
    expect(error.message).toContain(
      `received: MANGOSTUDIO_SSHD_PATH=${absent}, which does not exist`
    );
    expect(cleanups).toHaveLength(0);
  });
});

describe('sshTargetFor', () => {
  it('points at the fixture address with its user, port and key', () => {
    expect(sshTargetFor(FIXTURE_FACADE)).toEqual({
      host: '127.0.0.1',
      port: 40_222,
      user: 'runner',
      identityFile: '/t/client_key',
    });
  });

  it("points at the machine's own localhost without a fixture", () => {
    expect(sshTargetFor(undefined)).toEqual({ host: 'localhost' });
  });
});

// The stand-in `ssh` is a shell script, which Windows cannot execute; the
// fixture itself only runs on the Linux test shards.
describe.skipIf(process.platform === 'win32')('with a stand-in ssh on PATH', () => {
  /** An `ssh` that records its argv, one word per line, and exits with `exitCode`. */
  async function installRecordingSsh(
    exitCode: number
  ): Promise<{ argvFile: string; directory: string }> {
    const directory = await scratchDirectory();
    const argvFile = join(directory, 'argv');
    const script = `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nexit ${exitCode}\n`;
    await writeFile(join(directory, 'ssh'), script);
    await chmod(join(directory, 'ssh'), 0o755);
    prependToPath(directory);
    return { argvFile, directory };
  }

  it('puts only the fixture trust options in front of the argv the runner built', async () => {
    const { argvFile } = await installRecordingSsh(0);

    const result = await sshCommandRunnerFor(FIXTURE_FACADE, sshTargetFor(FIXTURE_FACADE))('true');

    expect(result.exitCode).toBe(0);
    const argv = (await readFile(argvFile, 'utf8')).split('\n');
    expect(argv.slice(0, 6)).toEqual([
      '-F',
      '/dev/null',
      '-o',
      'UserKnownHostsFile=/t/known_hosts',
      '-o',
      'GlobalKnownHostsFile=/dev/null',
    ]);
    // The launcher's own rules still ship as they are.
    expect(argv).toContain('StrictHostKeyChecking=yes');
    expect(argv).toContain('runner@127.0.0.1');
  });

  it('adds nothing in front of the runner argv without a fixture', async () => {
    const { argvFile } = await installRecordingSsh(0);

    await sshCommandRunnerFor(undefined, { host: 'localhost' })('true');

    const argv = (await readFile(argvFile, 'utf8')).split('\n');
    expect(argv).not.toContain('-F');
    expect(argv.slice(0, 2)).toEqual(['-o', 'BatchMode=yes']);
  });

  it('probes localhost as reachable when ssh exits 0', async () => {
    const { directory } = await installRecordingSsh(0);

    expect(await probeLocalhostSsh(directory)).toBe(true);
  });

  it('probes localhost as unreachable when ssh exits non-zero', async () => {
    const { directory } = await installRecordingSsh(255);

    expect(await probeLocalhostSsh(directory)).toBe(false);
  });

  it('probes localhost as unreachable when there is no ssh client on the search path', async () => {
    expect(await probeLocalhostSsh(await scratchDirectory())).toBe(false);
  });
});
