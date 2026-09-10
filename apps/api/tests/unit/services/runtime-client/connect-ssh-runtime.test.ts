import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SSH_FORCED_OPTIONS } from '@mangostudio/shared/environments';
import {
  connectSshRuntime,
  sshLaunch,
} from '../../../../src/services/runtime-client/connect-ssh-runtime';

describe('connectSshRuntime', () => {
  it('names a missing identity file instead of letting ssh report a refused key', async () => {
    // ssh only warns about a key file it cannot read, then fails authentication
    // — which sends the user to the server's authorized_keys over a path typo.
    const error = await connectSshRuntime(
      {
        id: 'build-01',
        config: { host: 'build-01.internal', identityFile: '/no/such/key' },
      },
      () => undefined
    ).catch((caught) => caught);

    expect(error.code).toBe('UNAVAILABLE');
    expect(error.message).toContain('/no/such/key');
    expect(error.details?.sshFailureReason).toBe('auth-refused');
  });

  it('expands a home-relative identity path before the existence check', async () => {
    // OpenSSH accepts `~/.ssh/…` for `-i`; a literal existsSync would reject a
    // key the client would open. Place the file under $HOME so `~/…` resolves.
    const directory = await mkdtemp(join(homedir(), '.mango-ssh-tilde-'));
    const identityFile = `~/${directory.slice(homedir().length + 1)}/id_ed25519`;
    await writeFile(join(directory, 'id_ed25519'), 'not a real key\n');

    try {
      const error = await connectSshRuntime(
        {
          id: 'build-01',
          config: { host: 'ssh-target.invalid', identityFile },
        },
        () => undefined
      ).catch((caught) => caught);

      expect(error.code).toBe('UNAVAILABLE');
      expect(error.message).not.toMatch(/does not exist/);
      expect(error.details?.sshFailureReason).not.toBe('auth-refused');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it('still names a missing home-relative identity file', async () => {
    const error = await connectSshRuntime(
      {
        id: 'build-01',
        config: {
          host: 'build-01.internal',
          identityFile: '~/.ssh/mango-review-missing-identity',
        },
      },
      () => undefined
    ).catch((caught) => caught);

    expect(error.code).toBe('UNAVAILABLE');
    expect(error.message).toContain('~/.ssh/mango-review-missing-identity');
    expect(error.details?.sshFailureReason).toBe('auth-refused');
  });

  it('refuses a config its schema would not accept', async () => {
    const error = await connectSshRuntime(
      { id: 'build-01', config: { host: '-oProxyCommand=id' } },
      () => undefined
    ).catch((caught) => caught);

    expect(error.message).toContain('Invalid ssh environment configuration');
  });

  it('starts the launch once the identity file is real', async () => {
    // Everything up to the spawn is covered here; the spawn itself needs a
    // reachable sshd and lives in the integration suite. The host is chosen to
    // fail fast on name resolution, so this asserts the classified outcome
    // rather than a timeout.
    const directory = await mkdtemp(join(tmpdir(), 'mango-ssh-identity-'));
    const identityFile = join(directory, 'id_ed25519');
    await writeFile(identityFile, 'not a real key\n');

    try {
      const error = await connectSshRuntime(
        {
          id: 'build-01',
          config: { host: 'ssh-target.invalid', identityFile },
        },
        () => undefined
      ).catch((caught) => caught);

      expect(error.code).toBe('UNAVAILABLE');
      expect(error.details?.sshFailureReason).not.toBe('auth-refused');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);
});

describe('sshLaunch', () => {
  it('forces every option the hub depends on, whatever ssh_config says', () => {
    // Pinned against the constant the ssh command runner reuses, because the
    // two now come from different places and drifting apart is the whole risk.
    const { command, args } = sshLaunch({ host: 'build-01.internal' });

    expect(command).toBe('ssh');
    expect(args.slice(0, SSH_FORCED_OPTIONS.length)).toEqual([...SSH_FORCED_OPTIONS]);
    expect(args.slice(SSH_FORCED_OPTIONS.length)).toEqual([
      '-T',
      '--',
      'build-01.internal',
      "~/'.mango/runtime/remote/current/mangostudio-runtime'",
    ]);
  });

  it('ends option parsing before the destination and the remote command', () => {
    const { args } = sshLaunch({ host: 'build-01.internal', user: 'deploy', port: 2222 });

    expect(args.at(-3)).toBe('--');
    expect(args.at(-2)).toBe('deploy@build-01.internal');
    expect(args[args.indexOf('-p') + 1]).toBe('2222');
  });

  it('passes an identity file as argv and pins ssh to it', () => {
    // `IdentitiesOnly` keeps the agent from offering every key it holds before
    // the configured one, which is what exhausts a server's MaxAuthTries.
    const { args } = sshLaunch({
      host: 'build-01.internal',
      identityFile: '/home/j/.ssh/build_ed25519',
    });

    expect(args[args.indexOf('-i') + 1]).toBe('/home/j/.ssh/build_ed25519');
    expect(args[args.indexOf('IdentitiesOnly=yes') - 1]).toBe('-o');
  });

  it('quotes a configured remote path for the target login shell', () => {
    // ssh joins everything after the destination with spaces and hands it to a
    // shell there, so a path holding a `;` would otherwise arrive as a command.
    const { args } = sshLaunch({
      host: 'build-01.internal',
      remoteRuntimePath: '/opt/mango studio/runtime; id',
    });

    expect(args.at(-1)).toBe("'/opt/mango studio/runtime; id'");
  });
});
