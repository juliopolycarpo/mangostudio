import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';
import {
  defaultAuditEnabledForSlot,
  defaultConsentForSlot,
  deniedCapabilities,
  mangoHomeDir,
  profileForAllow,
  RUNTIME_CAPABILITY_KEYS,
  RUNTIME_CONSENT_PRESETS,
  RuntimeHealthReportSchema,
  RuntimeSlotConfigSchema,
  resolveRuntimeSlotConfig,
  runtimeBinaryName,
  runtimeSlotAuditLogPath,
  runtimeSlotConfigPath,
  runtimeSlotCurrentBinaryPath,
  runtimeSlotDir,
  runtimeSlotForPath,
  runtimeSlotVersionBinaryPath,
} from '../../src/runtime-home';

const POSIX_HOME = { mangoHome: '/home/j/.mango' } as const;
const WIN_HOME = { mangoHome: 'C:\\Users\\j\\.mango', platform: 'win32' } as const;

describe('runtime home paths', () => {
  it('resolves the slot layout on posix', () => {
    expect(runtimeSlotDir('wsl', POSIX_HOME)).toBe('/home/j/.mango/runtime/wsl');
    expect(runtimeSlotConfigPath('remote', POSIX_HOME)).toBe(
      '/home/j/.mango/runtime/remote/runtime.json'
    );
    expect(runtimeSlotAuditLogPath('remote', POSIX_HOME)).toBe(
      '/home/j/.mango/runtime/remote/audit.log'
    );
    expect(runtimeSlotVersionBinaryPath('remote', '0.1.1', POSIX_HOME)).toBe(
      '/home/j/.mango/runtime/remote/0.1.1/mangostudio-runtime'
    );
  });

  it('resolves the slot layout on win32, including the executable suffix', () => {
    expect(runtimeSlotDir('host', WIN_HOME)).toBe('C:\\Users\\j\\.mango\\runtime\\host');
    expect(runtimeSlotCurrentBinaryPath('host', WIN_HOME)).toBe(
      'C:\\Users\\j\\.mango\\runtime\\host\\current\\mangostudio-runtime.exe'
    );
    expect(runtimeBinaryName('win32')).toBe('mangostudio-runtime.exe');
    expect(runtimeBinaryName('linux')).toBe('mangostudio-runtime');
  });

  it('builds the home directory from an injected home', () => {
    expect(mangoHomeDir('/home/j')).toBe('/home/j/.mango');
    expect(mangoHomeDir('C:\\Users\\j', 'win32')).toBe('C:\\Users\\j\\.mango');
  });

  it('keeps the remote launch path free of a version that an upgrade would dangle', () => {
    expect(runtimeSlotCurrentBinaryPath('remote', { mangoHome: mangoHomeDir('~') })).toBe(
      '~/.mango/runtime/remote/current/mangostudio-runtime'
    );
  });

  it('reads a slot back out of a path, and only on a boundary', () => {
    expect(
      runtimeSlotForPath('/home/j/.mango/runtime/remote/0.1.1/mangostudio-runtime', POSIX_HOME)
    ).toBe('remote');
    expect(runtimeSlotForPath('/home/j/.mango/runtime/remote', POSIX_HOME)).toBe('remote');
    expect(runtimeSlotForPath('/home/j/.mango/runtime/remotely/x', POSIX_HOME)).toBeNull();
    expect(runtimeSlotForPath('/usr/local/bin/mangostudio-runtime', POSIX_HOME)).toBeNull();
  });

  it('tolerates either separator on win32', () => {
    expect(
      runtimeSlotForPath('C:/Users/j/.mango/runtime/host/current/mangostudio-runtime.exe', WIN_HOME)
    ).toBe('host');
  });

  it('matches a win32 path however Windows spelled its case', () => {
    // `process.execPath` and `homedir()` disagree about case often enough that
    // a case-sensitive compare loses the config governing the running binary.
    expect(
      runtimeSlotForPath('C:\\USERS\\J\\.mango\\Runtime\\Host\\current\\x.exe', WIN_HOME)
    ).toBe('host');
  });

  it('keeps a backslash a filename on posix, where it is one', () => {
    // Reading it as a separator would put a file that sits beside the slots
    // inside `host` — the slot whose default is full consent.
    expect(runtimeSlotForPath('/home/j/.mango/runtime/host\\x', POSIX_HOME)).toBeNull();
    expect(runtimeSlotForPath('/home/j/.mango/runtime/remote\\x', POSIX_HOME)).toBeNull();
  });

  it('does not fold case on posix, where two spellings are two files', () => {
    expect(runtimeSlotForPath('/home/j/.mango/runtime/HOST/x', POSIX_HOME)).toBeNull();
  });
});

