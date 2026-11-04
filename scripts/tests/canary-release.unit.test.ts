import { describe, expect, test } from 'bun:test';

import {
  type CanaryReleaseClient,
  type CanaryReleaseExpectation,
  type CanaryReleaseResponse,
  verifyCanaryReleasePublication,
} from '../lib/canary-release';

const REPOSITORY = 'owner/repo';
const SOURCE = 'a'.repeat(40);
const VERSION = '1.2.3-canary.aaaaaaa';
const TAG = `v${VERSION}`;

class FakeGitHubRelease implements CanaryReleaseClient {
  readonly calls: string[] = [];
  readonly failures = new Map<string, Error>();
  release: CanaryReleaseResponse = {
    status: 200,
    body: {
      id: 17,
      tag_name: TAG,
      target_commitish: SOURCE,
      prerelease: true,
      draft: false,
      immutable: true,
      html_url: `https://github.com/${REPOSITORY}/releases/tag/${TAG}`,
      url: `https://api.github.com/repos/${REPOSITORY}/releases/17`,
    },
  };
  tag: CanaryReleaseResponse = { status: 200, body: SOURCE };
  assets: unknown = [
    {
      id: 31,
      name: 'binary.tar.gz',
      state: 'uploaded',
      size: 15,
      digest: `sha256:${'b'.repeat(64)}`,
    },
    {
      id: 32,
      name: 'checksums.tar.gz',
      state: 'uploaded',
      size: 7,
      digest: `sha256:${'c'.repeat(64)}`,
    },
    {
      id: 33,
      name: 'canary-manifest.json',
      state: 'uploaded',
      size: 9,
      digest: `sha256:${'d'.repeat(64)}`,
    },
  ];

  getRelease(tag: string): Promise<CanaryReleaseResponse> {
    this.record(`release:${tag}`);
    return Promise.resolve(this.release);
  }
  resolveTag(tag: string): Promise<CanaryReleaseResponse> {
    this.record(`tag:${tag}`);
    return Promise.resolve(this.tag);
  }
  listAssets(id: number): Promise<readonly unknown[]> {
    this.record(`assets:${id}`);
    return Promise.resolve(this.assets as readonly unknown[]);
  }
  private record(call: string): void {
    this.calls.push(call);
    const failure = this.failures.get(call);
    if (failure) throw failure;
  }
}

function fixture(): { expected: CanaryReleaseExpectation; github: FakeGitHubRelease } {
  return {
    expected: {
      repository: REPOSITORY,
      sourceSha: SOURCE,
      version: VERSION,
      assets: [
        { name: 'binary.tar.gz', size: 15, sha256: 'b'.repeat(64) },
        { name: 'checksums.tar.gz', size: 7, sha256: 'c'.repeat(64) },
        { name: 'canary-manifest.json', size: 9, sha256: 'd'.repeat(64) },
      ],
    },
    github: new FakeGitHubRelease(),
  };
}

function releaseRecord(github: FakeGitHubRelease): Record<string, unknown> {
  return github.release.body as Record<string, unknown>;
}
function assetRecords(github: FakeGitHubRelease): Record<string, unknown>[] {
  return github.assets as Record<string, unknown>[];
}

