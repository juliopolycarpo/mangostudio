import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { RuntimeStagedAsset } from '@mangostudio/shared/environments';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import {
  buildRuntimeLifecycleView,
  lifecycleActions,
  manualRuntimeReleaseAssetName,
  releasePlatformIdFromHint,
  stagedRuntimeAsset,
} from '../../../../src/modules/environments/domain/runtime-lifecycle-view';

// A resolved identity (present or not) is what tells `download` it can offer
// itself; these fixtures cover unrelated gates and just need one to exist.
const anyStagedRuntime: RuntimeStagedAsset = {
  version: '1.2.3',
  platformId: 'linux-x64-musl',
  assetName: 'mangostudio-runtime-1.2.3-linux-x64-musl',
  path: '/home/u/.mango/runtime-cache/1.2.3/mangostudio-runtime-1.2.3-linux-x64-musl',
  verify: 'sha256sum -c -',
  present: false,
};

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
  it('gives WSL install/reinstall/upgrade and SSH those plus setup, both with download', () => {
    expect(lifecycleActions('wsl')).toEqual(['install', 'reinstall', 'upgrade', 'download']);
    expect(lifecycleActions('ssh')).toEqual([
      'install',
      'reinstall',
      'upgrade',
      'setup',
      'download',
    ]);
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
      stagedRuntime: anyStagedRuntime,
    });
    expect(view.stale).toBe(true);
    expect(view.health?.version).toBe('1.2.3');
    expect(view.actions).toEqual(['install', 'reinstall', 'upgrade', 'download']);
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

  /**
   * The card should accuse a machine of running unchecked only when a peer has
   * actually said so. Disconnected, nobody has answered the question, and
   * `false` would read as an answer.
   */
  it('reports containment enforcement only while a peer is connected to answer', () => {
    const declared = buildRuntimeLifecycleView({
      transportKind: 'ssh',
      health: health({ slot: 'remote' }),
      readAtMs: 10_000,
      connected: true,
      nowMs: 11_000,
      enforcesPathPolicy: true,
    });
    expect(declared.enforcesPathPolicy).toBe(true);

    const withDomain = buildRuntimeLifecycleView({
      transportKind: 'ssh',
      health: health({ slot: 'remote' }),
      readAtMs: 10_000,
      connected: true,
      nowMs: 11_000,
      directoryHashDomain: 2,
    });
    expect(withDomain.directoryHashDomain).toBe(2);

    const legacy = buildRuntimeLifecycleView({
      transportKind: 'ssh',
      health: health({ slot: 'remote' }),
      readAtMs: 10_000,
      connected: true,
      nowMs: 11_000,
      enforcesPathPolicy: false,
    });
    expect(legacy.enforcesPathPolicy).toBe(false);

    const disconnected = buildRuntimeLifecycleView({
      transportKind: 'ssh',
      health: health({ slot: 'remote' }),
      readAtMs: 10_000,
      connected: false,
      nowMs: 11_000,
    });
    expect(disconnected.enforcesPathPolicy).toBeUndefined();
    expect(disconnected.directoryHashDomain).toBeUndefined();
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

    // A Windows peer that never declared slot publication is one built before
    // it existed: it would refuse the transfer the click starts.
    const silentWindows = buildRuntimeLifecycleView({
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
    expect(silentWindows.actions).toEqual([]);

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
      publishesWindowsSlot: true,
    });
    expect(windows.actions).toEqual(['upgrade']);

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
  // `download` deliberately survives this gate. `allow.update` is an answer
  // about what a hub may write to *that* machine; staging writes only to the
  // hub, and is exactly what someone who refused hub-driven installs needs in
  // order to carry the verified binary over themselves.
  it('hides every push action when allow.update is false, keeping setup and download', () => {
    const base = health();
    const denied = health({ allow: { ...base.allow, update: false } });

    expect(
      buildRuntimeLifecycleView({
        transportKind: 'wsl',
        health: denied,
        readAtMs: 1_000,
        connected: true,
        nowMs: 2_000,
        stagedRuntime: anyStagedRuntime,
      }).actions
    ).toEqual(['download']);

    expect(
      buildRuntimeLifecycleView({
        transportKind: 'ssh',
        health: denied,
        readAtMs: 1_000,
        connected: true,
        nowMs: 2_000,
        stagedRuntime: anyStagedRuntime,
      }).actions
    ).toEqual(['setup', 'download']);
  });

  it('keeps install available when no runtime has reported consent yet', () => {
    const view = buildRuntimeLifecycleView({
      transportKind: 'wsl',
      health: null,
      readAtMs: null,
      connected: false,
      nowMs: 2_000,
      stagedRuntime: anyStagedRuntime,
    });
    expect(view.actions).toEqual(['install', 'reinstall', 'upgrade', 'download']);
  });

  it('hides managed push actions when managedPush is false, keeping download', () => {
    const view = buildRuntimeLifecycleView({
      transportKind: 'ssh',
      health: health({ slot: 'remote' }),
      readAtMs: 1_000,
      connected: true,
      nowMs: 2_000,
      managedPush: false,
      stagedRuntime: anyStagedRuntime,
    });
    expect(view.actions).toEqual(['setup', 'download']);
  });

  it('passes a resolved staged asset through, and omits it when there is none', () => {
    const staged = {
      version: '1.2.3',
      platformId: 'linux-x64',
      assetName: 'mangostudio-runtime-1.2.3-linux-x64',
      path: '/home/u/.mango/runtime-cache/1.2.3/mangostudio-runtime-1.2.3-linux-x64',
      verify: 'sha256sum -c -',
      present: true,
    } as const;

    const withStaged = buildRuntimeLifecycleView({
      transportKind: 'wsl',
      health: health(),
      readAtMs: 1_000,
      connected: true,
      nowMs: 2_000,
      stagedRuntime: staged,
    });
    expect(withStaged.stagedRuntime).toEqual(staged);
    expect(withStaged.actions).toContain('download');

    const withoutStaged = buildRuntimeLifecycleView({
      transportKind: 'wsl',
      health: health(),
      readAtMs: 1_000,
      connected: true,
      nowMs: 2_000,
    });
    expect(withoutStaged.stagedRuntime).toBeUndefined();
    // A machine that has never reported a platform (or a source-checkout hub
    // with no release to fetch) gives `stagedRuntimeAssetFor` no identity to
    // resolve — offering the button would reject the click with "connect it
    // once" the instant somebody presses it.
    expect(withoutStaged.actions).not.toContain('download');
  });
});

