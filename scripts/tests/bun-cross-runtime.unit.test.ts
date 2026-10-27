/**
 * The runtime fetched for a cross-compile is executed to read its revision and
 * copied into every shipped binary, so its integrity check is load-bearing.
 *
 * These run against a local server rather than the real release host: the
 * branches worth having — a corrupted body, a channel tag that advanced between
 * the listing and the download, a listing that omits the asset — cannot be
 * reached through GitHub, and a test that needs the network is a test that stops
 * running the day the network is unavailable.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUN_RUNTIME_ASSETS,
  clearBunCrossRuntimeCache,
  downloadVerifiedAsset,
  ensureBunCrossRuntime,
  hostReleasePlatform,
} from '../lib/bun-cross-runtime';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';

const CHANNEL = 'canary';
const ASSET = 'bun-linux-x64';
const METADATA_BASE = 'https://api.github.com/repos/oven-sh/bun/releases/tags';
const DOWNLOAD_BASE = 'https://github.com/oven-sh/bun/releases/download';

/** Intercepts the trusted metadata endpoint while forwarding only to the local release fake. */
class FakeGitHubMetadata {
  readonly requests: Array<{
    url: string;
    authorization: string | null;
    redirect: RequestInit['redirect'];
  }> = [];
  private readonly fetchLocal = globalThis.fetch;

  constructor(
    private readonly localBase: string,
    private readonly respond: (init?: RequestInit) => Response | Promise<Response>
  ) {}

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${METADATA_BASE}/${CHANNEL}`) {
      this.requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
        redirect: init?.redirect,
      });
      return await this.respond(init);
    }
    if (url.startsWith(`${DOWNLOAD_BASE}/`)) {
      return await this.fetchLocal(`${this.localBase}${url.slice(DOWNLOAD_BASE.length)}`, init);
    }
    if (!url.startsWith(`${this.localBase}/`))
      throw new Error(`unexpected network request: ${url}`);
    return await this.fetchLocal(input, init);
  }
}

/** Replace fetch with the named fake while preserving Bun's fetch type. */
function spyOnGitHubMetadata(fake: FakeGitHubMetadata) {
  return spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(fake.fetch.bind(fake), { preconnect: globalThis.fetch.preconnect })
  );
}

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

/**
 * One line of a SHASUMS256.txt, plus a decoy for another asset so the parser has
 * to match on the name rather than take the first digest it sees.
 *
 * `marker` is the `*` some digest tools write before a name to mean binary mode;
 * Bun's listing does not use it today, and the parser tolerates it either way.
 */
function listingFor(digest: string, name = `${ASSET}.zip`, marker = ''): string {
  return `${'0'.repeat(64)}  bun-darwin-aarch64.zip\n${digest}  ${marker}${name}\n`;
}

/**
 * A request that is accepted and then never answered — the shape a stalled
 * release host takes, and the only thing the two timeouts exist to bound.
 */
const STALL = Symbol('stall');

/** A response body, a status code to fail the request with, or a stall. */
type Reply = string | number | typeof STALL;

function reply(value: Reply): Response | Promise<Response> {
  if (value === STALL) {
    // Never resolved: the connection is accepted and the reply never comes.
    return new Promise<Response>(() => {
      // no settle
    });
  }
  return typeof value === 'number'
    ? new Response('not found', { status: value })
    : new Response(value);
}

function startFakeRelease(handlers: {
  /** Called with the 1-based request count, so a test can move the tag. */
  listing: (call: number) => Reply;
  body: () => Reply;
  metadata?: () => Reply;
  asset?: string;
}) {
  let listingCalls = 0;
  const authorizations: Array<string | null> = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      authorizations.push(request.headers.get('authorization'));
      const { pathname } = new URL(request.url);
      if (pathname === `/${CHANNEL}/SHASUMS256.txt`) {
        listingCalls += 1;
        return reply(handlers.listing(listingCalls));
      }
      if (pathname === `/api/${CHANNEL}`) return reply(handlers.metadata?.() ?? 404);
      if (pathname === `/${CHANNEL}/${handlers.asset ?? ASSET}.zip`) {
        return reply(handlers.body());
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    base: `http://localhost:${server.port}`,
    authorizations,
    get listingCalls() {
      return listingCalls;
    },
    stop: () => server.stop(true),
  };
}

