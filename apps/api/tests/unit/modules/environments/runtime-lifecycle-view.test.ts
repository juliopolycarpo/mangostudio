import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import {
  buildRuntimeLifecycleView,
  lifecycleActions,
  manualRuntimeReleaseAssetName,
  releasePlatformIdFromHint,
} from '../../../../src/modules/environments/domain/runtime-lifecycle-view';

const health = (overrides: Partial<RuntimeHealthReport> = {}): RuntimeHealthReport => ({
  schemaVersion: 1,
  slot: 'wsl',
  source: 'provisioned',
  runtimeVersion: '1.2.3',
  version: '1.2.3',
  binaryPath: '/home/u/.mango/runtime/wsl/current/mangostudio-runtime',
  digest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  profile: 'full',
  allow: {
    git: true,
    probing: true,
    mcp: true,
    library: true,
    checkpoints: true,
    fsRead: true,
    fsWrite: true,
    shell: true,
    update: true,
  },
  setup: { state: 'configured', at: '2026-01-01T00:00:00.000Z', by: 'cli' },
  platform: 'linux',
  arch: 'x64',
  platformId: 'linux-x64-musl',
  homeDir: '/home/u',
  shells: ['bash'],
  git: { available: true, version: '2.47.0' },
  lastError: null,
  ...overrides,
  audit: overrides.audit ?? { enabled: true },
});

describe('lifecycleActions', () => {
  it('gives WSL install/reinstall/upgrade and SSH those plus setup', () => {
    expect(lifecycleActions('wsl')).toEqual(['install', 'reinstall', 'upgrade']);
    expect(lifecycleActions('ssh')).toEqual(['install', 'reinstall', 'upgrade', 'setup']);
  });

  it('gives dial-in and local transports an empty action list', () => {
    expect(lifecycleActions('websocket')).toEqual([]);
    expect(lifecycleActions('http')).toEqual([]);
    expect(lifecycleActions('in-process')).toEqual([]);
    expect(lifecycleActions('stdio')).toEqual([]);
  });
});

