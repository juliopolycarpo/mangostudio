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
    expect(manifest.features.externalAgents).toBe(false);
    expect(manifest.shells).toEqual([]);
  });

  it('carries gh across a refresh, which is the leg that silently drops it', () => {
    // The hub rebuilds a remote peer's manifest from health after every consent
    // change and cannot probe another machine. A `gh` that reached the hub only
    // on `hello` would disappear here, and the panel would go dark for reasons
    // nothing logs.
    const report: RuntimeHealthReport = {
      ...baseReport,
      gh: { available: true, version: '2.97.0' },
      profile: 'full',
      allow: RUNTIME_CONSENT_PRESETS.full,
    };
    expect(capabilityManifestFromHealth(report).gh).toEqual({
      available: true,
      version: '2.97.0',
    });
  });

  it('leaves gh absent for a peer that never reported it', () => {
    // Absent means unavailable, and it has to stay *absent* rather than become
    // `{ available: false }`: a hub that manufactures a negative answer cannot
    // later tell "this runtime has no gh" from "this runtime is too old to say".
    const report: RuntimeHealthReport = {
      ...baseReport,
      profile: 'full',
      allow: RUNTIME_CONSENT_PRESETS.full,
    };
    const manifest = capabilityManifestFromHealth(report);
    expect(manifest.gh).toBeUndefined();
    expect('gh' in manifest).toBe(false);
  });

  it('carries terminal across a refresh and leaves it absent when never reported', () => {
    const full = { profile: 'full' as const, allow: RUNTIME_CONSENT_PRESETS.full };
    expect(capabilityManifestFromHealth({ ...baseReport, ...full, terminal: true }).terminal).toBe(
      true
    );
    expect(capabilityManifestFromHealth({ ...baseReport, ...full, terminal: false }).terminal).toBe(
      false
    );
    const silent = capabilityManifestFromHealth({ ...baseReport, ...full });
    expect('terminal' in silent).toBe(false);
  });

  it('preserves runtime targets and an explicit isolation attestation across refreshes', () => {
    const report: RuntimeHealthReport = {
      ...baseReport,
      profile: 'full',
      allow: { ...RUNTIME_CONSENT_PRESETS.full, externalAgents: true },
      externalAgents: {
        targets: ['codex'],
        identityIsolation: {
          method: 'single-user-host',
          credentialHomeFingerprint: 'credential-home-v1',
        },
        liveSessionCount: 0,
        liveSessions: [],
      },
    };

    expect(capabilityManifestFromHealth(report)).toMatchObject({
      features: { externalAgents: true },
      externalAgents: ['codex'],
      identityIsolation: {
        method: 'single-user-host',
        credentialHomeFingerprint: 'credential-home-v1',
      },
    });
  });

  /**
   * Health answers what the owner allowed and what the machine has. What the
   * peer's *build* can do only ever arrives on `hello`, so a refresh that
   * recomputed the manifest from health alone would downgrade a peer to
   * "older" on the first background read of a connection it already completed —
   * and the hub would start warning about a runtime that does enforce.
   */
  it('carries handshake-only build facts forward across a refresh', () => {
    const report: RuntimeHealthReport = {
      ...baseReport,
      profile: 'full',
      allow: RUNTIME_CONSENT_PRESETS.full,
    };

    const refreshed = capabilityManifestFromHealth(report, {
      ...capabilityManifestFromHealth(report),
      acceptsHubIdentity: true,
      enforcesPathPolicy: true,
      directoryHashDomain: 2,
    });

    expect(refreshed.acceptsHubIdentity).toBe(true);
    expect(refreshed.enforcesPathPolicy).toBe(true);
    expect(refreshed.directoryHashDomain).toBe(2);
  });

  it('does not invent build facts a handshake never claimed', () => {
    const report: RuntimeHealthReport = {
      ...baseReport,
      profile: 'full',
      allow: RUNTIME_CONSENT_PRESETS.full,
    };

    const refreshed = capabilityManifestFromHealth(report, capabilityManifestFromHealth(report));

    expect(refreshed.acceptsHubIdentity).toBeUndefined();
    expect(refreshed.enforcesPathPolicy).toBeUndefined();
    expect(refreshed.directoryHashDomain).toBeUndefined();
  });

  it('does not infer adapter support or isolation from an older health report', () => {
    const { externalAgents: _externalAgents, ...oldAllow } = RUNTIME_CONSENT_PRESETS.readonly;
    const report: RuntimeHealthReport = {
      ...baseReport,
      profile: 'custom',
      allow: oldAllow,
    };

    const manifest = capabilityManifestFromHealth(report);

    expect(manifest.features.externalAgents).toBe(false);
    expect(manifest.externalAgents).toBeUndefined();
    expect(manifest.identityIsolation).toBeUndefined();
  });
});
