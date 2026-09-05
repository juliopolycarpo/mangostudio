import { describe, expect, it } from 'bun:test';
import {
  isAlreadyCurrent,
  resolveUpgradeTarget,
  type UpgradeTargetRefusal,
} from '../../../../src/modules/updates/domain/resolve-target';
import { FakeReleaseHost } from './support/fake-release-host';

const GITHUB = 'https://github.com/juliopolycarpo/mangostudio';
const GITHUB_API = 'https://api.github.com/repos/juliopolycarpo/mangostudio';

describe('resolveUpgradeTarget — stable', () => {
  it('builds the pinned asset, url and SHA256SUMS location for a Windows arm64 target', async () => {
    const host = new FakeReleaseHost({});

    const target = await resolveUpgradeTarget(
      { channel: 'stable', version: '2.0.0' },
      { platformId: 'windows-arm64', currentVersion: '1.0.0' },
      { fetch: host.fetch, resolveHostname: host.resolveHostname }
    );

    expect(target).toEqual({
      channel: 'stable',
      version: '2.0.0',
      assetName: 'mangostudio-2.0.0-windows-arm64.zip',
      url: `${GITHUB}/releases/download/v2.0.0/mangostudio-2.0.0-windows-arm64.zip`,
      kind: 'archive',
      verification: 'sha256-sums',
      checksumsUrl: `${GITHUB}/releases/download/v2.0.0/SHA256SUMS`,
    });
    // No network needed at all for a pinned stable version.
    expect(host.calls).toEqual([]);
  });

  it('resolves the latest tag when no version is pinned', async () => {
    const host = new FakeReleaseHost({
      [`${GITHUB}/releases/latest`]: { redirectTo: `${GITHUB}/releases/tag/v3.1.4` },
      [`${GITHUB}/releases/tag/v3.1.4`]: { body: '<html></html>' },
    });

    const target = await resolveUpgradeTarget(
      { channel: 'stable' },
      { platformId: 'linux-x64', currentVersion: '3.1.3' },
      { fetch: host.fetch, resolveHostname: host.resolveHostname }
    );

    expect(target).toMatchObject({ channel: 'stable', version: '3.1.4', kind: 'archive' });
  });

  it('strips a leading v from a pinned version, the way install.sh normalizes one', async () => {
    const host = new FakeReleaseHost({});

    const target = await resolveUpgradeTarget(
      { channel: 'stable', version: 'v2.0.0' },
      { platformId: 'linux-x64', currentVersion: '1.0.0' },
      { fetch: host.fetch, resolveHostname: host.resolveHostname }
    );

    expect(target).toMatchObject({
      version: '2.0.0',
      url: `${GITHUB}/releases/download/v2.0.0/mangostudio-2.0.0-linux-x64.tar.gz`,
    });
  });
});

describe('resolveUpgradeTarget — canary latest', () => {
  it('reads the rolling tag directly from the current canary version, no network for the tag itself', async () => {
    const manifest = JSON.stringify({
      schemaVersion: 1,
      channel: 'canary',
      version: '0.2.0-canary.def5678a',
      assetVersion: '0.2.0-canary',
      sourceSha: 'def5678adef5678adef5678adef5678adef5678a',
      builtAt: '2026-01-01T00:00:00.000Z',
      pairs: [],
    });
    const host = new FakeReleaseHost({
      [`${GITHUB}/releases/download/v0.2.0-canary/canary-manifest.json`]: { body: manifest },
    });

    const target = await resolveUpgradeTarget(
      { channel: 'canary' },
      { platformId: 'linux-x64', currentVersion: '0.2.0-canary.abc1234f' },
      { fetch: host.fetch, resolveHostname: host.resolveHostname }
    );

    expect(target).toEqual({
      channel: 'canary',
      version: '0.2.0-canary.def5678a',
      sourceSha: 'def5678adef5678adef5678adef5678adef5678a',
      assetName: 'mangostudio-0.2.0-canary-linux-x64.tar.gz',
      url: `${GITHUB}/releases/download/v0.2.0-canary/mangostudio-0.2.0-canary-linux-x64.tar.gz`,
      kind: 'archive',
      verification: 'sha256-sums',
      checksumsUrl: `${GITHUB}/releases/download/v0.2.0-canary/SHA256SUMS`,
    });
    expect(host.calls).toEqual([`${GITHUB}/releases/download/v0.2.0-canary/canary-manifest.json`]);
  });

  it('lists releases to find the rolling tag when the current build is stable', async () => {
    const host = new FakeReleaseHost({
      [`${GITHUB_API}/releases?per_page=30`]: {
        body: JSON.stringify([
          { tag_name: 'v1.0.0', prerelease: false },
          { tag_name: 'v1.1.0-canary', prerelease: true },
        ]),
      },
      [`${GITHUB}/releases/download/v1.1.0-canary/canary-manifest.json`]: { status: 404, body: '' },
    });

    const target = await resolveUpgradeTarget(
      { channel: 'canary' },
      { platformId: 'darwin-arm64', currentVersion: '1.0.0' },
      { fetch: host.fetch, resolveHostname: host.resolveHostname }
    );

    // No manifest published for this tag: falls back to the tag version and no sourceSha.
    expect(target).toMatchObject({
      channel: 'canary',
      version: '1.1.0-canary',
      assetName: 'mangostudio-1.1.0-canary-darwin-arm64.tar.gz',
    });
    expect((target as { sourceSha?: string }).sourceSha).toBeUndefined();
  });
});

