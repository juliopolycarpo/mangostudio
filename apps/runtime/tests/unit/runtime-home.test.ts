import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPairingToken,
  readRuntimeSlotConfig,
  runtimeSlotDir,
  writePairingToken,
  writeRuntimeSlotConfig,
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

describe('runtime home', () => {
  it('anchors each slot under the runtime home', async () => {
    const env = await isolatedEnv();

    expect(runtimeSlotDir('remote', env)).toBe(join(env.MANGO_HOME as string, 'runtime', 'remote'));
    expect(runtimeSlotDir('host', env)).toBe(join(env.MANGO_HOME as string, 'runtime', 'host'));
  });

  it('reports an empty slot rather than failing on a missing file', async () => {
    const env = await isolatedEnv();

    expect(await readRuntimeSlotConfig('remote', env)).toEqual({
      schemaVersion: 1,
      slot: 'remote',
    });
    expect(await readPairingToken('remote', env)).toBeNull();
  });

  it('remembers the hub URL across runs', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('remote', { hubUrl: 'wss://hub.test/api/runtime' }, env);

    expect(await readRuntimeSlotConfig('remote', env)).toEqual({
      schemaVersion: 1,
      slot: 'remote',
      hubUrl: 'wss://hub.test/api/runtime',
    });
  });

  it('keeps the stored hub URL when an update does not carry one', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('remote', { hubUrl: 'wss://hub.test/api/runtime' }, env);
    await writeRuntimeSlotConfig('remote', {}, env);

    expect((await readRuntimeSlotConfig('remote', env)).hubUrl).toBe('wss://hub.test/api/runtime');
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

  it('replaces a rotated credential rather than appending to it', async () => {
    const env = await isolatedEnv();
    await writePairingToken('remote', 'mrt_first.secret', env);
    await writePairingToken('remote', 'mrt_second.secret', env);

    expect(await readPairingToken('remote', env)).toBe('mrt_second.secret');
  });
});
