/**
 * Downloads a release runtime asset (raw preferred, archive fallback) into the
 * hub cache. Shared by WSL provisioning and SSH push so both transports verify
 * the same SHA256SUMS line before any remote write.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getHomeMangoDir, getVersion, isDevelopmentVersion } from '../../../lib/config';
import { getRuntimeBaseDir } from '../../../lib/runtime-paths';
import { type SafeFetchDeps, SafeFetchError, safeFetchBytes } from '../../../lib/safe-fetch';
import {
  CANARY_MANIFEST_ASSET,
  type CanaryManifest,
  checkRollingPair,
  manifestRuntimeDigest,
} from './canary-manifest';
import { type RuntimeReleaseResolution, resolveRuntimeRelease } from './runtime-release-resolution';
import {
  findReleaseChecksum,
  localRuntimeBuildPath,
  releaseArchiveName,
  releaseAssetUrl,
} from './wsl-runtime-release';

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 64 * 1024;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_REDIRECTS = 5;

export class RuntimeAssetLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeAssetLoadError';
  }
}

export interface LoadedRuntimeAsset {
  readonly bytes: Uint8Array;
  readonly fromArchive: boolean;
  readonly digest: string;
  /**
   * Source commit these bytes were built from, when the channel publishes one.
   *
   * Only a rolling release answers this: its filename and tag are reused across
   * builds, so the commit is the only thing that says which build a slot holds.
   * A stable version already names one build on its own.
   */
  readonly sourceSha?: string;
  /**
   * Whether `bytes` is actually on disk at the cache path, not just verified
   * in memory. A caller that installs the bytes elsewhere (WSL/SSH push) can
   * treat the cache as a courtesy and ignore this; a caller whose entire job
   * is populating the cache (hub-only download) cannot.
   */
  readonly cached: boolean;
}

export async function loadRuntimeReleaseBytes(
  platformId: string,
  overrides: Partial<SafeFetchDeps> & {
    readonly version?: string;
    readonly cacheDir?: (version: string) => string;
    readonly readBytes?: (path: string) => Promise<Uint8Array | null>;
    readonly writeCache?: (path: string, bytes: Uint8Array) => Promise<void>;
    readonly localBuildPath?: (platformId: string) => string;
    /** Cancels an in-flight manifest or asset download; checked between hops, not mid-byte-stream. */
    readonly signal?: AbortSignal;
  } = {}
): Promise<LoadedRuntimeAsset> {
  const signal = overrides.signal;
  const version = overrides.version ?? getVersion();
  const cacheDir = overrides.cacheDir ?? ((v) => join(getHomeMangoDir(), 'runtime-cache', v));
  const readBytes =
    overrides.readBytes ??
    (async (path) => {
      try {
        return new Uint8Array(await readFile(path));
      } catch {
        return null;
      }
    });
  const writeCache =
    overrides.writeCache ??
    (async (path, bytes) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    });
  const localBuild =
    overrides.localBuildPath ??
    ((id) => localRuntimeBuildPath(getRuntimeBaseDir(), id as 'linux-x64'));

  if (isDevelopmentVersion(version)) {
    const path = localBuild(platformId);
    const bytes = await readBytes(path);
    if (!bytes) {
      throw new RuntimeAssetLoadError(
        `No local runtime build at ${path} for development version "${version}".`
      );
    }
    return { bytes, fromArchive: false, digest: `sha256:${sha256(bytes)}`, cached: true };
  }

  const deps: SafeFetchDeps = {
    fetch: overrides.fetch ?? globalThis.fetch,
    ...(overrides.resolveHostname ? { resolveHostname: overrides.resolveHostname } : {}),
  };
  const release = resolveRuntimeRelease(version, platformId);
  const manifest = release.rolling
    ? await assertRollingPair(deps, version, release, platformId, signal)
    : null;
  const provenance = manifest ? { sourceSha: manifest.sourceSha } : {};
  // Bound to the manifest read {@link assertRollingPair} already validated,
  // rather than a second, later fetch of SHA256SUMS off the same rolling tag —
  // see {@link manifestRuntimeDigest}.
  const boundDigest = manifest
    ? manifestRuntimeDigest(manifest, platformId, release.runtimeAssetName)
    : undefined;

  try {
    const { bytes, cached } = await loadAsset(
      deps,
      {
        cacheVersion: version,
        tagVersion: release.tagVersion,
        assetName: release.runtimeAssetName,
      },
      cacheDir,
      readBytes,
      writeCache,
      boundDigest,
      signal
    );
    return { bytes, fromArchive: false, digest: `sha256:${sha256(bytes)}`, cached, ...provenance };
  } catch (error) {
    if (!(error instanceof RuntimeAssetMissingError)) throw error;
  }

  const { bytes, cached } = await loadAsset(
    deps,
    {
      cacheVersion: version,
      tagVersion: release.tagVersion,
      assetName: releaseArchiveName(release.assetVersion, platformId),
    },
    cacheDir,
    readBytes,
    writeCache,
    undefined,
    signal
  );
  return { bytes, fromArchive: true, digest: `sha256:${sha256(bytes)}`, cached, ...provenance };
}