describe('resolveUpgradeTarget — canary <sha>', () => {
  const PACKUMENT = JSON.stringify({
    name: '@mangostudio/cli-linux-x64',
    versions: {
      '0.1.1-canary.g0123456': {
        dist: {
          tarball:
            'https://registry.npmjs.org/@mangostudio/cli-linux-x64/-/cli-linux-x64-0.1.1.tgz',
          integrity: 'sha512-AA==',
        },
      },
    },
  });

  it('resolves an npm tarball target verified by dist.integrity', async () => {
    const host = new FakeReleaseHost({
      'https://registry.npmjs.org/@mangostudio%2Fcli-linux-x64': { body: PACKUMENT },
    });

    const target = await resolveUpgradeTarget(
      { channel: 'canary', sha: '0123456' },
      { platformId: 'linux-x64', currentVersion: '0.1.0' },
      { fetch: host.fetch, resolveHostname: host.resolveHostname }
    );

    expect(target).toEqual({
      channel: 'canary',
      version: '0.1.1-canary.g0123456',
      sourceSha: '0123456',
      assetName: 'cli-linux-x64-0.1.1.tgz',
      url: 'https://registry.npmjs.org/@mangostudio/cli-linux-x64/-/cli-linux-x64-0.1.1.tgz',
      kind: 'npm-tarball',
      verification: 'npm-integrity',
      expectedDigest: { algorithm: 'sha512', hex: '00' },
    });
  });

  it('refuses a musl target, naming the two alternatives', async () => {
    const host = new FakeReleaseHost({});

    const target = (await resolveUpgradeTarget(
      { channel: 'canary', sha: '0123456' },
      { platformId: 'linux-x64-musl', currentVersion: '0.1.0' },
      { fetch: host.fetch, resolveHostname: host.resolveHostname }
    )) as UpgradeTargetRefusal;

    expect(target.reason).toBe('unsupported-target');
    expect(target.message).toContain('--canary');
    expect(target.message).toContain('shell installer');
    expect(host.calls).toEqual([]);
  });

  it('fails clearly when no published version matches the sha', async () => {
    const host = new FakeReleaseHost({
      'https://registry.npmjs.org/@mangostudio%2Fcli-linux-x64': { body: PACKUMENT },
    });

    await expect(
      resolveUpgradeTarget(
        { channel: 'canary', sha: 'deadbee' },
        { platformId: 'linux-x64', currentVersion: '0.1.0' },
        { fetch: host.fetch, resolveHostname: host.resolveHostname }
      )
    ).rejects.toThrow('deadbee');
  });
});

describe('isAlreadyCurrent', () => {
  it('stable: never calls a malformed target version current', () => {
    // A path-shaped "version" parsed as 0.0.0 read as older than everything and
    // was waved through as up to date, so the engine's containment check
    // downstream never ran.
    expect(
      isAlreadyCurrent({ channel: 'stable', version: '../../../../../evil' } as never, {
        currentVersion: '0.1.1',
      })
    ).toBe(false);
  });

  it('stable: compares versions exactly', () => {
    expect(
      isAlreadyCurrent({ channel: 'stable', version: '1.0.0' } as never, {
        currentVersion: '1.0.0',
      })
    ).toBe(true);
    expect(
      isAlreadyCurrent({ channel: 'stable', version: '1.0.1' } as never, {
        currentVersion: '1.0.0',
      })
    ).toBe(false);
  });

  it('stable, unpinned: an older "latest" (a yanked release) reads as already current', () => {
    // Nothing pinned this to 1.0.4 — it is just what the release index says
    // is latest, and it has fallen behind 1.0.5 because 1.0.5 was pulled.
    // Reporting "already current" (not "downgrade available") is what keeps
    // `runSelf` from installing it.
    expect(
      isAlreadyCurrent({ channel: 'stable', version: '1.0.4' } as never, {
        currentVersion: '1.0.5',
      })
    ).toBe(true);
  });

  it('stable, pinned: an explicit older version is a deliberate downgrade, not "already current"', () => {
    expect(
      isAlreadyCurrent({ channel: 'stable', version: '1.0.4' } as never, {
        currentVersion: '1.0.5',
        pinned: true,
      })
    ).toBe(false);
  });

  it('canary: matches on a shared 7+ char source sha prefix', () => {
    const target = {
      channel: 'canary',
      version: '0.2.0-canary.abc1234f',
      sourceSha: 'abc1234fdeadbeef',
    } as never;
    expect(
      isAlreadyCurrent(target, { currentVersion: '0.2.0-canary.other', buildSha: 'abc1234fbeef' })
    ).toBe(true);
    expect(
      isAlreadyCurrent(target, { currentVersion: '0.2.0-canary.other', buildSha: 'deadbeef' })
    ).toBe(false);
  });

  it('canary: matches when the full version strings are identical, even without a sha', () => {
    const target = { channel: 'canary', version: '0.2.0-canary.abc1234f' } as never;
    expect(isAlreadyCurrent(target, { currentVersion: '0.2.0-canary.abc1234f' })).toBe(true);
  });
});