describe('buildRuntimeLifecycleView', () => {
  it('marks disconnected health as stale and keeps the payload', () => {
    const view = buildRuntimeLifecycleView({
      transportKind: 'wsl',
      health: health(),
      readAtMs: 1_000,
      connected: false,
      nowMs: 2_000,
    });
    expect(view.stale).toBe(true);
    expect(view.health?.version).toBe('1.2.3');
    expect(view.actions).toEqual(['install', 'reinstall', 'upgrade']);
  });

  it('marks connected fresh health as not stale', () => {
    const view = buildRuntimeLifecycleView({
      transportKind: 'ssh',
      health: health({ slot: 'remote' }),
      readAtMs: 10_000,
      connected: true,
      nowMs: 11_000,
    });
    expect(view.stale).toBe(false);
    expect(view.actions).toContain('setup');
  });

  it('attaches manualCommands for websocket and http only', () => {
    const ws = buildRuntimeLifecycleView({
      transportKind: 'websocket',
      health: null,
      readAtMs: null,
      connected: false,
      nowMs: 1,
    });
    expect(ws.actions).toEqual([]);
    expect(ws.manualCommands?.setup).toContain('setup --slot remote');

    const http = buildRuntimeLifecycleView({
      transportKind: 'http',
      health: null,
      readAtMs: null,
      connected: false,
      nowMs: 1,
      platformHint: 'linux-arm64',
    });
    expect(http.manualCommands?.install).toBeTruthy();

    const wsl = buildRuntimeLifecycleView({
      transportKind: 'wsl',
      health: null,
      readAtMs: null,
      connected: false,
      nowMs: 1,
    });
    expect(wsl.manualCommands).toBeUndefined();
  });

  it('offers live upgrade only for a connected drifting provisioned POSIX runtime', () => {
    const drifting = buildRuntimeLifecycleView({
      transportKind: 'websocket',
      health: health({ slot: 'remote', runtimeVersion: '0.0.1-old' }),
      readAtMs: 1_000,
      connected: true,
      nowMs: 2_000,
    });
    expect(drifting.actions).toEqual(['upgrade']);

    const disconnected = buildRuntimeLifecycleView({
      transportKind: 'websocket',
      health: health({ slot: 'remote', runtimeVersion: '0.0.1-old' }),
      readAtMs: 1_000,
      connected: false,
      nowMs: 2_000,
    });
    expect(disconnected.actions).toEqual([]);

    const windows = buildRuntimeLifecycleView({
      transportKind: 'http',
      health: health({
        slot: 'remote',
        runtimeVersion: '0.0.1-old',
        platform: 'win32',
      }),
      readAtMs: 1_000,
      connected: true,
      nowMs: 2_000,
    });
    expect(windows.actions).toEqual([]);

    const bundled = buildRuntimeLifecycleView({
      transportKind: 'websocket',
      health: health({
        slot: 'remote',
        source: 'bundled',
        runtimeVersion: '0.0.1-old',
      }),
      readAtMs: 1_000,
      connected: true,
      nowMs: 2_000,
    });
    expect(bundled.actions).toEqual([]);

    const legacy = buildRuntimeLifecycleView({
      transportKind: 'websocket',
      health: health({
        slot: 'remote',
        runtimeVersion: '0.0.1-old',
        platformId: undefined,
      }),
      readAtMs: 1_000,
      connected: true,
      nowMs: 2_000,
    });
    expect(legacy.actions).toEqual([]);
  });

  it('keeps WSL and SSH upgrades on their out-of-band push paths', () => {
    for (const transportKind of ['wsl', 'ssh'] as const) {
      const view = buildRuntimeLifecycleView({
        transportKind,
        health: health({ slot: transportKind === 'wsl' ? 'wsl' : 'remote', runtimeVersion: 'old' }),
        readAtMs: 1_000,
        connected: true,
        nowMs: 2_000,
      });
      expect(view.actions).toContain('upgrade');
    }
  });

  it('falls back to manual commands when live update consent is denied', () => {
    const base = health({ slot: 'remote', runtimeVersion: '0.0.1-old' });
    const view = buildRuntimeLifecycleView({
      transportKind: 'websocket',
      health: { ...base, allow: { ...base.allow, update: false } },
      readAtMs: 1_000,
      connected: true,
      nowMs: 2_000,
    });

    expect(view.actions).toEqual([]);
    expect(view.manualCommands?.install).toBeDefined();
  });

  // A machine that has never paired is exactly when this block is read, so the
  // hub has to say it is guessing rather than hand a Windows user Linux bytes.
  it('names the platform the manual commands are for and flags a guess', () => {
    const guessed = buildRuntimeLifecycleView({
      transportKind: 'websocket',
      health: null,
      readAtMs: null,
      connected: false,
      nowMs: 1,
    });
    expect(guessed.manualCommands?.platformId).toBe('linux-x64');
    expect(guessed.manualCommands?.platformAssumed).toBe(true);

    const reported = buildRuntimeLifecycleView({
      transportKind: 'websocket',
      health: null,
      readAtMs: null,
      connected: false,
      nowMs: 1,
      platformHint: 'win32-x64',
    });
    expect(reported.manualCommands?.platformId).toBe('windows-x64');
    expect(reported.manualCommands?.platformAssumed).toBe(false);
  });

  // Regression: `install` used to survive this gate, which made a machine's
  // "no hub-driven updates" answer one button-click wide — all three actions
  // push the same bytes through the same helper, and the push runs out of band
  // on the user's own credentials where the runtime cannot refuse it.
  it('hides every push action when allow.update is false, keeping setup', () => {
    const base = health();
    const denied = health({ allow: { ...base.allow, update: false } });

    expect(
      buildRuntimeLifecycleView({
        transportKind: 'wsl',
        health: denied,
        readAtMs: 1_000,
        connected: true,
        nowMs: 2_000,
      }).actions
    ).toEqual([]);

    expect(
      buildRuntimeLifecycleView({
        transportKind: 'ssh',
        health: denied,
        readAtMs: 1_000,
        connected: true,
        nowMs: 2_000,
      }).actions
    ).toEqual(['setup']);
  });

  it('keeps install available when no runtime has reported consent yet', () => {
    const view = buildRuntimeLifecycleView({
      transportKind: 'wsl',
      health: null,
      readAtMs: null,
      connected: false,
      nowMs: 2_000,
    });
    expect(view.actions).toEqual(['install', 'reinstall', 'upgrade']);
  });

  it('hides managed push actions when managedPush is false', () => {
    const view = buildRuntimeLifecycleView({
      transportKind: 'ssh',
      health: health({ slot: 'remote' }),
      readAtMs: 1_000,
      connected: true,
      nowMs: 2_000,
      managedPush: false,
    });
    expect(view.actions).toEqual(['setup']);
  });
});