describe('canary GitHub publication integrity', () => {
  test('a public immutable release needs its exact source and complete asset digest set', async () => {
    const { expected, github } = fixture();
    const result = await verifyCanaryReleasePublication(expected, github);
    expect(result).toEqual({
      state: 'complete',
      releaseId: 17,
      present: expected.assets.map((asset) => asset.name),
      missing: [],
    });
    expect(github.calls).toEqual([`release:${TAG}`, `tag:${TAG}`, 'assets:17']);
  });
  test('resolved tag source is authoritative over historical target branch metadata', async () => {
    const { expected, github } = fixture();
    releaseRecord(github).target_commitish = 'main';
    expect((await verifyCanaryReleasePublication(expected, github)).state).toBe('complete');
  });
  test('an absent release verifies its existing tag source without reading assets', async () => {
    const { expected, github } = fixture();
    github.release = { status: 404, body: { message: 'Not Found' } };
    expect(await verifyCanaryReleasePublication(expected, github)).toEqual({
      state: 'absent',
      releaseId: null,
      present: [],
      missing: expected.assets,
    });
    expect(github.calls).toEqual([`release:${TAG}`, `tag:${TAG}`]);
  });
  test('an absent release rejects an existing tag for another source', async () => {
    const { expected, github } = fixture();
    github.release = { status: 404, body: {} };
    github.tag = { status: 200, body: 'b'.repeat(40) };
    await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
      `expected full source commit ${SOURCE}`
    );
    expect(github.calls).toEqual([`release:${TAG}`, `tag:${TAG}`]);
  });
  test('a new release can proceed when both release and tag are genuinely absent', async () => {
    const { expected, github } = fixture();
    github.release = { status: 404, body: {} };
    github.tag = { status: 404, body: {} };
    expect((await verifyCanaryReleasePublication(expected, github)).state).toBe('absent');
    expect(github.calls).toEqual([`release:${TAG}`, `tag:${TAG}`]);
  });
  test.each([401, 403, 429, 500])('an absent release does not hide tag HTTP%i', async (status) => {
    const { expected, github } = fixture();
    github.release = { status: 404, body: {} };
    github.tag = { status, body: {} };
    await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
      `expected HTTP 200; received ${status}`
    );
  });
  test('an absent release does not hide a tag transport error', async () => {
    const { expected, github } = fixture();
    github.release = { status: 404, body: {} };
    github.failures.set(`tag:${TAG}`, new Error('tag fixture disconnected'));
    await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
      'tag fixture disconnected'
    );
  });
  test('accepts the canonical git-prefixed numeric source version', async () => {
    const { expected, github } = fixture();
    github.release = { status: 404, body: {} };
    const numeric = {
      ...expected,
      sourceSha: `0123456${'a'.repeat(33)}`,
      version: '1.2.3-canary.g0123456',
    };
    github.tag = { status: 404, body: {} };
    expect((await verifyCanaryReleasePublication(numeric, github)).state).toBe('absent');
    expect(github.calls).toEqual(['release:v1.2.3-canary.g0123456', 'tag:v1.2.3-canary.g0123456']);
  });
  test.each([401, 403, 429, 500, 503])(
    'release HTTP%i fails instead of reporting absent',
    async (status) => {
      const { expected, github } = fixture();
      github.release = { status, body: { message: 'Not Found' } };
      await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
        `expected HTTP 200; received ${status}`
      );
    }
  );
  test.each(['release', 'tag', 'assets'])(
    'a failed %s request cannot become a no-op',
    async (operation) => {
      const { expected, github } = fixture();
      const call = operation === 'assets' ? 'assets:17' : `${operation}:${TAG}`;
      github.failures.set(call, new Error(`${operation} fixture network failure`));
      await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
        `${operation} fixture network failure`
      );
    }
  );
  test.each([200, 404])('recovers a real untagged draft URL with tag HTTP%i', async (status) => {
    const { expected, github } = fixture();
    Object.assign(releaseRecord(github), {
      draft: true,
      immutable: false,
      html_url: `https://github.com/${REPOSITORY}/releases/tag/untagged-ff5db9c82066f19c0ce6`,
    });
    github.tag = { status, body: status === 200 ? SOURCE : {} };
    github.assets = [];
    expect(await verifyCanaryReleasePublication(expected, github)).toEqual({
      state: 'draft',
      releaseId: 17,
      present: [],
      missing: expected.assets,
    });
  });
  test('an untagged URL never qualifies a public release', async () => {
    const { expected, github } = fixture();
    releaseRecord(github).html_url =
      `https://github.com/${REPOSITORY}/releases/tag/untagged-ff5db9c82066f19c0ce6`;
    await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
      'Invalid release'
    );
  });
  test.each([
    'https://github.com/other/repo/releases/tag/untagged-ff5db9c82066f19c0ce6',
    `https://github.com/${REPOSITORY}/releases/tag/untagged-`,
    `https://github.com/${REPOSITORY}/releases/tag/untagged-not-a-hash`,
    `https://github.com/${REPOSITORY}/releases/tag/untagged-ff5db9c82066f19c0ce6?redirect=other`,
  ])('rejects unproven draft URL %s', async (htmlUrl) => {
    const { expected, github } = fixture();
    Object.assign(releaseRecord(github), { draft: true, immutable: false, html_url: htmlUrl });
    await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
      'Invalid release'
    );
  });
  test('a matching draft subset returns only its missing assets without mutations', async () => {
    const { expected, github } = fixture();
    Object.assign(releaseRecord(github), { draft: true, immutable: false });
    github.assets = [assetRecords(github)[1]];
    expect(await verifyCanaryReleasePublication(expected, github)).toEqual({
      state: 'draft',
      releaseId: 17,
      present: ['checksums.tar.gz'],
      missing: [expected.assets[0], expected.assets[2]],
    });
  });
  test('a draft without a tag can recover only with an exact full target commit', async () => {
    const { expected, github } = fixture();
    Object.assign(releaseRecord(github), { draft: true, immutable: false });
    github.tag = { status: 404, body: { message: 'Not Found' } };
    github.assets = [];
    expect(await verifyCanaryReleasePublication(expected, github)).toEqual({
      state: 'draft',
      releaseId: 17,
      present: [],
      missing: expected.assets,
    });
  });
  test.each(['main', 'b'.repeat(40), 'aaaaaaa'])(
    'a tagless draft rejects unproven target %s',
    async (target) => {
      const { expected, github } = fixture();
      Object.assign(releaseRecord(github), {
        draft: true,
        immutable: false,
        target_commitish: target,
      });
      github.tag = { status: 404, body: {} };
      await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
        'expected exact full source target'
      );
      expect(github.calls).not.toContain('assets:17');
    }
  );
  test.each([401, 403, 429, 500])('a draft tag HTTP%i is not treated as absent', async (status) => {
    const { expected, github } = fixture();
    Object.assign(releaseRecord(github), { draft: true, immutable: false });
    github.tag = { status, body: {} };
    await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
      `expected HTTP 200; received ${status}`
    );
  });
  test('a public release without a resolved tag fails', async () => {
    const { expected, github } = fixture();
    github.tag = { status: 404, body: {} };
    await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
      'tag v1.2.3-canary.aaaaaaa: expected HTTP 200; received 404'
    );
  });
  test.each(['b'.repeat(40), 'aaaaaaa', 'main', null, { sha: SOURCE }])(
    'rejects wrong or unresolved source %j',
    async (body) => {
      const { expected, github } = fixture();
      github.tag = { status: 200, body };
      await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
        'expected full source commit'
      );
      expect(github.calls).not.toContain('assets:17');
    }
  );
  test.each([
    { tag_name: 'v1.2.3-canary.bbbbbbb' },
    { prerelease: false },
    { prerelease: 'true' },
    { draft: 'false' },
    { target_commitish: '' },
    { target_commitish: null },
    { html_url: 'https://github.com/wrong/repo/releases/tag/tag' },
    { url: 'https://api.github.com/repos/wrong/repo/releases/17' },
  ])('rejects inconsistent release metadata %j', async (mutation) => {
    const { expected, github } = fixture();
    Object.assign(releaseRecord(github), mutation);
    await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
      'Invalid release'
    );
    expect(github.calls).toEqual([`release:${TAG}`]);
  });
  test.each([false, null, 'true'])(
    'public completeness requires immutable=true, received %j',
    async (immutable) => {
      const { expected, github } = fixture();
      releaseRecord(github).immutable = immutable;
      await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
        'expected immutable=true'
      );
    }
  );
  test.each([null, [], 'release'].map((body) => [body]))(
    'rejects malformed release record %j',
    async (body) => {
      const { expected, github } = fixture();
      github.release = { status: 200, body };
      await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
        'expected object'
      );
    }
  );
  test.each([0, -1, 1.5, '17', null])('rejects invalid release ID %j', async (id) => {
    const { expected, github } = fixture();
    releaseRecord(github).id = id;
    await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
      'expected positive safe integer'
    );
  });
  test('a public partial release cannot become complete by accepting embedded asset names', async () => {
    const { expected, github } = fixture();
    releaseRecord(github).assets = github.assets;
    github.assets = assetRecords(github).slice(0, 1);
    await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
      'Incomplete immutable release v1.2.3-canary.aaaaaaa: missing checksums.tar.gz, canary-manifest.json; assets cannot be added after publication, publish the next version instead'
    );
  });
  test.each([true, false])('same-name changed bytes fail even for draft=%s', async (draft) => {
    const { expected, github } = fixture();
    releaseRecord(github).draft = draft;
    const asset = assetRecords(github)[0];
    if (!asset) throw new Error('Fixture lacks first asset');
    asset.digest = `sha256:${'e'.repeat(64)}`;
    await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
      'Published asset mismatch'
    );
  });
  test.each([{ size: 16 }, { digest: null }, { digest: 'b'.repeat(64) }, { state: 'starter' }])(
    'rejects asset integrity/state mismatch %j',
    async (mutation) => {
      const { expected, github } = fixture();
      const asset = assetRecords(github)[0];
      if (!asset) throw new Error('Fixture lacks first asset');
      Object.assign(asset, mutation);
      await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
        'Published asset mismatch'
      );
    }
  );
  test.each([null, {}, 'assets'].map((assets) => [assets]))(
    'rejects incomplete asset listing %j',
    async (assets) => {
      const { expected, github } = fixture();
      github.assets = assets;
      await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
        'expected complete array'
      );
    }
  );
  test.each(['duplicate-name', 'duplicate-id', 'unexpected-name'])(
    'rejects %s asset identities',
    async (mutation) => {
      const { expected, github } = fixture();
      const first = assetRecords(github)[0];
      const second = assetRecords(github)[1];
      if (!first || !second) throw new Error('Fixture lacks first two assets');
      if (mutation === 'duplicate-name') second.name = first.name;
      if (mutation === 'duplicate-id') second.id = first.id;
      if (mutation === 'unexpected-name') second.name = 'unapproved.tar.gz';
      await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
        'expected unique expected name and ID'
      );
    }
  );
  test.each([0, -1, '31', 1.5, null])('rejects invalid asset ID %j', async (id) => {
    const { expected, github } = fixture();
    const first = assetRecords(github)[0];
    if (!first) throw new Error('Fixture lacks first asset');
    first.id = id;
    await expect(verifyCanaryReleasePublication(expected, github)).rejects.toThrow(
      'expected positive safe integer'
    );
  });
  test.each([
    { repository: 'wrong' },
    { sourceSha: 'aaaaaaa' },
    { sourceSha: SOURCE.toUpperCase() },
    { version: 'v1.2.3-canary.aaaaaaa' },
    { version: '1.2.3-canary.bbbbbbb' },
    { assets: [] },
  ])('rejects invalid expected identity %j before I/O', async (mutation) => {
    const { expected, github } = fixture();
    await expect(
      verifyCanaryReleasePublication({ ...expected, ...mutation }, github)
    ).rejects.toThrow('Invalid expected canary release');
    expect(github.calls).toEqual([]);
  });
  test.each([
    { name: '../outside' },
    { name: 'bad\\name' },
    { name: 'bad\0name' },
    { name: '' },
    { name: '.' },
    { name: ' filename' },
    { size: -1 },
    { size: 1.5 },
    { size: Number.MAX_SAFE_INTEGER + 1 },
    { sha256: 'abc' },
    { sha256: 'B'.repeat(64) },
  ])('rejects invalid expected asset %j before I/O', async (mutation) => {
    const { expected, github } = fixture();
    const first = expected.assets[0];
    if (!first) throw new Error('Fixture lacks expected asset');
    await expect(
      verifyCanaryReleasePublication({ ...expected, assets: [{ ...first, ...mutation }] }, github)
    ).rejects.toThrow('Invalid expected release asset');
    expect(github.calls).toEqual([]);
  });
  test('rejects duplicate expected names before I/O', async () => {
    const { expected, github } = fixture();
    await expect(
      verifyCanaryReleasePublication(
        { ...expected, assets: [...expected.assets, ...expected.assets] },
        github
      )
    ).rejects.toThrow('Invalid expected release asset');
    expect(github.calls).toEqual([]);
  });
});
