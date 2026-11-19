import { describe, expect, it } from 'bun:test';

import {
  fetchCanaryManifestForTag,
  fetchReleaseChecksums,
  githubApiCredentials,
  resolveLatestCanaryVersion,
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

describe('resolveLatestCanaryVersion', () => {
  const listing = (tags: readonly { tag_name: string; prerelease: boolean }[]) =>
    new FakeReleaseHost({
      'https://api.github.com/repos/juliopolycarpo/mangostudio/releases?per_page=30': {
        body: JSON.stringify(tags),
      },
    });

  it('takes the first canary pre-release, which is the newest GitHub listed', async () => {
    const host = listing([
      { tag_name: 'v1.4.0', prerelease: false },
      { tag_name: 'v1.4.1-canary.abc1234', prerelease: true },
      { tag_name: 'v1.4.1-canary.9999999', prerelease: true },
    ]);

    const version = await resolveLatestCanaryVersion({
      fetch: host.fetch,
      resolveHostname: host.resolveHostname,
    });

    expect(version).toBe('1.4.1-canary.abc1234');
  });

  it('accepts a git-describe style sha identifier', async () => {
    const host = listing([{ tag_name: 'v1.4.1-canary.g0123456', prerelease: true }]);

    const version = await resolveLatestCanaryVersion({
      fetch: host.fetch,
      resolveHostname: host.resolveHostname,
    });

    expect(version).toBe('1.4.1-canary.g0123456');
  });

  it('resolves a full retention window with release notes and 19 assets per release', async () => {
    const repository = 'https://api.github.com/repos/juliopolycarpo/mangostudio';
    const releases = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      tag_name: `v1.4.1-canary.abc${index.toString(16).padStart(4, '0')}`,
      name: `Canary build ${index}`,
      prerelease: true,
      draft: false,
      immutable: true,
      target_commitish: 'a'.repeat(40),
      created_at: '2026-09-16T00:00:00Z',
      published_at: '2026-09-16T00:00:00Z',
      url: `${repository}/releases/${index + 1}`,
      body: 'Release notes describing changes and installation instructions.\n'.repeat(400),
      assets: Array.from({ length: 19 }, (_, asset) => ({
        id: index * 19 + asset,
        node_id: `RA_fixture_${index}_${asset}`,
        name: `mangostudio-1.4.1-canary.abc${index.toString(16).padStart(4, '0')}-target-${asset}.tar.gz`,
        label: '',
        state: 'uploaded',
        content_type: 'application/gzip',
        size: 80_000_000,
        download_count: 1,
        digest: `sha256:${'a'.repeat(64)}`,
        created_at: '2026-09-16T00:00:00Z',
        updated_at: '2026-09-16T00:00:00Z',
        url: `${repository}/releases/assets/${index * 19 + asset}`,
        browser_download_url: `https://github.com/juliopolycarpo/mangostudio/releases/download/v1.4.1-canary.abc${index.toString(16).padStart(4, '0')}/target-${asset}.tar.gz`,
        uploader: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
      })),
    }));
    // The retained 14 builds alone must exceed the old cap. Also exercise a
    // full 30-entry response, including releases awaiting the next prune.
    expect(Buffer.byteLength(JSON.stringify(releases.slice(0, 14)))).toBeGreaterThan(512 * 1024);
    const host = listing(releases);
    const version = await resolveLatestCanaryVersion({
      fetch: host.fetch,
      resolveHostname: host.resolveHostname,
    });
    expect(version).toBe('1.4.1-canary.abc0000');
  });

  it('keeps the release response bounded', async () => {
    const host = new FakeReleaseHost({
      'https://api.github.com/repos/juliopolycarpo/mangostudio/releases?per_page=30': {
        body: ' '.repeat(4 * 1024 * 1024 + 1),
      },
    });
    await expect(
      resolveLatestCanaryVersion({ fetch: host.fetch, resolveHostname: host.resolveHostname })
    ).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('still resolves the frozen rolling tag, which carries no sha', async () => {
    const host = listing([
      { tag_name: 'v1.4.0', prerelease: false },
      { tag_name: 'v1.4.0-canary', prerelease: true },
    ]);

    const version = await resolveLatestCanaryVersion({
      fetch: host.fetch,
      resolveHostname: host.resolveHostname,
    });

    expect(version).toBe('1.4.0-canary');
  });

  it('fails clearly when no canary pre-release is published', async () => {
    const host = listing([{ tag_name: 'v1.4.0', prerelease: false }]);

    await expect(
      resolveLatestCanaryVersion({ fetch: host.fetch, resolveHostname: host.resolveHostname })
    ).rejects.toThrow('No canary pre-release');
  });

  describe('with a GitHub token', () => {
    const DUMMY_TOKEN = 'dummy-token-not-a-secret';
    const releasesUrl =
      'https://api.github.com/repos/juliopolycarpo/mangostudio/releases?per_page=30';
    const body = JSON.stringify([{ tag_name: 'v1.4.1-canary.abc1234', prerelease: true }]);

    it('sends it as a bearer credential to api.github.com', async () => {
      const host = new FakeReleaseHost({ [releasesUrl]: { body } });

      await resolveLatestCanaryVersion(
        { fetch: host.fetch, resolveHostname: host.resolveHostname },
        DUMMY_TOKEN
      );

      expect(host.authorizations()).toEqual([`Bearer ${DUMMY_TOKEN}`]);
    });

    it('stays anonymous without one', async () => {
      const host = new FakeReleaseHost({ [releasesUrl]: { body } });

      await resolveLatestCanaryVersion({
        fetch: host.fetch,
        resolveHostname: host.resolveHostname,
      });

      expect(host.authorizations()).toEqual([undefined]);
    });

    it('drops it on a redirect to another host', async () => {
      const cdnUrl = 'https://objects.githubusercontent.com/releases/list.json';
      const host = new FakeReleaseHost({
        [releasesUrl]: { redirectTo: cdnUrl },
        [cdnUrl]: { body },
      });

      await resolveLatestCanaryVersion(
        { fetch: host.fetch, resolveHostname: host.resolveHostname },
        DUMMY_TOKEN
      );

      expect(host.calls).toEqual([releasesUrl, cdnUrl]);
      expect(host.authorizations()).toEqual([`Bearer ${DUMMY_TOKEN}`, undefined]);
    });

    it('never puts the token in an error message', async () => {
      const host = new FakeReleaseHost({ [releasesUrl]: { status: 403, body: 'rate limited' } });

      const failure = await resolveLatestCanaryVersion(
        { fetch: host.fetch, resolveHostname: host.resolveHostname },
        DUMMY_TOKEN
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain(DUMMY_TOKEN);
    });
  });
});

describe('githubApiCredentials', () => {
  it('scopes the bearer header to api.github.com', () => {
    expect(githubApiCredentials('dummy-token-not-a-secret')).toEqual({
      credentialsForHost: {
        host: 'api.github.com',
        headers: { Authorization: 'Bearer dummy-token-not-a-secret' },
      },
    });
  });

  it('is empty without a token', () => {
    expect(githubApiCredentials(undefined)).toEqual({});
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
