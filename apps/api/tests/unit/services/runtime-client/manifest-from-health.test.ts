import { describe, expect, it } from 'bun:test';
import type { RuntimeImplementation } from '@mangostudio/shared/runtime-contract';
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
      enforcesPathPolicy: true,
      publishesWindowsSlot: true,
      directoryHashDomain: 2,
      terminalCloseAfterRevocation: true,
    });

    expect(refreshed.enforcesPathPolicy).toBe(true);
    expect(refreshed.publishesWindowsSlot).toBe(true);
    expect(refreshed.directoryHashDomain).toBe(2);
    expect(refreshed.terminalCloseAfterRevocation).toBe(true);
  });

  it('does not invent build facts a handshake never claimed', () => {
    const report: RuntimeHealthReport = {
      ...baseReport,
      profile: 'full',
      allow: RUNTIME_CONSENT_PRESETS.full,
    };

    const refreshed = capabilityManifestFromHealth(report, capabilityManifestFromHealth(report));

    expect(refreshed.enforcesPathPolicy).toBeUndefined();
    expect(refreshed.publishesWindowsSlot).toBeUndefined();
    expect(refreshed.directoryHashDomain).toBeUndefined();
    expect(refreshed.terminalCloseAfterRevocation).toBeUndefined();
  });

  it('keeps the handshake implementation ceiling while applying later consent changes', () => {
    const fullReport: RuntimeHealthReport = {
      ...baseReport,
      profile: 'full',
      allow: RUNTIME_CONSENT_PRESETS.full,
    };
    const handshake = {
      ...capabilityManifestFromHealth(fullReport),
      features: {
        tools: true,
        git: false,
        probing: true,
        mcp: false,
        library: false,
        checkpoints: false,
        fsRead: false,
        fsWrite: false,
        shell: false,
        update: false,
        externalAgents: false,
        toolchain: true,
      },
    };

    expect(capabilityManifestFromHealth(fullReport, handshake).features).toEqual(
      handshake.features
    );

    const revoked = capabilityManifestFromHealth(
      {
        ...fullReport,
        profile: 'none',
        allow: RUNTIME_CONSENT_PRESETS.none,
      },
      handshake
    );
    expect(revoked.features).toEqual({
      ...handshake.features,
      tools: false,
      probing: false,
    });
  });

  describe('a peer that announces its implementation in hello', () => {
    const noneReport: RuntimeHealthReport = {
      ...baseReport,
      profile: 'none',
      allow: RUNTIME_CONSENT_PRESETS.none,
    };
    const grantedReport: RuntimeHealthReport = {
      ...baseReport,
      profile: 'custom',
      allow: { ...RUNTIME_CONSENT_PRESETS.none, shell: true, externalAgents: true, git: true },
      terminal: true,
    };
    const implementation: RuntimeImplementation = {
      schema: 1,
      fingerprint: 'a'.repeat(64),
      features: {
        git: false,
        probing: true,
        mcp: true,
        library: true,
        checkpoints: true,
        fsRead: true,
        fsWrite: true,
        shell: true,
        update: true,
        externalAgents: true,
        terminal: false,
      },
    };
    // Hello under a `none` profile: every effective feature is false.
    const handshake = { ...capabilityManifestFromHealth(noneReport), implementation };

    it('applies a later consent grant without a reconnect', () => {
      const granted = capabilityManifestFromHealth(grantedReport, handshake);

      expect({
        shell: granted.features.shell,
        externalAgents: granted.features.externalAgents,
      }).toEqual({ shell: true, externalAgents: true });
    });

    it('keeps a build gap closed even after consent is granted', () => {
      const granted = capabilityManifestFromHealth(grantedReport, handshake);

      expect({ git: granted.features.git, terminal: granted.terminal }).toEqual({
        git: false,
        terminal: false,
      });
    });

    it('carries the implementation forward unchanged across consent changes', () => {
      const granted = capabilityManifestFromHealth(grantedReport, handshake);
      const revoked = capabilityManifestFromHealth(noneReport, granted);

      expect(granted.implementation).toEqual(implementation);
      expect(revoked.implementation).toEqual(implementation);
      expect(revoked.features.shell).toBe(false);
    });
  });

  it('treats an implementation at another schema version as not announced', () => {
    const noneReport: RuntimeHealthReport = {
      ...baseReport,
      profile: 'none',
      allow: RUNTIME_CONSENT_PRESETS.none,
    };
    const hello = capabilityManifestFromHealth(noneReport);
    const handshake = {
      ...hello,
      implementation: {
        schema: 2,
        fingerprint: 'a'.repeat(64),
        features: {
          git: true,
          probing: true,
          mcp: true,
          library: true,
          checkpoints: true,
          fsRead: true,
          fsWrite: true,
          shell: true,
          update: true,
          externalAgents: true,
          terminal: true,
        },
      },
    };

    const granted = capabilityManifestFromHealth(
      { ...baseReport, profile: 'custom', allow: { ...RUNTIME_CONSENT_PRESETS.none, shell: true } },
      handshake
    );

    expect({ shell: granted.features.shell, implementation: granted.implementation }).toEqual({
      shell: false,
      implementation: undefined,
    });
  });

  describe('a peer that does not announce its implementation', () => {
    it('keeps a handshake consent refusal closed until the peer reconnects', () => {
      const noneReport: RuntimeHealthReport = {
        ...baseReport,
        profile: 'none',
        allow: RUNTIME_CONSENT_PRESETS.none,
      };
      const handshake = capabilityManifestFromHealth(noneReport);
      expect(handshake.implementation).toBeUndefined();

      const granted = capabilityManifestFromHealth(
        {
          ...baseReport,
          profile: 'custom',
          allow: { ...RUNTIME_CONSENT_PRESETS.none, shell: true, externalAgents: true },
        },
        handshake
      );

      // Hello cannot tell a build gap from a refusal, so the refusal is the
      // ceiling: fail-closed, never lifted.
      expect({
        shell: granted.features.shell,
        externalAgents: granted.features.externalAgents,
      }).toEqual({ shell: false, externalAgents: false });
      expect(granted.implementation).toBeUndefined();
    });
  });

  it('derives tools from effective groups, not raw consent, without a handshake (#1100)', () => {
    const report: RuntimeHealthReport = {
      ...baseReport,
      git: { available: false },
      profile: 'custom',
      allow: { ...RUNTIME_CONSENT_PRESETS.none, git: true, update: true, externalAgents: true },
    };

    const refreshed = capabilityManifestFromHealth(report);

    // git is consented but the binary is missing; update and externalAgents
    // are not tool groups. No effective tool group remains.
    expect({ tools: refreshed.features.tools, git: refreshed.features.git }).toEqual({
      tools: false,
      git: false,
    });
  });

  it('derives tools from capabilities that are both allowed and implemented', () => {
    const report: RuntimeHealthReport = {
      ...baseReport,
      profile: 'custom',
      allow: {
        ...RUNTIME_CONSENT_PRESETS.none,
        fsRead: true,
      },
    };
    const handshake = {
      ...capabilityManifestFromHealth(report),
      features: {
        tools: true,
        git: false,
        probing: true,
        mcp: false,
        library: false,
        checkpoints: false,
        fsRead: false,
        fsWrite: false,
        shell: false,
        update: false,
        externalAgents: false,
        toolchain: true,
      },
    };

    expect(capabilityManifestFromHealth(report, handshake).features).toMatchObject({
      tools: false,
      probing: false,
      fsRead: false,
    });
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
