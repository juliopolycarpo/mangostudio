import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import {
  bootstrapServeToken,
  readPairingToken,
  readRuntimeSlotConfig,
  readRuntimeSlotState,
  readServeToken,
  resolveRuntimeSlot,
  resolveRuntimeSource,
  runtimeSlotDir,
  writePairingToken,
  writeRuntimeSlotConfig,
  writeServeToken,
} from '../../src/runtime-home';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function isolatedEnv(): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), 'mango-runtime-home-'));
  homes.push(home);
  return { MANGO_HOME: home };
}

/** A pid that certainly belongs to nothing: a process this test watched exit. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['sh', '-c', 'exit 0'], { stdout: 'ignore', stderr: 'ignore' });
  await child.exited;
  return child.pid;
}

async function writeRawConfig(
  slot: 'host' | 'wsl' | 'remote',
  contents: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const directory = runtimeSlotDir(slot, env);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'runtime.json'), contents);
}

describe('runtime home', () => {
  it('anchors each slot under the runtime home', async () => {
    const env = await isolatedEnv();

    expect(runtimeSlotDir('remote', env)).toBe(join(env.MANGO_HOME as string, 'runtime', 'remote'));
    expect(runtimeSlotDir('host', env)).toBe(join(env.MANGO_HOME as string, 'runtime', 'host'));
  });

  it('reports the slot default rather than failing on a missing file', async () => {
    const env = await isolatedEnv();
    const remote = await readRuntimeSlotState('remote', env);

    expect(remote.stored).toBeNull();
    expect(remote.error).toBeNull();
    expect(remote.config.profile).toBe('none');
    expect(remote.config.setup.state).toBe('pending');
    expect(await readPairingToken('remote', env)).toBeNull();

    const host = await readRuntimeSlotState('host', env);
    expect(host.config.profile).toBe('full');
    expect(host.config.setup.state).toBe('configured');
  });

  it('remembers the hub URL across runs', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('remote', { hubUrl: 'wss://hub.test/api/runtime' }, env);

    expect((await readRuntimeSlotConfig('remote', env)).hubUrl).toBe('wss://hub.test/api/runtime');
  });

  it('merges an update rather than replacing the file', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('remote', { hubUrl: 'wss://hub.test/api/runtime' }, env);
    await writeRuntimeSlotConfig(
      'remote',
      { allow: RUNTIME_CONSENT_PRESETS.readonly, setup: { state: 'configured', by: 'cli' } },
      env
    );

    const config = await readRuntimeSlotConfig('remote', env);
    expect(config.hubUrl).toBe('wss://hub.test/api/runtime');
    expect(config.profile).toBe('readonly');
    expect(config.setup.state).toBe('configured');
  });

  it('reports a config it cannot parse instead of reading it as absent', async () => {
    const env = await isolatedEnv();
    await writeRawConfig('host', '{ not json', env);

    const state = await readRuntimeSlotState('host', env);
    expect(state.error).toContain('not valid JSON');
    expect(state.stored).toBeNull();
  });

  it('reports a config it cannot open instead of reading it as absent', async () => {
    const env = await isolatedEnv();
    // A directory where the file belongs fails the read with EISDIR, which is
    // the portable stand-in for the EACCES/EPERM/EIO family: a file is there
    // and this process cannot see what it says. `host` is the slot that makes
    // the distinction matter, because absence there means full consent.
    await mkdir(join(runtimeSlotDir('host', env), 'runtime.json'), { recursive: true });

    const state = await readRuntimeSlotState('host', env);
    expect(state.error).toContain('could not be read');
    expect(state.stored).toBeNull();
  });

  it('reports a config that does not match the schema', async () => {
    const env = await isolatedEnv();
    await writeRawConfig('host', JSON.stringify({ schemaVersion: 1, slot: 'nowhere' }), env);

    const state = await readRuntimeSlotState('host', env);
    expect(state.error).toContain('does not match the runtime config schema');
  });

  it('ignores fields a newer runtime wrote', async () => {
    const env = await isolatedEnv();
    await writeRawConfig(
      'wsl',
      JSON.stringify({
        schemaVersion: 1,
        slot: 'wsl',
        allow: { ...RUNTIME_CONSENT_PRESETS.full, telepathy: true },
        setup: { state: 'configured' },
        somethingNew: 'from a later release',
      }),
      env
    );

    const state = await readRuntimeSlotState('wsl', env);
    expect(state.error).toBeNull();
    expect(state.config.profile).toBe('full');
  });

  it('takes the slot from the directory, not from what the file claims', async () => {
    const env = await isolatedEnv();
    await writeRawConfig(
      'remote',
      JSON.stringify({ schemaVersion: 1, slot: 'host', setup: { state: 'configured' } }),
      env
    );

    expect((await readRuntimeSlotConfig('remote', env)).slot).toBe('remote');
  });

  it('stores the credential owner-only and keeps it out of the pasteable file', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('remote', { hubUrl: 'wss://hub.test/api/runtime' }, env);
    const { restricted } = await writePairingToken('remote', 'mrt_selector.secret', env);

    expect(await readPairingToken('remote', env)).toBe('mrt_selector.secret');
    // `runtime.json` has to stay safe to paste into a bug report, which is the
    // whole reason the credential lives in a second file.
    const config = await Bun.file(join(runtimeSlotDir('remote', env), 'runtime.json')).text();
    expect(config).not.toContain('secret');

    if (restricted) {
      const mode = (await stat(join(runtimeSlotDir('remote', env), 'credentials.json'))).mode;
      expect(mode & 0o077).toBe(0);
    }
  });

  it('does not claim owner-only access on Windows, where chmod cannot grant it', async () => {
    const env = await isolatedEnv();
    // `chmod(0o600)` resolves on Windows after setting the read-only attribute,
    // so a `restricted: true` there would mean "the call did not throw" rather
    // than "no other account can read this" — and the flag exists to answer the
    // second question, which is the one that suppresses the warning.
    const { restricted } = await writePairingToken(
      'remote',
      'mrt_selector.secret',
      env,
      'win32' as NodeJS.Platform
    );

    expect(restricted).toBe(false);
    expect(await readPairingToken('remote', env)).toBe('mrt_selector.secret');
  });

  it('replaces a rotated credential rather than appending to it', async () => {
    const env = await isolatedEnv();
    await writePairingToken('remote', 'mrt_first.secret', env);
    await writePairingToken('remote', 'mrt_second.secret', env);

    expect(await readPairingToken('remote', env)).toBe('mrt_second.secret');
  });

  it('keeps pairing and serve tokens in the same credentials file', async () => {
    const env = await isolatedEnv();
    await writePairingToken('remote', 'pairing.secret', env);
    await writeServeToken('remote', 'serve.secret', env);
    await writePairingToken('remote', 'pairing.rotated', env);

    expect(await readPairingToken('remote', env)).toBe('pairing.rotated');
    expect(await readServeToken('remote', env)).toBe('serve.secret');

    const { token } = await bootstrapServeToken('remote', env);
    expect(await readServeToken('remote', env)).toBe(token);
    expect(await readPairingToken('remote', env)).toBe('pairing.rotated');
  });

  it('serializes concurrent pairing and serve credential writes', async () => {
    const env = await isolatedEnv();
    await Promise.all([
      writePairingToken('remote', 'pairing.concurrent', env),
      writeServeToken('remote', 'serve.concurrent', env),
    ]);

    expect(await readPairingToken('remote', env)).toBe('pairing.concurrent');
    expect(await readServeToken('remote', env)).toBe('serve.concurrent');
  });

  it('keeps both writers changes when two provision one slot at once', async () => {
    const env = await isolatedEnv();
    await Promise.all([
      writeRuntimeSlotConfig('remote', { version: '0.1.1' }, env),
      writeRuntimeSlotConfig('remote', { hubUrl: 'wss://hub.test/api/runtime' }, env),
    ]);

    // Read-merge-rename without a lock drops whichever field the loser set;
    // the field at stake in real use is `allow`.
    const config = await readRuntimeSlotConfig('remote', env);
    expect(config.version).toBe('0.1.1');
    expect(config.hubUrl).toBe('wss://hub.test/api/runtime');
  });

  it('does not let an installer write undo consent recorded at the same moment', async () => {
    const env = await isolatedEnv();
    await Promise.all([
      writeRuntimeSlotConfig(
        'wsl',
        { allow: RUNTIME_CONSENT_PRESETS.readonly, setup: { state: 'configured', by: 'cli' } },
        env
      ),
      writeRuntimeSlotConfig('wsl', { version: '0.1.2', digest: `sha256:${'c'.repeat(64)}` }, env),
    ]);

    const config = await readRuntimeSlotConfig('wsl', env);
    expect(config.profile).toBe('readonly');
    expect(config.version).toBe('0.1.2');
  });

  it('reclaims a lock whose owner was killed before it could clean up', async () => {
    const env = await isolatedEnv();
    const directory = runtimeSlotDir('host', env);
    await mkdir(directory, { recursive: true });
    // What a SIGKILL mid-write leaves: a lock naming a process on this machine
    // that no longer exists. Without reclaiming it, every later write to this
    // slot times out and nobody can answer the consent question again.
    await writeFile(
      join(directory, 'runtime.lock'),
      JSON.stringify({ pid: await deadPid(), host: hostname() })
    );

    await writeRuntimeSlotConfig('host', { version: '0.1.3' }, env);
    expect((await readRuntimeSlotConfig('host', env)).version).toBe('0.1.3');
  });

  it('waits for a lock whose owner is still running instead of stealing it', async () => {
    const env = await isolatedEnv();
    const directory = runtimeSlotDir('host', env);
    await mkdir(directory, { recursive: true });
    const lock = join(directory, 'runtime.lock');
    // A live owner on this machine, which is what reclaiming must never touch:
    // stealing a held lock trades a slot nobody can write for one two writers
    // corrupt.
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname() }));

    const write = writeRuntimeSlotConfig('host', { version: '0.1.4' }, env);
    await Bun.sleep(100);
    expect(await Bun.file(join(directory, 'runtime.json')).exists()).toBe(false);

    await rm(lock);
    await write;
    expect((await readRuntimeSlotConfig('host', env)).version).toBe('0.1.4');
  });
});

describe('slot and source resolution', () => {
  it('answers to the slot its executable lives under', async () => {
    const env = await isolatedEnv();
    const remote = join(runtimeSlotDir('remote', env), '0.1.1', 'mangostudio-runtime');

    expect(resolveRuntimeSlot(env, [remote])).toBe('remote');
    expect(resolveRuntimeSlot(env, [join(runtimeSlotDir('wsl', env), 'current', 'x')])).toBe('wsl');
    expect(resolveRuntimeSlot(env, ['/usr/local/bin/mangostudio-runtime'])).toBe('host');
  });

  it('calls a checkout a checkout and a slot binary provisioned', async () => {
    const env = await isolatedEnv();

    expect(resolveRuntimeSource(env, '/usr/local/bin/bun')).toBe('source-checkout');
    expect(
      resolveRuntimeSource(env, join(runtimeSlotDir('remote', env), '0.1.1', 'mangostudio-runtime'))
    ).toBe('provisioned');
    expect(resolveRuntimeSource(env, '/opt/mangostudio/mangostudio-runtime')).toBe('bundled');
  });
});

describe('stdio pending setup gate', () => {
  it('refuses a remote slot nobody has answered for', async () => {
    const { stdioConsentRefusal } = await import('../../src/cli');
    const env = await isolatedEnv();

    const remoteBinary = join(runtimeSlotDir('remote', env), 'current', 'mangostudio-runtime');
    expect(await stdioConsentRefusal(env, [remoteBinary])).not.toBeNull();
  });

  it('serves a remote slot once setup has answered', async () => {
    const { stdioConsentRefusal } = await import('../../src/cli');
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig(
      'remote',
      { allow: RUNTIME_CONSENT_PRESETS.full, setup: { state: 'configured', by: 'cli' } },
      env
    );

    const remoteBinary = join(runtimeSlotDir('remote', env), 'current', 'mangostudio-runtime');
    expect(await stdioConsentRefusal(env, [remoteBinary])).toBeNull();
  });

  it('does not gate a binary this machine installed for itself', async () => {
    const { stdioConsentRefusal } = await import('../../src/cli');
    const env = await isolatedEnv();

    expect(await stdioConsentRefusal(env, ['/usr/local/bin/mangostudio-runtime'])).toBeNull();
    expect(
      await stdioConsentRefusal(env, [
        join(runtimeSlotDir('wsl', env), 'current', 'mangostudio-runtime'),
      ])
    ).toBeNull();
  });

  it('refuses a host slot whose owner said no', async () => {
    const { stdioConsentRefusal } = await import('../../src/cli');
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('host', { setup: { state: 'pending' } }, env);

    expect(await stdioConsentRefusal(env, ['/usr/local/bin/mangostudio-runtime'])).not.toBeNull();
  });

  it('refuses a slot whose consent file cannot be read', async () => {
    // An unreadable answer is an unknown answer, and the file it replaced may
    // well have said no.
    const { stdioConsentRefusal } = await import('../../src/cli');
    const env = await isolatedEnv();
    await writeRawConfig('host', '{ truncated', env);

    expect(await stdioConsentRefusal(env, ['/usr/local/bin/mangostudio-runtime'])).not.toBeNull();
  });
});
