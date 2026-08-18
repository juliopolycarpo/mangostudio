/**
 * Downloads a release runtime asset (raw preferred, archive fallback) into the
 * hub cache. Shared by SSH push and container mounts so both transports verify
 * the same SHA256SUMS line before any remote write; WSL provisioning verifies
 * the same way against its own transfer path and shares the cache rules here.
 *
 * Verification is what guarantees the bytes, so the network path stays
 * authoritative: a checksum this hub can fetch is always the one it checks
 * against, and a cached file that disagrees with it is discarded. What that
 * cost, until {@link readVerifiedCacheEntry}, was every launch — a hub with no
 * network could not start an environment whose exact binary was already sitting
 * verified in its own cache.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getHomeMangoDir, getVersion, isDevelopmentVersion } from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getRuntimeBaseDir } from '../../../lib/runtime-paths';
import {
  isUnreachableFailure,
  type SafeFetchDeps,
  SafeFetchError,
  safeFetchBytes,
} from '../../../lib/safe-fetch';
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

const logger = createDiagnosticLogger('runtime-release-fetch');

export class RuntimeAssetLoadError extends Error {
  /**
   * Whether the release could not be reached, as opposed to answering.
   *
   * Only this kind of failure has an offline answer: a host that cannot get to
   * the checksums may still hold bytes it verified against them once, while a
   * release that says a version does not exist has settled the question.
   */
  readonly unreachable: boolean;

  constructor(message: string, options: { readonly unreachable?: boolean } = {}) {
    super(message);
    this.name = 'RuntimeAssetLoadError';
    this.unreachable = options.unreachable ?? false;
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
  /**
   * Whether these bytes came from the cache without the release confirming
   * them this time — the offline path in {@link readVerifiedCacheEntry}.
   *
   * Reported rather than logged alone: "it worked offline" is a state an
   * operator has to be able to see on the environment, not something only a
   * diagnostic log remembers.
   */
  readonly offlineCache: boolean;
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
    return {
      bytes,
      fromArchive: false,
      digest: `sha256:${sha256(bytes)}`,
      cached: true,
      offlineCache: false,
    };
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

  const load = {
    deps,
    cacheVersion: version,
    tagVersion: release.tagVersion,
    rolling: release.rolling,
    cacheDir,
    readBytes,
    writeCache,
    ...(signal ? { signal } : {}),
  };

  try {
    const raw = await loadAsset({
      ...load,
      assetName: release.runtimeAssetName,
      ...(boundDigest ? { expectedDigest: boundDigest } : {}),
    });
    return {
      bytes: raw.bytes,
      fromArchive: false,
      digest: `sha256:${sha256(raw.bytes)}`,
      cached: raw.cached,
      offlineCache: raw.offlineCache,
      ...provenance,
    };
  } catch (error) {
    if (!(error instanceof RuntimeAssetMissingError)) throw error;
  }

  const archive = await loadAsset({
    ...load,
    assetName: releaseArchiveName(release.assetVersion, platformId),
  });
  return {
    bytes: archive.bytes,
    fromArchive: true,
    digest: `sha256:${sha256(archive.bytes)}`,
    cached: archive.cached,
    offlineCache: archive.offlineCache,
    ...provenance,
  };
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

/** Everything one asset load needs, in one object so no caller mis-orders it. */
interface AssetLoad {
  readonly deps: SafeFetchDeps;
  /** The hub's own version, which names the cache directory. */
  readonly cacheVersion: string;
  /** The tag the asset is published under; differs from the above on a rolling channel. */
  readonly tagVersion: string;
  readonly assetName: string;
  /** Whether the tag republishes under one filename, which decides what may be remembered. */
  readonly rolling: boolean;
  readonly cacheDir: (version: string) => string;
  readonly readBytes: (path: string) => Promise<Uint8Array | null>;
  readonly writeCache: (path: string, bytes: Uint8Array) => Promise<void>;
  /** A digest already bound to a validated manifest read, when there is one. */
  readonly expectedDigest?: string;
  readonly signal?: AbortSignal;
}

async function loadAsset(
  load: AssetLoad
): Promise<{ bytes: Uint8Array; cached: boolean; offlineCache: boolean }> {
  const { assetName, cacheVersion, tagVersion } = load;
  const versionDir = load.cacheDir(cacheVersion);
  const cachePath = join(versionDir, assetName);

  let expected: string;
  if (load.expectedDigest) {
    expected = load.expectedDigest;
  } else {
    try {
      expected = await fetchExpectedChecksum(load, versionDir);
    } catch (error) {
      const offline = await readOfflineCacheEntry({
        cachePath,
        versionDir,
        assetName,
        readBytes: load.readBytes,
        unreachableReason:
          error instanceof RuntimeAssetLoadError && error.unreachable ? error.message : undefined,
      });
      if (offline) return { bytes: offline, cached: true, offlineCache: true };
      throw error;
    }
  }

  const fromCache = await load.readBytes(cachePath);
  if (fromCache && sha256(fromCache) === expected) {
    return { bytes: fromCache, cached: true, offlineCache: false };
  }

  const bytes = await download(
    load.deps,
    releaseAssetUrl(tagVersion, assetName),
    MAX_ARCHIVE_BYTES,
    load.signal
  );
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new RuntimeAssetLoadError(
      `The downloaded ${assetName} does not match the checksum published for this release.`
    );
  }
  const cached = await load.writeCache(cachePath, bytes).then(
    () => true,
    () => false
  );
  if (cached) {
    // Pins what verifying this file later means, independent of whatever
    // SHA256SUMS a rolling tag serves by then — see {@link runtimeDigestSidecarPath}.
    await load
      .writeCache(runtimeDigestSidecarPath(cachePath), new TextEncoder().encode(actual))
      .catch(() => undefined);
  }
  await pruneRuntimeCache(versionDir, cacheVersion).catch(() => undefined);
  return { bytes, cached, offlineCache: false };
}

