import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  type InstallPreparation,
  InstallPreparationSchema,
  type InstallStreamEvent,
  InstallStreamEventSchema,
  RuntimeSetupBodySchema,
  type RuntimeStatus,
  RuntimeStatusSchema,
  type VersionManagerStatus,
  VersionManagerStatusSchema,
} from '../../src/environments';

describe('RuntimeStatusSchema', () => {
  it('validates coded runtime findings and installation metadata', () => {
    const status: RuntimeStatus = {
      id: 'node',
      health: 'warn',
      installations: [
        {
          path: '/opt/node-v22/bin/node',
          rawPath: '/usr/local/bin/node',
          version: 'v22.13.0',
          origin: 'version-manager',
          pathIndex: 0,
          effective: true,
          managedBy: 'nvm',
        },
      ],
      effective: {
        path: '/opt/node-v22/bin/node',
        rawPath: '/usr/local/bin/node',
        version: 'v22.13.0',
        origin: 'version-manager',
        pathIndex: 0,
        effective: true,
        managedBy: 'nvm',
      },
      findings: [
        {
          code: 'shadowed-by-earlier-path',
          params: {
            effectivePath: '/usr/local/bin/node',
            shadowedPath: '/usr/bin/node',
          },
        },
      ],
      installable: false,
      probedAtMs: 1_700_000_000_000,
    };

    expect(Value.Check(RuntimeStatusSchema, status)).toBe(true);
    expect(
      Value.Check(RuntimeStatusSchema, {
        ...status,
        findings: [{ code: 'english sentence from the API' }],
      })
    ).toBe(false);
  });
});

describe('VersionManagerStatusSchema', () => {
  it('validates managed versions and LTS policy metadata', () => {
    const status: VersionManagerStatus = {
      id: 'nvm',
      installed: true,
      root: '/home/tester/.nvm',
      managerVersion: '0.40.6',
      versions: [
        {
          version: '24.18.0',
          path: '/home/tester/.nvm/versions/node/v24.18.0/bin/node',
          isDefault: true,
          isCurrent: false,
          ltsStatus: 'current-lts',
          ltsCodename: 'krypton',
        },
      ],
      defaultAlias: 'lts/*',
      defaultVersion: '24.18.0',
      findings: [{ code: 'managed-but-not-on-path', params: { manager: 'nvm' } }],
    };

    expect(Value.Check(VersionManagerStatusSchema, status)).toBe(true);
    expect(
      Value.Check(VersionManagerStatusSchema, {
        ...status,
        versions: [{ ...status.versions[0], ltsStatus: 'green-ish' }],
      })
    ).toBe(false);
  });
});

describe('environment install schemas', () => {
  it('validates a guarded downloaded-script preparation', () => {
    const preparation: InstallPreparation = {
      preparationId: 'prepare-1',
      expiresAt: 1_700_000_600_000,
      recipe: {
        id: 'bun.install.official',
        runtimeId: 'bun',
        action: 'install',
        inputKind: 'none',
        platforms: ['darwin', 'linux'],
        argv: ['bash', '/tmp/mango-install/installer.sh'],
        copyCommand: 'curl -fsSL https://bun.com/install | bash',
        requires: [],
        writes: ['$HOME/.bun'],
        networkAccess: true,
        timeoutMs: 300_000,
        supported: true,
        missingRequirements: [],
        guard: { allowed: true, reasons: [] },
        download: {
          url: 'https://bun.com/install',
          sizeBytes: 12_345,
        },
        profileSetup: {
          lines: ['export BUN_INSTALL="$HOME/.bun"', 'export PATH="$BUN_INSTALL/bin:$PATH"'],
          present: false,
          detectedIn: [],
        },
      },
    };

    expect(Value.Check(InstallPreparationSchema, preparation)).toBe(true);
  });

  it('keeps exit terminal while probe and log events remain non-terminal', () => {
    const events: InstallStreamEvent[] = [
      { type: 'log', stream: 'stdout', line: 'installed', done: false },
      {
        type: 'probe',
        target: 'runtime',
        status: {
          id: 'bun',
          health: 'ok',
          installations: [],
          findings: [],
          installable: true,
          probedAtMs: 1_700_000_000_000,
        },
        done: false,
      },
      {
        type: 'exit',
        code: 0,
        status: 'succeeded',
        truncated: false,
        durationMs: 100,
        done: true,
      },
    ];

    expect(events.every((event) => Value.Check(InstallStreamEventSchema, event))).toBe(true);
  });
});

describe('RuntimeSetupBodySchema', () => {
  it('requires a full allow matrix when profile is custom', () => {
    const fullAllow = {
      fsRead: true,
      fsWrite: false,
      shell: false,
      git: true,
      probing: true,
      mcp: false,
      library: true,
      checkpoints: false,
      update: false,
    };

    expect(Value.Check(RuntimeSetupBodySchema, { profile: 'readonly' })).toBe(true);
    expect(Value.Check(RuntimeSetupBodySchema, { profile: 'custom' })).toBe(false);
    expect(Value.Check(RuntimeSetupBodySchema, { profile: 'custom', allow: { shell: true } })).toBe(
      false
    );
    expect(Value.Check(RuntimeSetupBodySchema, { profile: 'custom', allow: fullAllow })).toBe(true);
  });

  // A preset *is* the answer. Accepting an `allow` beside one meant the server
  // silently ignored it — a body that displays one consent and records another.
  it('refuses an allow matrix beside a preset profile', () => {
    expect(Value.Check(RuntimeSetupBodySchema, { profile: 'full', allow: { shell: false } })).toBe(
      false
    );
    expect(Value.Check(RuntimeSetupBodySchema, { profile: 'none', allow: {} })).toBe(false);
  });
});
