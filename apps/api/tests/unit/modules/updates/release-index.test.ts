import { describe, expect, it } from 'bun:test';
import {
  fetchCanaryManifestForTag,
  fetchReleaseChecksums,
  resolveCanaryRollingVersion,
  resolveStableLatestVersion,
} from '../../../../src/modules/updates/infrastructure/release-index';
import { FakeReleaseHost } from './support/fake-release-host';

describe('resolveStableLatestVersion', () => {
  it('reads the tag off the redirect chain the release page resolves through', async () => {
    // A FakeReleaseHost Response never carries `.url` the way a real fetch
    // response does, so `safeFetchBytes` falls back to the URL of the hop
    // that answered — which is exactly the tag page here, the same value a
    // real browser or curl would land on.
    const host = new FakeReleaseHost({
      'https://github.com/juliopolycarpo/mangostudio/releases/latest': {
        redirectTo: 'https://github.com/juliopolycarpo/mangostudio/releases/tag/v1.4.0',
      },
      'https://github.com/juliopolycarpo/mangostudio/releases/tag/v1.4.0': {
        body: '<html>whatever the release page renders</html>',
      },
    });

    const version = await resolveStableLatestVersion({
      fetch: host.fetch,
      resolveHostname: host.resolveHostname,
    });

    expect(version).toBe('1.4.0');
  });

  it('fails clearly when the redirect target names no tag', async () => {
    const host = new FakeReleaseHost({
      'https://github.com/juliopolycarpo/mangostudio/releases/latest': { body: 'no releases yet' },
    });

    await expect(
      resolveStableLatestVersion({ fetch: host.fetch, resolveHostname: host.resolveHostname })
    ).rejects.toThrow('Could not read a release tag');
  });
});

describe('resolveCanaryRollingVersion', () => {
  it('finds the first pre-release whose tag is the rolling canary shape', async () => {
    const host = new FakeReleaseHost({
      'https://api.github.com/repos/juliopolycarpo/mangostudio/releases?per_page=30': {
        body: JSON.stringify([
          { tag_name: 'v1.4.0', prerelease: false },
          { tag_name: 'v1.3.9-canary.abc1234', prerelease: true },
          { tag_name: 'v1.4.0-canary', prerelease: true },
        ]),
      },
    });

    const version = await resolveCanaryRollingVersion({
      fetch: host.fetch,
      resolveHostname: host.resolveHostname,
    });

    expect(version).toBe('1.4.0-canary');
  });

  it('fails clearly when no rolling canary pre-release is published', async () => {
    const host = new FakeReleaseHost({
      'https://api.github.com/repos/juliopolycarpo/mangostudio/releases?per_page=30': {
        body: JSON.stringify([{ tag_name: 'v1.4.0', prerelease: false }]),
      },
    });

    await expect(
      resolveCanaryRollingVersion({ fetch: host.fetch, resolveHostname: host.resolveHostname })
    ).rejects.toThrow('No rolling canary pre-release');
  });
});

describe('fetchCanaryManifestForTag', () => {
  const MANIFEST = JSON.stringify({
    schemaVersion: 1,
    channel: 'canary',
    version: '1.4.0-canary.abc1234f',
    assetVersion: '1.4.0-canary',
    sourceSha: 'abc1234fabc1234fabc1234fabc1234fabc1234f',
    builtAt: '2026-01-01T00:00:00.000Z',
    pairs: [],
  });

  it('parses the manifest when the tag publishes one', async () => {
    const host = new FakeReleaseHost({
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.4.0-canary/canary-manifest.json':
        { body: MANIFEST },
    });

    const manifest = await fetchCanaryManifestForTag(
      { fetch: host.fetch, resolveHostname: host.resolveHostname },
      '1.4.0-canary'
    );

    expect(manifest?.version).toBe('1.4.0-canary.abc1234f');
    expect(manifest?.sourceSha).toBe('abc1234fabc1234fabc1234fabc1234fabc1234f');
  });

  it('tolerates a tag cut before the manifest existed, returning null rather than throwing', async () => {
    const host = new FakeReleaseHost({
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.4.0-canary/canary-manifest.json':
        { status: 404, body: 'Not Found' },
    });

    const manifest = await fetchCanaryManifestForTag(
      { fetch: host.fetch, resolveHostname: host.resolveHostname },
      '1.4.0-canary'
    );

    expect(manifest).toBeNull();
  });
});

describe('fetchReleaseChecksums', () => {
  it('fetches a resolved target checksumsUrl verbatim', async () => {
    const checksumsUrl =
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.4.0/SHA256SUMS';
    const host = new FakeReleaseHost({
      [checksumsUrl]: { body: 'deadbeef  mangostudio-1.4.0-linux-x64.tar.gz\n' },
    });

    const checksums = await fetchReleaseChecksums(
      { fetch: host.fetch, resolveHostname: host.resolveHostname },
      checksumsUrl
    );

    expect(checksums).toContain('mangostudio-1.4.0-linux-x64.tar.gz');
  });
});

describe('lookup deadlines', () => {
  it('arms an abort signal on every release-host lookup', async () => {
    // Without a deadline a stalled socket hangs the upgrade indefinitely,
    // holding the engine's `running` flag and machine-service's
    // `upgradeInFlight` until the hub restarts.
    const host = new FakeReleaseHost({
      'https://github.com/juliopolycarpo/mangostudio/releases/latest': {
        redirectTo: 'https://github.com/juliopolycarpo/mangostudio/releases/tag/v1.4.0',
      },
      'https://github.com/juliopolycarpo/mangostudio/releases/tag/v1.4.0': {
        body: '<html></html>',
      },
    });

    await resolveStableLatestVersion({ fetch: host.fetch, resolveHostname: host.resolveHostname });

    expect(host.signals).not.toHaveLength(0);
    for (const signal of host.signals) expect(signal).toBeInstanceOf(AbortSignal);
  });
});