describe('consent presets', () => {
  it('names every preset back from its allow set', () => {
    for (const [name, allow] of Object.entries(RUNTIME_CONSENT_PRESETS)) {
      expect(profileForAllow(allow)).toBe(name as 'full');
    }
  });

  it('calls anything else custom', () => {
    expect(profileForAllow({ ...RUNTIME_CONSENT_PRESETS.readonly, shell: true })).toBe('custom');
  });

  it('reads an omitted externalAgents as denied rather than as a custom set', () => {
    for (const name of ['readonly', 'none'] as const) {
      const { externalAgents: _omitted, ...withoutExternalAgents } = RUNTIME_CONSENT_PRESETS[name];
      expect(profileForAllow(withoutExternalAgents)).toBe(name);
    }
    // `full` grants it, so its absence really is a different set.
    const { externalAgents: _granted, ...fullWithout } = RUNTIME_CONSENT_PRESETS.full;
    expect(profileForAllow(fullWithout)).toBe('custom');
  });

  it('grants nothing beyond reading in readonly', () => {
    const readonly = RUNTIME_CONSENT_PRESETS.readonly;
    expect(readonly.fsRead).toBe(true);
    expect(readonly.git).toBe(true);
    expect(readonly.probing).toBe(true);
    expect(readonly.library).toBe(true);
    for (const key of [
      'fsWrite',
      'shell',
      'mcp',
      'update',
      'checkpoints',
      'externalAgents',
    ] as const) {
      expect(readonly[key]).toBe(false);
    }
  });

  it('grants external agents only in the full preset', () => {
    expect(RUNTIME_CONSENT_PRESETS.full.externalAgents).toBe(true);
    expect(RUNTIME_CONSENT_PRESETS.readonly.externalAgents).toBe(false);
    expect(RUNTIME_CONSENT_PRESETS.none.externalAgents).toBe(false);
  });

  it('lists what a profile denies', () => {
    expect(deniedCapabilities(RUNTIME_CONSENT_PRESETS.full)).toEqual([]);
    expect(deniedCapabilities(RUNTIME_CONSENT_PRESETS.none)).toEqual(RUNTIME_CAPABILITY_KEYS);
  });
});