describe('stagedRuntimeAsset', () => {
  const cacheDir = (version: string) => `/home/u/.mango/runtime-cache/${version}`;

  it('names the stable asset and a checksum line that checks the cached path', () => {
    const staged = stagedRuntimeAsset({
      version: '1.2.3',
      platformHint: 'linux-x64',
      cacheDir,
      present: true,
    });

    expect(staged?.assetName).toBe('mangostudio-runtime-1.2.3-linux-x64');
    expect(staged?.path).toBe(
      '/home/u/.mango/runtime-cache/1.2.3/mangostudio-runtime-1.2.3-linux-x64'
    );
    expect(staged?.verify).toContain('releases/download/v1.2.3/SHA256SUMS');
    // The published line names the asset; `sha256sum -c` needs the path this
    // hub actually wrote, so the command has to substitute one for the other.
    expect(staged?.verify).toContain(`{print $1"  ${staged?.path}"}`);
    expect(staged?.verify).toContain('sha256sum -c -');
    expect(staged?.present).toBe(true);
  });

  // The rolling tag and the rolling filename, never the hub's sha-stamped
  // version — that names a tag no release ever published.
  it('resolves a canary hub onto the rolling tag and rolling asset name', () => {
    const staged = stagedRuntimeAsset({
      version: '1.2.3-canary.gabc1234',
      platformHint: 'linux-x64',
      cacheDir,
      present: false,
    });

    expect(staged?.assetName).toBe('mangostudio-runtime-1.2.3-canary-linux-x64');
    expect(staged?.verify).toContain('releases/download/v1.2.3-canary/SHA256SUMS');
    // Cached under the hub's own build, which is what keeps two canary builds
    // in separate directories while both read one tag.
    expect(staged?.path).toContain('/runtime-cache/1.2.3-canary.gabc1234/');
  });

  it('maps a win32 health hint onto the windows asset, .exe included', () => {
    const staged = stagedRuntimeAsset({
      version: '1.2.3',
      platformHint: 'win32-x64',
      cacheDir,
      present: false,
    });

    expect(staged?.platformId).toBe('windows-x64');
    expect(staged?.assetName).toBe('mangostudio-runtime-1.2.3-windows-x64.exe');
  });

  // A release that publishes no standalone runtime for a platform caches the
  // platform archive instead; the metadata has to name what is actually on
  // disk, not the raw asset the download never wrote.
  it('names the platform archive when fromArchive is set', () => {
    const staged = stagedRuntimeAsset({
      version: '1.2.3',
      platformHint: 'linux-x64',
      cacheDir,
      present: true,
      fromArchive: true,
    });

    expect(staged?.assetName).toBe('mangostudio-1.2.3-linux-x64.tar.gz');
    expect(staged?.path).toBe(
      '/home/u/.mango/runtime-cache/1.2.3/mangostudio-1.2.3-linux-x64.tar.gz'
    );
    expect(staged?.verify).toContain(`{print $1"  ${staged?.path}"}`);
  });

  // A Windows hub's cache dir is already backslash-shaped; appending the asset
  // name with a forward slash would mix separators in a path some tools reject.
  // The verify command also has to drop curl/awk/sha256sum for something a
  // stock Windows hub actually has.
  it('joins a Windows host path natively and emits a PowerShell verify command', () => {
    const winCacheDir = (version: string) => `C:\\Users\\dev\\.mango\\runtime-cache\\${version}`;
    const staged = stagedRuntimeAsset({
      version: '1.2.3',
      platformHint: 'linux-x64',
      cacheDir: winCacheDir,
      present: true,
      hostPlatform: 'win32',
    });

    expect(staged?.path).toBe(
      'C:\\Users\\dev\\.mango\\runtime-cache\\1.2.3\\mangostudio-runtime-1.2.3-linux-x64'
    );
    expect(staged?.verify).toContain('Get-FileHash');
    expect(staged?.verify).toContain('curl.exe');
    expect(staged?.verify).not.toContain('awk');
    expect(staged?.verify).not.toContain('sha256sum');
  });

  // A rolling tag republishes SHA256SUMS under the same name as newer builds
  // land, so a verify command fetched fresh checks today's build against
  // yesterday's cached bytes. A pinned digest — recorded next to the file at
  // download time — checks the file against itself instead, no network hop.
  it('checks the cached bytes against a pinned digest instead of re-fetching SHA256SUMS', () => {
    const staged = stagedRuntimeAsset({
      version: '1.2.3-canary.gabc1234',
      platformHint: 'linux-x64',
      cacheDir,
      present: true,
      pinnedDigest: 'deadbeef',
    });

    expect(staged?.verify).toBe(`echo "deadbeef  ${staged?.path}" | sha256sum -c -`);
    expect(staged?.verify).not.toContain('curl');
    expect(staged?.verify).not.toContain('SHA256SUMS');
  });

  it('checks a pinned digest with Get-FileHash on a Windows hub, no SHA256SUMS fetch', () => {
    const winCacheDir = (version: string) => `C:\\Users\\dev\\.mango\\runtime-cache\\${version}`;
    const staged = stagedRuntimeAsset({
      version: '1.2.3-canary.gabc1234',
      platformHint: 'linux-x64',
      cacheDir: winCacheDir,
      present: true,
      hostPlatform: 'win32',
      pinnedDigest: 'deadbeef',
    });

    expect(staged?.verify).toContain('Get-FileHash');
    expect(staged?.verify).toContain('"deadbeef"');
    expect(staged?.verify).not.toContain('curl.exe');
    expect(staged?.verify).not.toContain('SHA256SUMS');
  });

  // A guess is fine for a command somebody reads before running. It is not fine
  // for a path this card claims already holds verified bytes.
  it.each([
    ['a source checkout', 'dev', 'linux-x64'],
    ['an unknown platform', '1.2.3', undefined],
    ['an empty platform hint', '1.2.3', ''],
  ])('returns undefined for %s', (_label, version, platformHint) => {
    expect(stagedRuntimeAsset({ version, platformHint, cacheDir, present: false })).toBeUndefined();
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
    expect(manual?.serviceInstall).toBeUndefined();
  });

  it('uses the downloaded binary path for posix service install', () => {
    const manual = manualFor('linux-x64');
    expect(manual?.serviceInstall).toBe('./mangostudio-runtime service install --mode connect');
  });

  // A dial-in machine cannot be pushed to, so this one-liner is the whole
  // install story for it. On canary it pointed at `v<root>-canary.<sha7>` —
  // a tag no release publishes — and named an asset that does not exist, so
  // the only path onto those machines was a 404 the user had to debug.
  it('points the one-liner at the rolling tag and asset on canary', () => {
    process.env.VERSION = '9.9.9-canary.abcdef0';
    const manual = manualFor('linux-x64');
    const asset = 'mangostudio-runtime-9.9.9-canary-linux-x64';
    const tagUrl = 'https://github.com/juliopolycarpo/mangostudio/releases/download/v9.9.9-canary';

    expect(manual?.install).toContain(`${tagUrl}/${asset}`);
    expect(manual?.install).toContain(`${tagUrl}/SHA256SUMS`);
    expect(manual?.install).not.toContain('abcdef0');
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

  it('names the rolling asset for a canary version, exe suffix included', () => {
    expect(manualRuntimeReleaseAssetName('1.2.3-canary.abcdef0', 'linux-x64')).toBe(
      'mangostudio-runtime-1.2.3-canary-linux-x64'
    );
    expect(manualRuntimeReleaseAssetName('1.2.3-canary.abcdef0', 'win32-arm64')).toBe(
      'mangostudio-runtime-1.2.3-canary-windows-arm64.exe'
    );
  });
});