/** What a version directory remembers a release's published checksums under. */
export const CHECKSUMS_CACHE_NAME = 'SHA256SUMS';

interface VerifiedCacheLookup {
  readonly cachePath: string;
  /** The version directory holding the asset and any remembered checksums. */
  readonly versionDir: string;
  readonly assetName: string;
  readonly readBytes: (path: string) => Promise<Uint8Array | null>;
}

/**
 * The bytes at `cachePath`, if and only if a digest recorded when they were
 * downloaded still matches them.
 *
 * *Recorded*, never re-derived: a file hashed and compared against its own hash
 * always passes, so a self-consistent corrupt or substituted entry would clear
 * a check like that without anything having verified anything. The digest comes
 * from the sidecar this hub wrote after the release confirmed those bytes, or
 * failing that from the SHA256SUMS it kept from the same download.
 *
 * Returns null for every reason to be unsure — no cache, no record, a record
 * that does not match — because the caller's alternative is a clear failure
 * naming a version it could not fetch, which is a better answer than a binary
 * nothing vouches for.
 */
async function readVerifiedCacheEntry(lookup: VerifiedCacheLookup): Promise<Uint8Array | null> {
  const bytes = await lookup.readBytes(lookup.cachePath);
  if (!bytes) return null;

  const recorded = await recordedCacheDigest(lookup);
  if (!recorded) return null;
  return sha256(bytes) === recorded ? bytes : null;
}

export interface OfflineCacheLookup extends VerifiedCacheLookup {
  /**
   * Why the release could not be reached, or undefined when it answered.
   *
   * The caller decides this because the error class is its own — the shared
   * loader's and the WSL provisioner's transports each raise their own — while
   * what an unreachable release entitles a launch to is decided here. Carrying
   * the reason rather than a boolean beside it leaves no way to claim a host
   * was offline without saying what said so.
   */
  readonly unreachableReason: string | undefined;
}

/**
 * The cached asset, when the release could not be reached and a digest this
 * hub recorded earlier vouches for the bytes.
 *
 * Only an unreachable release qualifies. A 404 is an answer — the version does
 * not publish this asset — and a malformed SHA256SUMS is a broken release, not
 * an offline condition; neither may be answered from disk.
 */
