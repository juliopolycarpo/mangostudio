import { describe, expect, it } from 'bun:test';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { capabilityManifestFromHealth } from '../../../../src/services/runtime-client/manifest-from-health';

const baseReport = {
  schemaVersion: 1,
  slot: 'remote' as const,
  source: 'provisioned' as const,
  runtimeVersion: '0.1.1',
  version: '0.1.1',
  binaryPath: '/opt/mango/mangostudio-runtime',
  digest: null,
  setup: { state: 'configured' as const },
  platform: 'linux',
  arch: 'x64',
  homeDir: '/home/peer',
  shells: ['bash'],
  git: { available: true, version: '2.45.0' },
  lastError: null,
  audit: { enabled: true },
} satisfies Omit<RuntimeHealthReport, 'profile' | 'allow'>;

describe('capabilityManifestFromHealth', () => {
  it('projects a readonly allow set into the hello feature shape', () => {
    const report: RuntimeHealthReport = {
      ...baseReport,
      profile: 'readonly',
      allow: RUNTIME_CONSENT_PRESETS.readonly,
    };
    const manifest = capabilityManifestFromHealth(report);
    expect(manifest.profile).toBe('readonly');
    expect(manifest.homeDir).toBe('/home/peer');
    expect(manifest.features.fsRead).toBe(true);
    expect(manifest.features.fsWrite).toBe(false);
    expect(manifest.features.shell).toBe(false);
    expect(manifest.shells).toEqual([]);
  });
});