class RuntimeAssetMissingError extends RuntimeAssetLoadError {}

/**
 * Refuses a rolling install whose assets belong to a different commit.
 *
 * A missing manifest is tolerated: rolling releases cut before it existed have
 * none, and turning that into a failure would break the channel to add a check.
 */
async function assertRollingPair(
  deps: SafeFetchDeps,
  version: string,
  release: RuntimeReleaseResolution,
  platformId: string,
  signal?: AbortSignal
): Promise<CanaryManifest | null> {
  const { manifest, refusal } = await checkRollingPair({
    fetchManifest: () =>
      download(
        deps,
        releaseAssetUrl(release.tagVersion, CANARY_MANIFEST_ASSET),
        MAX_CHECKSUMS_BYTES,
        signal
      ),
    tolerate: (error) => error instanceof RuntimeAssetLoadError,
    hubVersion: version,
    platformId,
  });
  if (refusal) throw new RuntimeAssetLoadError(refusal);
  return manifest;
}

async function loadAsset(
  deps: SafeFetchDeps,
  identity: {
    readonly cacheVersion: string;
    readonly tagVersion: string;
    readonly assetName: string;
  },
  cacheDir: (version: string) => string,
  readBytes: (path: string) => Promise<Uint8Array | null>,
  writeCache: (path: string, bytes: Uint8Array) => Promise<void>,
  expectedDigest?: string,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; cached: boolean }> {
  const { assetName, cacheVersion, tagVersion } = identity;
  const cachePath = join(cacheDir(cacheVersion), assetName);
  const expected =
    expectedDigest ?? (await fetchExpectedChecksum(deps, tagVersion, assetName, signal));
  const fromCache = await readBytes(cachePath);
  if (fromCache && sha256(fromCache) === expected) return { bytes: fromCache, cached: true };

  const bytes = await download(
    deps,
    releaseAssetUrl(tagVersion, assetName),
    MAX_ARCHIVE_BYTES,
    signal
  );
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new RuntimeAssetLoadError(
      `The downloaded ${assetName} does not match the checksum published for this release.`
    );
  }
  const cached = await writeCache(cachePath, bytes).then(
    () => true,
    () => false
  );
  if (cached) {
    // Pins what verifying this file later means, independent of whatever
    // SHA256SUMS a rolling tag serves by then — see {@link runtimeDigestSidecarPath}.
    await writeCache(runtimeDigestSidecarPath(cachePath), new TextEncoder().encode(actual)).catch(
      () => undefined
    );
  }
  await pruneRuntimeCache(cacheDir(cacheVersion), cacheVersion).catch(() => undefined);
  return { bytes, cached };
}

/**
 * Where the digest that validated a cached asset is recorded, next to it.
 *
 * A rolling tag republishes SHA256SUMS under the same filename as newer builds
 * land, so re-fetching it to build a verify command for bytes already on disk
 * checks today's build against yesterday's cache and reports a false mismatch.
 * The sidecar remembers the digest this hub actually verified at download
 * time, so a later verify command can check the file against itself.
 */
export function runtimeDigestSidecarPath(assetPath: string): string {
  return `${assetPath}.sha256`;
}

/**
 * Keeps the hub cache at current + previous version directories only — same rule
 * as slot version GC in {@link pushRuntimeBinary}.
 */
export async function pruneRuntimeCache(
  currentVersionDir: string,
  currentVersion: string
): Promise<void> {
  const cacheRoot = dirname(currentVersionDir);
  let entries: string[];
  try {
    entries = await readdir(cacheRoot);
  } catch {
    return;
  }

  const others = entries
    .filter((name) => name !== currentVersion)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const keepPrevious = others[0];
  for (const name of others) {
    if (name === keepPrevious) continue;
    await rm(join(cacheRoot, name), { force: true, recursive: true }).catch(() => undefined);
  }
}

async function fetchExpectedChecksum(
  deps: SafeFetchDeps,
  version: string,
  assetName: string,
  signal?: AbortSignal
): Promise<string> {
  const checksums = await download(
    deps,
    releaseAssetUrl(version, 'SHA256SUMS'),
    MAX_CHECKSUMS_BYTES,
    signal
  );
  const expected = findReleaseChecksum(new TextDecoder().decode(checksums), assetName);
  if (!expected) {
    throw new RuntimeAssetMissingError(`Release v${version} does not publish ${assetName}.`);
  }
  return expected;
}

async function download(
  deps: SafeFetchDeps,
  url: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  try {
    const result = await safeFetchBytes(
      url,
      { maxBytes, maxRedirects: MAX_REDIRECTS, timeoutMs: DOWNLOAD_TIMEOUT_MS, signal },
      deps
    );
    return result.bytes;
  } catch (error) {
    if (error instanceof SafeFetchError) {
      if (error.message.includes('404') || /\b404\b/.test(error.message)) {
        throw new RuntimeAssetMissingError(`Could not download ${url}: ${error.message}.`);
      }
      throw new RuntimeAssetLoadError(`Could not download ${url}: ${error.message}.`);
    }
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
