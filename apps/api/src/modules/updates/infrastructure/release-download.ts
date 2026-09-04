/**
 * Downloads a resolved upgrade target and verifies it before anything else
 * touches it — the boundary between "the network answered" and "this hub may
 * hand these bytes to the install script".
 *
 * Two verification shapes, chosen by `resolveUpgradeTarget` and carried on the
 * `ResolvedDownload` it returns: a `sha256-sums` target's digest is fetched
 * fresh from its own `checksumsUrl` (a rolling tag republishes the file, so an
 * earlier read would check today's bytes against yesterday's list); an
 * `npm-integrity` target already has its digest, handed back by the registry
 * with the packument.
 */

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpgradeVerification } from '@mangostudio/shared/updates';
import type { SafeFetchDeps } from '../../../lib/safe-fetch';
import { safeFetchBytes } from '../../../lib/safe-fetch';
import { findReleaseChecksum } from '../../environments/domain/wsl-runtime-release';
import type { ExpectedDigest, ResolvedDownload } from '../domain/resolve-target';
import { fetchReleaseChecksums } from './release-index';

// The largest platform archive is well under this; mirrors the cargo shim's
// own download cap for the same reason (see packages/cargo-shim/src/main.rs).
// safeFetchBytes buffers the whole body before returning it, so this is also
// roughly the worst-case memory this download costs, not just its disk cost.
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_REDIRECTS = 5;
const DOWNLOAD_HEADERS = { 'User-Agent': 'mangostudio-hub' };

export interface DownloadedUpgrade {
  readonly path: string;
  readonly verification: UpgradeVerification;
}

/** The digest a `sha256-sums` target must match, read fresh from its own `checksumsUrl`. */
async function expectedArchiveDigest(
  resolved: Extract<ResolvedDownload, { verification: 'sha256-sums' }>,
  deps: SafeFetchDeps
): Promise<ExpectedDigest> {
  const checksums = await fetchReleaseChecksums(deps, resolved.checksumsUrl);
  const hex = findReleaseChecksum(checksums, resolved.assetName);
  if (!hex) {
    throw new Error(`${resolved.checksumsUrl} does not list ${resolved.assetName}.`);
  }
  return { algorithm: 'sha256', hex };
}

function expectedDigestFor(
  resolved: ResolvedDownload,
  deps: SafeFetchDeps
): Promise<ExpectedDigest> {
  return resolved.verification === 'sha256-sums'
    ? expectedArchiveDigest(resolved, deps)
    : Promise.resolve(resolved.expectedDigest);
}

/**
 * Downloads `resolved.url`, verifies it against the digest its own
 * verification shape names, and writes it to `<destinationDir>/<assetName>` —
 * or throws and removes anything left at that path.
 * // Usage: await downloadVerified(resolved, '/tmp/mango-upgrade', { fetch })
 */
export async function downloadVerified(
  resolved: ResolvedDownload,
  destinationDir: string,
  deps: SafeFetchDeps
): Promise<DownloadedUpgrade> {
  // The asset name ultimately comes from a URL path segment (the npm tarball
  // case) or a release listing; refusing anything carrying a path separator
  // — either platform's — keeps it from ever being interpreted as a path.
  if (/[\\/]/.test(resolved.assetName)) {
    throw new Error(
      `Refusing to write an asset name that is not a bare file name: ${resolved.assetName}`
    );
  }
  const destinationPath = join(destinationDir, resolved.assetName);

  const [expected, result] = await Promise.all([
    expectedDigestFor(resolved, deps),
    safeFetchBytes(
      resolved.url,
      {
        maxBytes: MAX_DOWNLOAD_BYTES,
        maxRedirects: MAX_REDIRECTS,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        headers: DOWNLOAD_HEADERS,
      },
      deps
    ),
  ]);

  const actual = createHash(expected.algorithm).update(result.bytes).digest('hex').toLowerCase();
  if (actual !== expected.hex.toLowerCase()) {
    await rm(destinationPath, { force: true });
    throw new Error(
      `checksum mismatch for ${resolved.assetName}: expected ${expected.hex} | received ${actual}`
    );
  }

  await mkdir(destinationDir, { recursive: true });
  await writeFile(destinationPath, result.bytes);
  return { path: destinationPath, verification: resolved.verification };
}
