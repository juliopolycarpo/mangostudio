import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedDownload } from '../../../../src/modules/updates/domain/resolve-target';
import { downloadVerified } from '../../../../src/modules/updates/infrastructure/release-download';
import { FakeReleaseHost } from './support/fake-release-host';

const GITHUB = 'https://github.com/juliopolycarpo/mangostudio';
const CDN =
  'https://objects.githubusercontent.com/release-assets/mangostudio-1.4.0-linux-x64.tar.gz';
const ARCHIVE_BYTES = new TextEncoder().encode('a fake archive, just needs a stable digest');

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let tempDirs: string[] = [];

function tempDestination(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-upgrade-download-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
});

describe('downloadVerified — sha256-sums archive targets', () => {
  const archiveTarget: ResolvedDownload = {
    channel: 'stable',
    version: '1.4.0',
    assetName: 'mangostudio-1.4.0-linux-x64.tar.gz',
    url: `${GITHUB}/releases/download/v1.4.0/mangostudio-1.4.0-linux-x64.tar.gz`,
    kind: 'archive',
    verification: 'sha256-sums',
    checksumsUrl: `${GITHUB}/releases/download/v1.4.0/SHA256SUMS`,
  };

  it('downloads through a redirect hop, verifies against a freshly-fetched SHA256SUMS, and writes the file', async () => {
    const digest = sha256Hex(ARCHIVE_BYTES);
    const host = new FakeReleaseHost({
      [archiveTarget.checksumsUrl]: {
        body: `${digest}  mangostudio-1.4.0-linux-x64.tar.gz\n`,
      },
      [archiveTarget.url]: { redirectTo: CDN },
      [CDN]: { body: ARCHIVE_BYTES },
    });
    const destinationDir = tempDestination();

    const result = await downloadVerified(archiveTarget, destinationDir, {
      fetch: host.fetch,
      resolveHostname: host.resolveHostname,
    });

    expect(result).toEqual({
      path: join(destinationDir, archiveTarget.assetName),
      verification: 'sha256-sums',
    });
    expect(readFileSync(result.path)).toEqual(Buffer.from(ARCHIVE_BYTES));
    expect(host.calls).toContain(archiveTarget.url);
    expect(host.calls).toContain(CDN);
  });

  it('throws the exact mismatch message and removes anything left at the destination', async () => {
    const wrongDigest = 'deadbeef'.repeat(8);
    const host = new FakeReleaseHost({
      [archiveTarget.checksumsUrl]: {
        body: `${wrongDigest}  mangostudio-1.4.0-linux-x64.tar.gz\n`,
      },
      [archiveTarget.url]: { body: ARCHIVE_BYTES },
    });
    const destinationDir = tempDestination();
    const actual = sha256Hex(ARCHIVE_BYTES);

    await expect(
      downloadVerified(archiveTarget, destinationDir, {
        fetch: host.fetch,
        resolveHostname: host.resolveHostname,
      })
    ).rejects.toThrow(
      `checksum mismatch for ${archiveTarget.assetName}: expected ${wrongDigest} | received ${actual}`
    );
    expect(existsSync(join(destinationDir, archiveTarget.assetName))).toBe(false);
  });

  it('fails clearly when the checksums file does not list the asset', async () => {
    const host = new FakeReleaseHost({
      [archiveTarget.checksumsUrl]: { body: 'deadbeef  some-other-file.tar.gz\n' },
      [archiveTarget.url]: { body: ARCHIVE_BYTES },
    });

    await expect(
      downloadVerified(archiveTarget, tempDestination(), {
        fetch: host.fetch,
        resolveHostname: host.resolveHostname,
      })
    ).rejects.toThrow('does not list');
  });
});

describe('downloadVerified — npm-integrity tarball targets', () => {
  it('verifies against the digest the resolver already carried, with no checksums fetch', async () => {
    const npmTarget: ResolvedDownload = {
      channel: 'canary',
      version: '0.1.1-canary.g0123456',
      sourceSha: '0123456',
      assetName: 'cli-linux-x64-0.1.1.tgz',
      url: 'https://registry.npmjs.org/@mangostudio/cli-linux-x64/-/cli-linux-x64-0.1.1.tgz',
      kind: 'npm-tarball',
      verification: 'npm-integrity',
      expectedDigest: {
        algorithm: 'sha512',
        hex: createHash('sha512').update(ARCHIVE_BYTES).digest('hex'),
      },
    };
    const host = new FakeReleaseHost({ [npmTarget.url]: { body: ARCHIVE_BYTES } });
    const destinationDir = tempDestination();

    const result = await downloadVerified(npmTarget, destinationDir, {
      fetch: host.fetch,
      resolveHostname: host.resolveHostname,
    });

    expect(result.verification).toBe('npm-integrity');
    expect(readFileSync(result.path)).toEqual(Buffer.from(ARCHIVE_BYTES));
    // Confirms no separate checksums round trip happened for this shape.
    expect(host.calls).toEqual([npmTarget.url]);
  });

  it('rejects an asset name carrying a path separator before ever touching disk', async () => {
    const npmTarget: ResolvedDownload = {
      channel: 'canary',
      version: '0.1.1-canary.g0123456',
      sourceSha: '0123456',
      assetName: '../escape.tgz',
      url: 'https://registry.npmjs.org/@mangostudio/cli-linux-x64/-/escape.tgz',
      kind: 'npm-tarball',
      verification: 'npm-integrity',
      expectedDigest: { algorithm: 'sha256', hex: 'irrelevant' },
    };
    const host = new FakeReleaseHost({});

    await expect(
      downloadVerified(npmTarget, tempDestination(), {
        fetch: host.fetch,
        resolveHostname: host.resolveHostname,
      })
    ).rejects.toThrow('not a bare file name');
    expect(host.calls).toEqual([]);
  });
});
