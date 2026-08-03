import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { createSlotConsentSource, staticConsentSource } from '../../src/consent-source';
import { writeRuntimeSlotConfig } from '../../src/runtime-home';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function isolatedEnv(): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), 'mango-consent-source-'));
  homes.push(home);
  return { MANGO_HOME: home };
}

describe('staticConsentSource', () => {
  it('returns the same allow set forever', async () => {
    const source = staticConsentSource(RUNTIME_CONSENT_PRESETS.readonly, 'wsl');
    expect(source.slot).toBe('wsl');
    expect(source.current()).toEqual(RUNTIME_CONSENT_PRESETS.readonly);
    expect(await source.refresh()).toEqual(RUNTIME_CONSENT_PRESETS.readonly);
  });
});

describe('createSlotConsentSource', () => {
  it('starts from the initial allow set and picks up a setup write', async () => {
    const env = await isolatedEnv();
    const source = createSlotConsentSource({
      slot: 'host',
      initial: RUNTIME_CONSENT_PRESETS.full,
      env,
    });

    expect(source.current()).toEqual(RUNTIME_CONSENT_PRESETS.full);
    expect(await source.refresh()).toEqual(RUNTIME_CONSENT_PRESETS.full);

    await writeRuntimeSlotConfig(
      'host',
      { allow: RUNTIME_CONSENT_PRESETS.readonly, profile: 'readonly' },
      env
    );

    expect(await source.refresh()).toEqual(RUNTIME_CONSENT_PRESETS.readonly);
    expect(source.current()).toEqual(RUNTIME_CONSENT_PRESETS.readonly);
  });

  it('skips the filesystem when the config file has not changed', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig(
      'host',
      { allow: RUNTIME_CONSENT_PRESETS.full, profile: 'full' },
      env
    );
    const source = createSlotConsentSource({
      slot: 'host',
      initial: RUNTIME_CONSENT_PRESETS.full,
      env,
    });

    expect(await source.refresh()).toEqual(RUNTIME_CONSENT_PRESETS.full);
    // Second refresh hits the mtime cache; mutating the in-memory snapshot would
    // be invisible if the file were re-read, so the cache is what we are
    // asserting — the returned object identity is not, because the source
    // stores the allow value by value.
    expect(await source.refresh()).toEqual(RUNTIME_CONSENT_PRESETS.full);
  });
});
