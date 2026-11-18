import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildKnownHostsLine,
  buildSshdConfig,
  locateSshd,
  locateSshdHelpers,
  sshClientPrefix,
  SshFixtureUnavailableError,
  startThrowawaySshd,
  withSshClientPrefix,
} from '../../support/ssh-fixture';

const BASE_CONFIG = {
  port: 40_222,
  hostKeyPath: '/t/host_key',
  authorizedKeysPath: '/t/authorized_keys',
  pidFilePath: '/t/sshd.pid',
  user: 'runner',
} as const;

const scratch: string[] = [];

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mango-ssh-fixture-test-'));
  scratch.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

describe('buildSshdConfig', () => {
  it('binds loopback only and admits one user by key', () => {
    const lines = buildSshdConfig(BASE_CONFIG).trimEnd().split('\n');

    expect(lines).toEqual(
      expect.arrayContaining([
        'Port 40222',
        'ListenAddress 127.0.0.1',
        'HostKey /t/host_key',
        'PidFile /t/sshd.pid',
        'AuthorizedKeysFile /t/authorized_keys',
        'AllowUsers runner',
        'AuthenticationMethods publickey',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'UsePAM no',
        'StrictModes no',
      ])
    );
    // Exactly one listen directive: a second would widen the bind.
    expect(lines.filter((line) => line.startsWith('ListenAddress '))).toEqual([
      'ListenAddress 127.0.0.1',
    ]);
  });

  it('names the session and auth helpers only when given them', () => {
    expect(buildSshdConfig(BASE_CONFIG)).not.toContain('SshdSessionPath');

    const config = buildSshdConfig({
      ...BASE_CONFIG,
      helperPaths: { session: '/o/sshd-session', auth: '/o/sshd-auth' },
    });

    expect(config).toContain('SshdSessionPath /o/sshd-session\n');
    expect(config).toContain('SshdAuthPath /o/sshd-auth\n');
  });

  it.each([0, 22, 1023, 65_536, 2222.5])('refuses port %p as not an unprivileged port', (port) => {
    expect(() => buildSshdConfig({ ...BASE_CONFIG, port })).toThrow(
      `sshd fixture port is ${port}; expected an integer from 1024 to 65535`
    );
  });

  it.each(['', 'two words'])('refuses the user %p', (user) => {
    expect(() => buildSshdConfig({ ...BASE_CONFIG, user })).toThrow(
      `sshd fixture user is ${JSON.stringify(user)}; expected a non-empty account name without whitespace`
    );
  });
});

describe('buildKnownHostsLine', () => {
  it('writes the bracketed host:port form OpenSSH matches on a non-default port', () => {
    expect(
      buildKnownHostsLine('127.0.0.1', 40_222, 'ssh-ed25519 AAAAC3Nza mango-sshd-fixture\n')
    ).toBe('[127.0.0.1]:40222 ssh-ed25519 AAAAC3Nza\n');
  });

  it('rejects a public key that is not "<type> <key>"', () => {
    expect(() => buildKnownHostsLine('127.0.0.1', 40_222, 'ssh-ed25519')).toThrow(
      'sshd host public key is "ssh-ed25519"; expected "<type> <base64 key> [comment]"'
    );
  });
});

describe('withSshClientPrefix', () => {
  it('puts the isolating options directly behind ssh and leaves the launcher argv intact', () => {
    const launcher = [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '--',
      'h',
      'cmd',
    ];

    const argv = withSshClientPrefix(launcher, '/t/known_hosts');

    expect(argv).toEqual(['ssh', ...sshClientPrefix('/t/known_hosts'), ...launcher.slice(1)]);
    expect(argv).toContain('UserKnownHostsFile=/t/known_hosts');
    expect(argv.slice(0, 3)).toEqual(['ssh', '-F', '/dev/null']);
  });

  it('does not touch a launch that is not ssh', () => {
    expect(withSshClientPrefix(['wsl.exe', '-d', 'Ubuntu'], '/t/known_hosts')).toEqual([
      'wsl.exe',
      '-d',
      'Ubuntu',
    ]);
  });
});

describe('locateSshd', () => {
  it('honours MANGOSTUDIO_SSHD_PATH when the file exists', async () => {
    const directory = await scratchDirectory();
    const sshd = join(directory, 'sshd');
    await writeFile(sshd, '');

    expect(locateSshd({ MANGOSTUDIO_SSHD_PATH: sshd })).toBe(sshd);
  });

  it('does not fall back to another sshd when the named one is missing', async () => {
    const directory = await scratchDirectory();

    expect(locateSshd({ MANGOSTUDIO_SSHD_PATH: join(directory, 'absent') })).toBeUndefined();
  });
});

describe('locateSshdHelpers', () => {
  it('finds sshd-session and sshd-auth in a sibling lib/openssh', async () => {
    const root = await scratchDirectory();
    await mkdir(join(root, 'usr', 'sbin'), { recursive: true });
    await mkdir(join(root, 'usr', 'lib', 'openssh'), { recursive: true });
    await writeFile(join(root, 'usr', 'lib', 'openssh', 'sshd-session'), '');
    await writeFile(join(root, 'usr', 'lib', 'openssh', 'sshd-auth'), '');

    expect(locateSshdHelpers(join(root, 'usr', 'sbin', 'sshd'))).toEqual({
      session: join(root, 'usr', 'lib', 'openssh', 'sshd-session'),
      auth: join(root, 'usr', 'lib', 'openssh', 'sshd-auth'),
    });
  });

  it('returns undefined for an sshd that predates the helper split', async () => {
    const root = await scratchDirectory();
    await mkdir(join(root, 'sbin'), { recursive: true });

    expect(locateSshdHelpers(join(root, 'sbin', 'sshd'))).toBeUndefined();
  });
});

describe('startThrowawaySshd', () => {
  it('fails with the server output when sshd never listens, and leaves no directory behind', async () => {
    const directory = await scratchDirectory();
    const brokenSshd = join(directory, 'sshd');
    await writeFile(brokenSshd, '#!/bin/sh\necho "fake sshd refused the config" >&2\nexit 1\n');
    await chmod(brokenSshd, 0o755);

    const error = await startThrowawaySshd({ sshdPath: brokenSshd }).catch((caught) => caught);

    expect(error).toBeInstanceOf(SshFixtureUnavailableError);
    expect(error.message).toContain(
      'expected to listen on 127.0.0.1 | received: exited before listening'
    );
    expect(error.message).toContain('fake sshd refused the config');
  });

  it('names the configured path when MANGOSTUDIO_SSHD_PATH points at nothing', async () => {
    const directory = await scratchDirectory();
    const absent = join(directory, 'absent-sshd');
    const previous = process.env.MANGOSTUDIO_SSHD_PATH;
    process.env.MANGOSTUDIO_SSHD_PATH = absent;
    try {
      const error = await startThrowawaySshd().catch((caught) => caught);

      expect(error).toBeInstanceOf(SshFixtureUnavailableError);
      expect(error.message).toContain(
        `received: MANGOSTUDIO_SSHD_PATH=${absent}, which does not exist`
      );
    } finally {
      if (previous === undefined) delete process.env.MANGOSTUDIO_SSHD_PATH;
      else process.env.MANGOSTUDIO_SSHD_PATH = previous;
    }
  });
});
