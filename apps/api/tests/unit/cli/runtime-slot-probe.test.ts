import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { checkRuntimeSlot } from '../../../src/cli/doctor-checks';
import { probeRuntimeSlots } from '../../../src/cli/runtime-slot-probe';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function mangoHome(slots: Readonly<Record<string, string | null>> = {}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'mango-slot-probe-'));
  homes.push(home);
  for (const [slot, contents] of Object.entries(slots)) {
    const directory = join(home, 'runtime', slot);
    await mkdir(directory, { recursive: true });
    if (contents !== null) await writeFile(join(directory, 'runtime.json'), contents);
  }
  return home;
}

describe('probeRuntimeSlots', () => {
  it('reports nothing when there is no runtime home', async () => {
    expect(await probeRuntimeSlots(await mangoHome())).toEqual([]);
  });

  it('reads what each slot on this machine has agreed to', async () => {
    const home = await mangoHome({
      host: JSON.stringify({
        schemaVersion: 1,
        slot: 'host',
        version: '1.2.3',
        allow: RUNTIME_CONSENT_PRESETS.readonly,
        setup: { state: 'configured', by: 'cli' },
      }),
    });

    const [probe] = await probeRuntimeSlots(home);
    expect(probe?.slot).toBe('host');
    expect(probe?.config.profile).toBe('readonly');
    expect(probe?.config.version).toBe('1.2.3');
    expect(probe?.error).toBeNull();
  });

  it('takes a directory with no config as the slot default', async () => {
    const home = await mangoHome({ host: null, remote: null });
    const probes = await probeRuntimeSlots(home);

    expect(probes.map((probe) => probe.slot)).toEqual(['host', 'remote']);
    expect(probes[0]?.config.setup.state).toBe('configured');
    // A slot somebody else's hub installed refuses until asked.
    expect(probes[1]?.config.setup.state).toBe('pending');
  });

  it('reports a config it cannot read rather than reading it as absent', async () => {
    const home = await mangoHome({ host: '{ truncated' });
    const [probe] = await probeRuntimeSlots(home);

    expect(probe?.error).toBe('is not valid JSON');
  });
});

describe('checkRuntimeSlot', () => {
  it('names the denied capabilities of a narrowed slot', async () => {
    const home = await mangoHome({
      host: JSON.stringify({
        schemaVersion: 1,
        slot: 'host',
        allow: RUNTIME_CONSENT_PRESETS.readonly,
        setup: { state: 'configured' },
      }),
    });
    const [probe] = await probeRuntimeSlots(home);

    const result = checkRuntimeSlot(probe as NonNullable<typeof probe>);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('readonly');
    expect(result.detail).toContain('shell');
  });

  it('warns about a slot still waiting for consent, and names the command', async () => {
    const home = await mangoHome({ remote: null });
    const [probe] = await probeRuntimeSlots(home);

    const result = checkRuntimeSlot(probe as NonNullable<typeof probe>);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('mangostudio-runtime setup');
  });

  it('fails on an unreadable config, which would otherwise read as full consent', async () => {
    const home = await mangoHome({ host: 'not json at all' });
    const [probe] = await probeRuntimeSlots(home);

    expect(checkRuntimeSlot(probe as NonNullable<typeof probe>).status).toBe('fail');
  });
});