describe('resolveRuntimeSlotConfig', () => {
  it('treats an absent config as full consent for a slot this machine installed', () => {
    for (const slot of ['host', 'wsl'] as const) {
      const resolved = resolveRuntimeSlotConfig(slot, null, { source: 'bundled' });
      expect(resolved.profile).toBe('full');
      expect(resolved.setup.state).toBe('configured');
    }
  });

  it('defaults audit off for host and on for wsl and remote', () => {
    expect(defaultAuditEnabledForSlot('host')).toBe(false);
    expect(defaultAuditEnabledForSlot('wsl')).toBe(true);
    expect(defaultAuditEnabledForSlot('remote')).toBe(true);
    expect(resolveRuntimeSlotConfig('host', null, { source: 'bundled' }).audit.enabled).toBe(false);
    expect(resolveRuntimeSlotConfig('wsl', null, { source: 'provisioned' }).audit.enabled).toBe(
      true
    );
    expect(resolveRuntimeSlotConfig('remote', null, { source: 'provisioned' }).audit.enabled).toBe(
      true
    );
  });

  it('keeps an explicit audit toggle from the stored file', () => {
    const resolved = resolveRuntimeSlotConfig(
      'host',
      { schemaVersion: 1, slot: 'host', audit: { enabled: true } },
      { source: 'bundled' }
    );
    expect(resolved.audit.enabled).toBe(true);
  });

  it("treats an absent config as pending for a slot somebody else's hub installed", () => {
    const resolved = resolveRuntimeSlotConfig('remote', null, { source: 'provisioned' });
    expect(resolved.profile).toBe('none');
    expect(resolved.setup.state).toBe('pending');
    expect(defaultConsentForSlot('remote').setup.state).toBe('pending');
  });

  it('re-derives the profile from the allow set rather than trusting the label', () => {
    const resolved = resolveRuntimeSlotConfig(
      'wsl',
      {
        schemaVersion: 1,
        slot: 'wsl',
        profile: 'readonly',
        allow: { ...RUNTIME_CONSENT_PRESETS.readonly, shell: true },
      },
      { source: 'provisioned' }
    );
    expect(resolved.profile).toBe('custom');
    expect(resolved.allow.shell).toBe(true);
  });

  it('fills a capability the stored file never heard of from the slot default, not from true', () => {
    const resolved = resolveRuntimeSlotConfig(
      'remote',
      { schemaVersion: 1, slot: 'remote', allow: { fsRead: true } },
      { source: 'provisioned' }
    );
    expect(resolved.allow.fsRead).toBe(true);
    expect(resolved.allow.shell).toBe(false);
    expect(resolved.allow.update).toBe(false);
  });

  it('default-denies external agents in an old stored file even for a full-default slot', () => {
    const resolved = resolveRuntimeSlotConfig(
      'host',
      { schemaVersion: 1, slot: 'host', allow: { fsRead: true } },
      { source: 'bundled' }
    );
    expect(resolved.allow.fsRead).toBe(true);
    expect(resolved.allow.shell).toBe(true);
    expect(resolved.allow.externalAgents).toBe(false);
    expect(resolved.profile).toBe('custom');
  });

  it('carries the identity fields through', () => {
    const resolved = resolveRuntimeSlotConfig(
      'remote',
      {
        schemaVersion: 1,
        slot: 'remote',
        source: 'provisioned',
        version: '0.1.1',
        binaryPath: '/home/j/.mango/runtime/remote/0.1.1/mangostudio-runtime',
        digest: `sha256:${'a'.repeat(64)}`,
        hubUrl: 'wss://hub.test/api/runtime',
        installedBy: { hubVersion: '0.1.1', host: 'win-desktop' },
        setup: { state: 'configured', by: 'cli' },
        allow: RUNTIME_CONSENT_PRESETS.full,
      },
      { source: 'bundled' }
    );
    expect(resolved.source).toBe('provisioned');
    expect(resolved.version).toBe('0.1.1');
    expect(resolved.digest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(resolved.hubUrl).toBe('wss://hub.test/api/runtime');
    expect(resolved.installedBy?.host).toBe('win-desktop');
    expect(resolved.profile).toBe('full');
  });
});

describe('RuntimeSlotConfigSchema', () => {
  it('accepts the minimum a slot can be written with', () => {
    expect(Value.Check(RuntimeSlotConfigSchema, { schemaVersion: 1, slot: 'host' })).toBe(true);
  });

  it('ignores a key written by a newer runtime rather than failing the read', () => {
    expect(
      Value.Check(RuntimeSlotConfigSchema, {
        schemaVersion: 2,
        slot: 'remote',
        somethingFromTheFuture: { nested: true },
        allow: { fsRead: true, telepathy: true },
      })
    ).toBe(true);
  });

  it('rejects a digest that is not a sha256 one', () => {
    expect(
      Value.Check(RuntimeSlotConfigSchema, { schemaVersion: 1, slot: 'host', digest: 'sha1:abc' })
    ).toBe(false);
  });
});

describe('RuntimeHealthReportSchema', () => {
  const baseReport = {
    schemaVersion: 1,
    slot: 'host',
    source: 'source-checkout',
    runtimeVersion: '0.1.0',
    version: null,
    binaryPath: null,
    digest: null,
    profile: 'none',
    allow: RUNTIME_CONSENT_PRESETS.none,
    setup: { state: 'pending' },
    platform: 'linux',
    arch: 'x64',
    homeDir: '/home/j',
    shells: [],
    git: { available: false },
    lastError: null,
  } as const;

  it('accepts a report that omits audit so a pre-audit peer stays valid', () => {
    expect(Value.Check(RuntimeHealthReportSchema, baseReport)).toBe(true);
  });

  it('still accepts a report that includes audit', () => {
    expect(
      Value.Check(RuntimeHealthReportSchema, { ...baseReport, audit: { enabled: true } })
    ).toBe(true);
  });

  it('accepts optional external-agent diagnostics while keeping an old report valid', () => {
    expect(
      Value.Check(RuntimeHealthReportSchema, {
        ...baseReport,
        externalAgents: {
          targets: ['codex'],
          identityIsolation: {
            method: 'single-user-host',
            credentialHomeFingerprint: 'sha256:credential-home',
          },
          liveSessionCount: 1,
          liveSessions: [
            { sessionId: 'session-1', targetId: 'codex', ageMs: 250, state: 'running' },
          ],
        },
      })
    ).toBe(true);
    expect(Value.Check(RuntimeHealthReportSchema, baseReport)).toBe(true);
  });
});
