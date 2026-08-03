import { describe, expect, it } from 'bun:test';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { createLocalRuntimeManifest } from '../../src/manifest';

describe('createLocalRuntimeManifest', () => {
  it('derives a full profile from the full allow set', () => {
    const manifest = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.full);
    expect(manifest.profile).toBe('full');
    expect(manifest.features.fsRead).toBe(true);
    expect(manifest.features.fsWrite).toBe(true);
    expect(manifest.features.shell).toBe(manifest.shells.length > 0);
    expect(manifest.features.update).toBe(true);
    expect(manifest.features.tools).toBe(true);
  });

  it('advertises readonly without shell or write', () => {
    const manifest = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);
    expect(manifest.profile).toBe('readonly');
    expect(manifest.features.fsRead).toBe(true);
    expect(manifest.features.fsWrite).toBe(false);
    expect(manifest.features.shell).toBe(false);
    expect(manifest.shells).toEqual([]);
    expect(manifest.features.mcp).toBe(false);
    expect(manifest.features.update).toBe(false);
    expect(manifest.features.probing).toBe(true);
    expect(manifest.features.library).toBe(true);
  });

  it('advertises none with every feature off', () => {
    const manifest = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.none);
    expect(manifest.profile).toBe('none');
    expect(manifest.features.tools).toBe(false);
    expect(manifest.features.fsRead).toBe(false);
    expect(manifest.features.fsWrite).toBe(false);
    expect(manifest.features.shell).toBe(false);
    expect(manifest.features.git).toBe(false);
    expect(manifest.features.probing).toBe(false);
    expect(manifest.features.mcp).toBe(false);
    expect(manifest.features.library).toBe(false);
    expect(manifest.features.checkpoints).toBe(false);
    expect(manifest.features.update).toBe(false);
    expect(manifest.git.available).toBe(false);
    expect(manifest.shells).toEqual([]);
  });
});