describe('manual install commands on a released hub', () => {
  const originalVersion = process.env.VERSION;

  beforeEach(() => {
    // A checkout reports `dev` and gets the "build it yourself" placeholder;
    // the checksum contract only exists on a version that names a release.
    process.env.VERSION = '9.9.9-test';
  });

  afterEach(() => {
    if (originalVersion === undefined) delete process.env.VERSION;
    else process.env.VERSION = originalVersion;
  });

  const manualFor = (platformHint: string) =>
    buildRuntimeLifecycleView({
      transportKind: 'websocket',
      health: null,
      readAtMs: null,
      connected: false,
      nowMs: 1,
      platformHint,
    }).manualCommands;

  // Downloading an executable and chmod'ing it without checking the release
  // checksum is the one shape this block must never hand a user.
  it('checksums the download before chmod on posix', () => {
    const manual = manualFor('linux-x64');
    const install = manual?.install ?? '';

    expect(install).toContain('sha256sum -c -');
    expect(install).toContain('SHA256SUMS');
    expect(install.indexOf('sha256sum -c -')).toBeLessThan(install.indexOf('chmod +x'));
    expect(install).toContain('mangostudio-runtime-9.9.9-test-linux-x64');
    // Posix chains all three, so there is no separate line to miss.
    expect(manual?.verify).toBeUndefined();
  });

  it('gives Windows a separate verify line since PowerShell cannot chain it', () => {
    const manual = manualFor('win32-x64');

    expect(manual?.install).toContain('mangostudio-runtime.exe');
    expect(manual?.verify).toContain('Get-FileHash');
    expect(manual?.verify).toContain('SHA256SUMS');
    expect(manual?.verify).toContain('checksum mismatch');
  });
});

describe('manual release asset naming', () => {
  it('maps Node win32 hints to windows-* release ids with .exe', () => {
    expect(releasePlatformIdFromHint('win32-x64')).toBe('windows-x64');
    expect(releasePlatformIdFromHint('win32-arm64')).toBe('windows-arm64');
    expect(manualRuntimeReleaseAssetName('1.2.3', 'win32-x64')).toBe(
      'mangostudio-runtime-1.2.3-windows-x64.exe'
    );
  });

  it('passes through linux/darwin/musl release ids without an exe suffix', () => {
    expect(releasePlatformIdFromHint('linux-x64-musl')).toBe('linux-x64-musl');
    expect(manualRuntimeReleaseAssetName('1.2.3', 'linux-x64-musl')).toBe(
      'mangostudio-runtime-1.2.3-linux-x64-musl'
    );
    expect(manualRuntimeReleaseAssetName('1.2.3', 'darwin-arm64')).toBe(
      'mangostudio-runtime-1.2.3-darwin-arm64'
    );
  });
});
