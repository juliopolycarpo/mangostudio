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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  downloadVerifiedAsset,
  ensureBunCrossRuntime,
  hostReleasePlatform,
} from '../lib/bun-cross-runtime';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';

const CHANNEL = 'canary';
const ASSET = 'bun-linux-x64';

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

/** A response body, or a status code to fail the request with. */
type Reply = string | number;

function reply(value: Reply): Response {
  return typeof value === 'number'
    ? new Response('not found', { status: value })
    : new Response(value);
}

function startFakeRelease(handlers: {
  /** Called with the 1-based request count, so a test can move the tag. */
  listing: (call: number) => Reply;
  body: () => Reply;
}) {
  let listingCalls = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === `/${CHANNEL}/SHASUMS256.txt`) {
        listingCalls += 1;
        return reply(handlers.listing(listingCalls));
      }
      if (pathname === `/${CHANNEL}/${ASSET}.zip`) {
        return reply(handlers.body());
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    base: `http://localhost:${server.port}`,
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
  test('writes the archive when the body matches the published digest', async () => {
    const body = 'pretend-zip-bytes';
    const server = serve({ listing: () => listingFor(sha256(body)), body: () => body });

    await downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base);

    expect(await Bun.file(archivePath).text()).toBe(body);
    // A matching digest is the common path and must not pay for a second listing.
    expect(server.listingCalls).toBe(1);
  });

  test('rejects a body that does not match the published digest', async () => {
    const server = serve({
      listing: () => listingFor(sha256('the-real-asset')),
      body: () => 'corrupted-in-transit',
    });

    await expect(downloadVerifiedAsset(ASSET, CHANNEL, archivePath, server.base)).rejects.toThrow(
      /SHA-256 mismatch for bun-linux-x64\.zip on the "canary" channel/
    );
    // Re-read once before failing, to tell corruption from a tag that moved.
    expect(server.listingCalls).toBe(2);
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