let tempDir: string;
let archivePath: string;
let running: { stop: () => void } | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'bun-cross-runtime-'));
  archivePath = join(tempDir, `${ASSET}.zip`);
});

afterEach(() => {
  running?.stop();
  running = null;
  rmSync(tempDir, { recursive: true, force: true });
});

function serve(handlers: Parameters<typeof startFakeRelease>[0]) {
  const server = startFakeRelease(handlers);
  running = server;
  return server;
}

describe('downloadVerifiedAsset', () => {
  test('uses authenticated metadata without sending credentials to release assets', async () => {
    const body = 'new-canary-bytes';
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => body });
    const metadata = new FakeGitHubMetadata(server.base, () =>
      Response.json({ assets: [{ name: `${ASSET}.zip`, digest: `sha256:${sha256(body)}` }] })
    );
    const fetchSpy = spyOnGitHubMetadata(metadata);
    try {
      const result = await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
        metadataBase: METADATA_BASE,
        githubToken: 'test-github-token',
      });
      expect(result.sha256).toBe(sha256(body));
      expect(metadata.requests).toEqual([
        {
          url: `${METADATA_BASE}/${CHANNEL}`,
          authorization: 'Bearer test-github-token',
          redirect: 'error',
        },
      ]);
      expect(server.authorizations).toEqual([null, null, null]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('keeps custom metadata endpoints anonymous even when a token is supplied', async () => {
    const body = 'new-canary-bytes';
    const server = serve({
      listing: () => listingFor(sha256('old')),
      body: () => body,
      metadata: () =>
        JSON.stringify({ assets: [{ name: `${ASSET}.zip`, digest: `sha256:${sha256(body)}` }] }),
    });
    const result = await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
      metadataBase: `${server.base}/api`,
      githubToken: 'test-github-token',
    });
    expect(result.sha256).toBe(sha256(body));
    expect(server.authorizations).toEqual([null, null, null, null]);
  });

  test('leaves official metadata anonymous when no token is supplied', async () => {
    const body = 'new-canary-bytes';
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => body });
    const metadata = new FakeGitHubMetadata(server.base, () =>
      Response.json({ assets: [{ name: `${ASSET}.zip`, digest: `sha256:${sha256(body)}` }] })
    );
    const fetchSpy = spyOnGitHubMetadata(metadata);
    try {
      await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
        metadataBase: METADATA_BASE,
      });
      expect(metadata.requests).toEqual([
        { url: `${METADATA_BASE}/${CHANNEL}`, authorization: null, redirect: undefined },
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('shares an in-flight metadata response only between matching credentials', async () => {
    const body = 'new-canary-bytes';
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => body });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const metadata = new FakeGitHubMetadata(server.base, async () => {
      await gate;
      return Response.json({
        assets: [{ name: `${ASSET}.zip`, digest: `sha256:${sha256(body)}` }],
      });
    });
    const fetchSpy = spyOnGitHubMetadata(metadata);
    const options = { metadataBase: METADATA_BASE };
    const downloads = [
      downloadVerifiedAsset(ASSET, CHANNEL, join(tempDir, 'one.zip'), server.base, {
        ...options,
        githubToken: 'first-token',
      }),
      downloadVerifiedAsset(ASSET, CHANNEL, join(tempDir, 'two.zip'), server.base, {
        ...options,
        githubToken: 'first-token',
      }),
      downloadVerifiedAsset(ASSET, CHANNEL, join(tempDir, 'three.zip'), server.base, {
        ...options,
        githubToken: 'second-token',
      }),
      downloadVerifiedAsset(ASSET, CHANNEL, join(tempDir, 'four.zip'), server.base, options),
    ];
    try {
      const deadline = Date.now() + 3000;
      while ((metadata.requests.length < 3 || server.listingCalls < 8) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      // Let the second same-token caller consume its already-served checksum.
      await Bun.sleep(20);
      expect(metadata.requests.map((request) => request.authorization).sort()).toEqual(
        [null, 'Bearer first-token', 'Bearer second-token'].sort()
      );
      release();
      expect((await Promise.all(downloads)).map((result) => result.sha256)).toEqual(
        Array(4).fill(sha256(body))
      );
    } finally {
      release();
      await Promise.allSettled(downloads);
      fetchSpy.mockRestore();
    }
  });

  test('does not include a reflected credential or unsafe header in a refusal', async () => {
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => 'body' });
    const metadata = new FakeGitHubMetadata(
      server.base,
      () =>
        new Response('test-github-token', {
          status: 403,
          statusText: 'refused test-github-token',
          headers: {
            'x-ratelimit-remaining': 'test-github-token',
            'x-github-request-id': 'test-github-token',
          },
        })
    );
    const fetchSpy = spyOnGitHubMetadata(metadata);
    try {
      const failure = await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
        metadataBase: METADATA_BASE,
        githubToken: 'test-github-token',
      }).then(
        () => null,
        (caught: unknown) => caught
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('403 Forbidden');
      expect((failure as Error).message).not.toContain('test-github-token');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('redacts the credential when the metadata fetch itself fails', async () => {
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => 'body' });
    const metadata = new FakeGitHubMetadata(server.base, () => {
      throw new Error('metadata transport refused test-github-token');
    });
    const fetchSpy = spyOnGitHubMetadata(metadata);
    try {
      const failure = await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
        metadataBase: METADATA_BASE,
        githubToken: 'test-github-token',
      }).then(
        () => null,
        (caught: unknown) => caught
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('Release metadata request failed');
      expect((failure as Error).message).not.toContain('test-github-token');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('does not expose a partial credential from transport errors or status text', async () => {
    const token = 'ghs_abcdefghijklmnopqrstuvwxyz0123456789';
    const fragment = token.slice(0, 20);
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => 'body' });
    const metadata = new FakeGitHubMetadata(server.base, () => {
      throw new Error(`transport failed ${fragment}`);
    });
    const fetchSpy = spyOnGitHubMetadata(metadata);
    try {
      const failure = await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
        metadataBase: METADATA_BASE,
        githubToken: token,
      }).then(
        () => null,
        (caught: unknown) => caught
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('Release metadata request failed');
      expect((failure as Error).message).not.toContain(fragment);
      expect((failure as Error).cause).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
    const reflected = new FakeGitHubMetadata(
      server.base,
      () =>
        new Response('', {
          status: 403,
          statusText: fragment,
        })
    );
    const statusSpy = spyOnGitHubMetadata(reflected);
    try {
      const failure = await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
        metadataBase: METADATA_BASE,
        githubToken: token,
      }).then(
        () => null,
        (caught: unknown) => caught
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('403 Forbidden');
      expect((failure as Error).message).not.toContain(fragment);
      expect((failure as Error).cause).toBeUndefined();
    } finally {
      statusSpy.mockRestore();
    }
  });

  test('redacts a credential included in an overridden metadata URL', async () => {
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => 'body' });
    const failure = await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
      metadataBase: `${server.base}/api/test-github-token`,
      githubToken: 'test-github-token',
    }).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('[redacted]');
    expect((failure as Error).message).not.toContain('test-github-token');
    expect(server.authorizations).toEqual([null, null, null, null]);
  });

  test('does not expose a credential fragment in an overridden metadata URL', async () => {
    const token = 'ghs_abcdefghijklmnopqrstuvwxyz0123456789';
    const fragment = token.slice(0, 20);
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => 'body' });
    const failure = await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
      metadataBase: `${server.base}/api/${fragment}`,
      githubToken: token,
    }).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('[redacted]');
    expect((failure as Error).message).not.toContain(fragment);
  });

  test('does not expose a credential fragment in an untrusted request ID', async () => {
    const token = 'ghs_abcd1234abcdefghijklmnopqrstuvwxyz';
    const fragment = 'abcd1234';
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => 'body' });
    const metadata = new FakeGitHubMetadata(
      server.base,
      () =>
        new Response('', {
          status: 403,
          headers: { 'x-github-request-id': fragment },
        })
    );
    const fetchSpy = spyOnGitHubMetadata(metadata);
    try {
      const failure = await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
        metadataBase: METADATA_BASE,
        githubToken: token,
      }).then(
        () => null,
        (caught: unknown) => caught
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('403 Forbidden');
      expect((failure as Error).message).not.toContain(fragment);
      expect((failure as Error).message).not.toContain('request ID:');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('redacts the credential if reading the metadata response fails', async () => {
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => 'body' });
    const metadata = new FakeGitHubMetadata(server.base, () => {
      const response = new Response('{}');
      Object.defineProperty(response, 'json', {
        value: () => Promise.reject(new Error('metadata body contained test-github-token')),
      });
      return response;
    });
    const fetchSpy = spyOnGitHubMetadata(metadata);
    try {
      const failure = await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
        metadataBase: METADATA_BASE,
        githubToken: 'test-github-token',
      }).then(
        () => null,
        (caught: unknown) => caught
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('Could not read release metadata JSON');
      expect((failure as Error).message).not.toContain('test-github-token');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('does not expose a partial credential from real JSON parser errors', async () => {
    const token = 'ghs_abcdefghijklmnopqrstuvwxyz0123456789';
    const fragment = token.slice(0, 20);
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => 'body' });
    const metadata = new FakeGitHubMetadata(server.base, () => new Response(fragment));
    const fetchSpy = spyOnGitHubMetadata(metadata);
    try {
      const failure = await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
        metadataBase: METADATA_BASE,
        githubToken: token,
      }).then(
        () => null,
        (caught: unknown) => caught
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('Invalid release metadata JSON');
      expect((failure as Error).message).not.toContain(fragment);
      expect(String((failure as Error).stack)).not.toContain(fragment);
      expect((failure as Error).cause).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('passes the token from the cross-runtime resolver to metadata only', async () => {
    const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch !== hostReleasePlatform());
    expect(target, 'expected a foreign release target').toBeDefined();
    if (!target) return;
    const asset = BUN_RUNTIME_ASSETS[target.arch];
    const server = serve({
      asset,
      listing: () => listingFor(sha256('old'), `${asset}.zip`),
      body: () => 'new-canary-bytes',
    });
    const metadata = new FakeGitHubMetadata(server.base, () => new Response('', { status: 403 }));
    const fetchSpy = spyOnGitHubMetadata(metadata);
    try {
      await expect(
        ensureBunCrossRuntime(target, {
          channel: CHANNEL,
          cacheDir: tempDir,
          cacheKey: 'integration',
          githubToken: 'test-github-token',
        })
      ).rejects.toThrow('Release metadata download failed (403 Forbidden)');
      expect(metadata.requests).toEqual([
        {
          url: `${METADATA_BASE}/${CHANNEL}`,
          authorization: 'Bearer test-github-token',
          redirect: 'error',
        },
      ]);
      expect(server.authorizations).toEqual([null, null, null]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('does not share an in-flight runtime resolution across credentials', async () => {
    const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch !== hostReleasePlatform());
    expect(target, 'expected a foreign release target').toBeDefined();
    if (!target) return;
    const asset = BUN_RUNTIME_ASSETS[target.arch];
    const server = serve({
      asset,
      listing: () => listingFor(sha256('old'), `${asset}.zip`),
      body: () => 'new-canary-bytes',
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const metadata = new FakeGitHubMetadata(server.base, async () => {
      await gate;
      return new Response('', { status: 403 });
    });
    const fetchSpy = spyOnGitHubMetadata(metadata);
    const options = { channel: CHANNEL, cacheDir: tempDir, cacheKey: 'credentials' };
    const downloads = [
      ensureBunCrossRuntime(target, { ...options, githubToken: 'first-token' }),
      ensureBunCrossRuntime(target, { ...options, githubToken: 'second-token' }),
    ];
    try {
      const deadline = Date.now() + 3000;
      while (metadata.requests.length < 2 && Date.now() < deadline) await Bun.sleep(10);
      expect(metadata.requests.map((request) => request.authorization).sort()).toEqual([
        'Bearer first-token',
        'Bearer second-token',
      ]);
      release();
      const results = await Promise.allSettled(downloads);
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      expect(
        results.map((result) => result.status === 'rejected' && result.reason.message)
      ).toEqual([
        expect.stringContaining('Release metadata download failed (403 Forbidden)'),
        expect.stringContaining('Release metadata download failed (403 Forbidden)'),
      ]);
    } finally {
      release();
      await Promise.allSettled(downloads);
      fetchSpy.mockRestore();
    }
  });

  test('includes safe diagnostic on metadata refusal', async () => {
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => 'body' });
    const metadata = new FakeGitHubMetadata(
      server.base,
      () =>
        new Response('refused', {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'x-ratelimit-remaining': '0', 'x-github-request-id': 'ABCD:1234' },
        })
    );
    const fetchSpy = spyOnGitHubMetadata(metadata);
    try {
      await expect(
        downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
          metadataBase: METADATA_BASE,
          githubToken: 'test-github-token',
        })
      ).rejects.toThrow('403 Forbidden; rate limit remaining: 0; request ID: ABCD:1234');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('keeps the metadata deadline when an authenticated request stalls', async () => {
    const server = serve({ listing: () => listingFor(sha256('old')), body: () => 'body' });
    const metadata = new FakeGitHubMetadata(
      server.base,
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) throw new Error('expected metadata request to carry an abort signal');
          init.signal.addEventListener('abort', () => reject(new Error('request aborted')), {
            once: true,
          });
        })
    );
    const fetchSpy = spyOnGitHubMetadata(metadata);
    try {
      await expect(
        downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
          metadataBase: METADATA_BASE,
          githubToken: 'test-github-token',
          checksumMs: 50,
        })
      ).rejects.toThrow('Timed out after 50ms reading release metadata');
      expect(metadata.requests[0]?.authorization).toBe('Bearer test-github-token');
    } finally {
      fetchSpy.mockRestore();
    }
  });
  test('writes the archive when the body matches the published digest', async () => {
    const body = 'pretend-zip-bytes';
    const server = serve({ listing: () => listingFor(sha256(body)), body: () => body });

    await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base);

    expect(await Bun.file(archivePath).text()).toBe(body);
    // A matching digest is the common path and must not pay for a second listing.
    expect(server.listingCalls).toBe(1);
  });

  test('accepts the GitHub asset digest when the checksum listing is stale', async () => {
    const body = 'new-canary-bytes';
    const server = serve({
      listing: () => listingFor(sha256('old-canary-bytes')),
      body: () => body,
      metadata: () =>
        JSON.stringify({ assets: [{ name: `${ASSET}.zip`, digest: `sha256:${sha256(body)}` }] }),
    });

    const result = await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, {
      metadataBase: `${server.base}/api`,
    });
    expect(result.sha256).toBe(sha256(body));
    expect(result.tagAdvanced).toBe(false);
  });

  test('rejects a body that does not match the published digest', async () => {
    const server = serve({
      listing: () => listingFor(sha256('the-real-asset')),
      body: () => 'corrupted-in-transit',
      metadata: () =>
        JSON.stringify({
          assets: [{ name: `${ASSET}.zip`, digest: `sha256:${sha256('the-real-asset')}` }],
        }),
    });

    await expect(downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base)).rejects.toThrow(
      /SHA-256 mismatch for bun-linux-x64\.zip on the "canary" channel/
    );
    // Re-read once before failing, to tell corruption from a tag that moved.
    expect(server.listingCalls).toBe(2);
  });

  test.each([
    ['missing asset', JSON.stringify({ assets: [] })],
    ['malformed digest', JSON.stringify({ assets: [{ name: `${ASSET}.zip`, digest: 'bad' }] })],
    [
      'duplicate asset',
      JSON.stringify({
        assets: [
          { name: `${ASSET}.zip`, digest: `sha256:${sha256('body')}` },
          { name: `${ASSET}.zip`, digest: `sha256:${sha256('body')}` },
        ],
      }),
    ],
  ])('rejects %s in release metadata', async (_, metadata) => {
    const server = serve({
      listing: () => listingFor(sha256('old')),
      body: () => 'body',
      metadata: () => metadata,
    });
    await expect(downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base)).rejects.toThrow(
      'Invalid release metadata digest'
    );
  });

  test('fails closed when release metadata is unavailable', async () => {
    const server = serve({
      listing: () => listingFor(sha256('old')),
      body: () => 'body',
      metadata: () => 503,
    });
    await expect(downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base)).rejects.toThrow(
      'Release metadata download failed (503 Service Unavailable)'
    );
  });

  test('bounds a stalled release metadata request', async () => {
    const server = serve({
      listing: () => listingFor(sha256('old')),
      body: () => 'body',
      metadata: () => STALL,
    });
    await expect(
      downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, { checksumMs: 50 })
    ).rejects.toThrow('Timed out after 50ms reading release metadata');
  });

  test('accepts a channel tag that advanced between the listing and the download', async () => {
    // The failure this prevents is a red release build caused by an upstream
    // merge landing mid-fetch, which is not a defect in anything being built.
    const advanced = 'bytes-from-the-newer-canary';
    const server = serve({
      listing: (call) =>
        call === 1
          ? listingFor(sha256('bytes-from-the-older-canary'))
          : listingFor(sha256(advanced)),
      body: () => advanced,
    });

    await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base);

    expect(await Bun.file(archivePath).text()).toBe(advanced);
    expect(server.listingCalls).toBe(2);
  });

  test('fails before downloading anything when the listing is unavailable', async () => {
    const server = serve({ listing: () => 404, body: () => 'never-reached' });

    await expect(downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base)).rejects.toThrow(
      /Checksum download failed \(404/
    );
    expect(await Bun.file(archivePath).exists()).toBe(false);
  });

  test('fails when the listing carries no digest for this asset', async () => {
    const server = serve({
      listing: () => listingFor(sha256('other'), 'bun-windows-x64.zip'),
      body: () => 'anything',
    });

    await expect(downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base)).rejects.toThrow(
      /lists no digest for bun-linux-x64\.zip/
    );
  });

  test('fails when the archive itself is unavailable', async () => {
    const body = 'pretend-zip-bytes';
    const server = serve({ listing: () => listingFor(sha256(body)), body: () => 500 });

    await expect(downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base)).rejects.toThrow(
      /Download failed \(500/
    );
  });

  test('the host target compiles against the running Bun, downloading nothing', async () => {
    const host = hostReleasePlatform();
    if (host === null) return; // libc unidentifiable here; the skip is off by design

    const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch === host);
    expect(target, `no binary target for host platform ${host}`).toBeDefined();
    if (!target) return;

    // A channel that cannot resolve: if the short-circuit ever regresses this
    // fails in milliseconds on the checksum listing, rather than quietly
    // downloading a runtime the host already is.
    const resolved = await ensureBunCrossRuntime(target, {
      channel: 'not-a-real-channel',
      cacheDir: join(tempDir, 'must-not-be-used'),
      cacheKey: 'nothing-installed-here',
    });

    expect(resolved).toBe(process.execPath);
  });

  // Both ceilings are otherwise unexercised, and the failure they bound reads
  // as nothing at all: the connection is accepted, so a stall is
  // indistinguishable from a slow build until an outer timeout kills the job.
  // The assertions are on which request is named, because a bare "timed out"
  // repeats the silence it replaced.
  test('a stalled listing fails by name instead of hanging', async () => {
    const server = serve({ listing: () => STALL, body: () => 'never-reached' });

    await expect(
      downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, { checksumMs: 50 })
    ).rejects.toThrow(/Timed out after 50ms reading SHASUMS256\.txt for the "canary" channel/);
    expect(await Bun.file(archivePath).exists()).toBe(false);
  });

  test('a stalled asset download fails by name instead of hanging', async () => {
    const server = serve({ listing: () => listingFor(sha256('anything')), body: () => STALL });

    await expect(
      downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base, { assetMs: 50 })
    ).rejects.toThrow(
      /Timed out after 50ms downloading bun-linux-x64\.zip from the "canary" channel/
    );
  });

  test('reads a digest whose name is marked for binary mode', async () => {
    const body = 'pretend-zip-bytes';
    const server = serve({
      listing: () => listingFor(sha256(body), `${ASSET}.zip`, '*'),
      body: () => body,
    });

    await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base);

    expect(await Bun.file(archivePath).text()).toBe(body);
  });
});

describe('clearBunCrossRuntimeCache', () => {
  test('removes the directory the same channel and host would resolve to', async () => {
    const cacheDir = join(tempDir, 'bun-cross');
    const options = { cacheDir, cacheKey: 'canary-abc' };
    const installed = join(cacheDir, 'canary-abc', ASSET, 'bun');
    await Bun.write(installed, 'pretend-bun');

    const cleared = await clearBunCrossRuntimeCache(CHANNEL, options);

    expect(cleared).toBe(join(cacheDir, 'canary-abc'));
    expect(await Bun.file(installed).exists()).toBe(false);
    // The cold path has to be reachable on demand, not only by knowing which
    // directory to delete — and an absent cache is already the desired state.
    expect(await clearBunCrossRuntimeCache(CHANNEL, options)).toBe(cleared);
  });
});
