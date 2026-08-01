import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectSshRuntime } from '../../../../src/services/runtime-client/connect-ssh-runtime';

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

    expect(error.code).toBe('RUNTIME_UNAVAILABLE');
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

      expect(error.code).toBe('RUNTIME_UNAVAILABLE');
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

    expect(error.code).toBe('RUNTIME_UNAVAILABLE');
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

      expect(error.code).toBe('RUNTIME_UNAVAILABLE');
      expect(error.details?.sshFailureReason).not.toBe('auth-refused');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);
});