export async function readOfflineCacheEntry(
  lookup: OfflineCacheLookup
): Promise<Uint8Array | null> {
  if (lookup.unreachableReason === undefined) return null;

  const bytes = await readVerifiedCacheEntry(lookup);
  if (!bytes) return null;

  logger.warn('offline_cache_used', {
    asset: lookup.assetName,
    path: lookup.cachePath,
    reason: lookup.unreachableReason,
  });
  return bytes;
}

/**
 * Keeps a release's published checksums in the version directory, so a later
 * launch that cannot reach the release still has a record of what these bytes
 * were verified against — see {@link recordedCacheDigest}.
 *
 * A rolling tag is left out: it republishes SHA256SUMS under one filename as
 * new builds land, so a copy records what that tag used to hold, not what it
 * holds. Failing to write is not a failure to install.
 */
export async function rememberReleaseChecksums(remember: {
  readonly rolling: boolean;
  readonly versionDir: string;
  readonly checksums: Uint8Array;
  readonly writeCache: (path: string, bytes: Uint8Array) => Promise<void>;
}): Promise<void> {
  if (remember.rolling) return;
  await remember
    .writeCache(join(remember.versionDir, CHECKSUMS_CACHE_NAME), remember.checksums)
    .catch(() => undefined);
}

async function recordedCacheDigest(lookup: VerifiedCacheLookup): Promise<string | undefined> {
  const sidecar = await lookup.readBytes(runtimeDigestSidecarPath(lookup.cachePath));
  const pinned = sidecar ? pinnedRuntimeDigest(new TextDecoder().decode(sidecar)) : undefined;
  if (pinned) return pinned;

  // Older cache entries predate the sidecar, and an archive fallback is written
  // beside a SHA256SUMS that names it. Both are digests a release published and
  // this hub verified against, so both are records rather than re-derivations.
  const checksums = await lookup.readBytes(join(lookup.versionDir, CHECKSUMS_CACHE_NAME));
  if (!checksums) return undefined;
  return findReleaseChecksum(new TextDecoder().decode(checksums), lookup.assetName) ?? undefined;
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

/** Exactly what {@link loadAsset} writes into a sidecar, and nothing else. */
const PINNED_DIGEST = /^[0-9a-f]{64}$/;

/**
 * A sidecar's digest, believed only when it looks like one.
 *
 * Kept beside the writer so both ends agree on one format. The cache directory
 * is an ordinary user-writable directory, and a reader interpolates this string
 * into a shell command it tells somebody to paste, then returns it in a
 * response whose schema bounds the command's length. Anything that is not a
 * sha256 hex digest has to read as no sidecar at all, so the caller falls back
 * to its tag-based command rather than shipping whatever was in the file.
 */
export function pinnedRuntimeDigest(text: string): string | undefined {
  const digest = text.trim();
  return PINNED_DIGEST.test(digest) ? digest : undefined;
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

/**
 * The digest this release publishes for the asset, from the release itself.
 *
 * The answer is also kept in the version directory on the way past — see
 * {@link rememberReleaseChecksums} — for a later launch that cannot reach the
 * release at all.
 */
async function fetchExpectedChecksum(load: AssetLoad, versionDir: string): Promise<string> {
  const { assetName, tagVersion } = load;
  const checksums = await download(
    load.deps,
    releaseAssetUrl(tagVersion, 'SHA256SUMS'),
    MAX_CHECKSUMS_BYTES,
    load.signal
  );
  const expected = findReleaseChecksum(new TextDecoder().decode(checksums), assetName);
  if (!expected) {
    throw new RuntimeAssetMissingError(`Release v${tagVersion} does not publish ${assetName}.`);
  }
  await rememberReleaseChecksums({
    rolling: load.rolling,
    versionDir,
    checksums,
    writeCache: load.writeCache,
  });
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
      // The status, not the sentence: a release URL can carry the digits of a
      // status code in its own version, and a body-derived message can carry
      // any of them.
      if (error.status === 404) {
        throw new RuntimeAssetMissingError(`Could not download ${url}: ${error.message}.`);
      }
      throw new RuntimeAssetLoadError(`Could not download ${url}: ${error.message}.`, {
        unreachable: isUnreachableFailure(error),
      });
    }
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
