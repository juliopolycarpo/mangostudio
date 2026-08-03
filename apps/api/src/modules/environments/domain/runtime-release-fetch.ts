/**
 * Downloads a release runtime asset (raw preferred, archive fallback) into the
 * hub cache. Shared by WSL provisioning and SSH push so both transports verify
 * the same SHA256SUMS line before any remote write.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getHomeMangoDir, getVersion, isDevelopmentVersion } from '../../../lib/config';
import { getRuntimeBaseDir } from '../../../lib/runtime-paths';
import { type SafeFetchDeps, SafeFetchError, safeFetchBytes } from '../../../lib/safe-fetch';
import {
  findReleaseChecksum,
  localRuntimeBuildPath,
  releaseArchiveName,
  releaseAssetUrl,
  releaseRuntimeBinaryName,
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
}

export async function loadRuntimeReleaseBytes(
  platformId: string,
  overrides: Partial<SafeFetchDeps> & {
    readonly version?: string;
    readonly cacheDir?: (version: string) => string;
    readonly readBytes?: (path: string) => Promise<Uint8Array | null>;
    readonly writeCache?: (path: string, bytes: Uint8Array) => Promise<void>;
    readonly localBuildPath?: (platformId: string) => string;
  } = {}
): Promise<LoadedRuntimeAsset> {
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
    return { bytes, fromArchive: false, digest: `sha256:${sha256(bytes)}` };
  }

  const deps: SafeFetchDeps = { fetch: overrides.fetch ?? globalThis.fetch };
  try {
    const bytes = await loadAsset(
      deps,
      version,
      releaseRuntimeBinaryName(version, platformId),
      cacheDir,
      readBytes,
      writeCache
    );
    return { bytes, fromArchive: false, digest: `sha256:${sha256(bytes)}` };
  } catch (error) {
    if (!(error instanceof RuntimeAssetMissingError)) throw error;
  }

  const bytes = await loadAsset(
    deps,
    version,
    releaseArchiveName(version, platformId),
    cacheDir,
    readBytes,
    writeCache
  );
  return { bytes, fromArchive: true, digest: `sha256:${sha256(bytes)}` };
}

class RuntimeAssetMissingError extends RuntimeAssetLoadError {}

async function loadAsset(
  deps: SafeFetchDeps,
  version: string,
  assetName: string,
  cacheDir: (version: string) => string,
  readBytes: (path: string) => Promise<Uint8Array | null>,
  writeCache: (path: string, bytes: Uint8Array) => Promise<void>
): Promise<Uint8Array> {
  const cachePath = join(cacheDir(version), assetName);
  const expected = await fetchExpectedChecksum(deps, version, assetName);
  const cached = await readBytes(cachePath);
  if (cached && sha256(cached) === expected) return cached;

  const bytes = await download(deps, releaseAssetUrl(version, assetName), MAX_ARCHIVE_BYTES);
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new RuntimeAssetLoadError(
      `The downloaded ${assetName} does not match the checksum published for this release.`
    );
  }
  await writeCache(cachePath, bytes).catch(() => undefined);
  return bytes;
}

async function fetchExpectedChecksum(
  deps: SafeFetchDeps,
  version: string,
  assetName: string
): Promise<string> {
  const checksums = await download(
    deps,
    releaseAssetUrl(version, 'SHA256SUMS'),
    MAX_CHECKSUMS_BYTES
  );
  const expected = findReleaseChecksum(new TextDecoder().decode(checksums), assetName);
  if (!expected) {
    throw new RuntimeAssetMissingError(`Release v${version} does not publish ${assetName}.`);
  }
  return expected;
}

async function download(deps: SafeFetchDeps, url: string, maxBytes: number): Promise<Uint8Array> {
  try {
    const result = await safeFetchBytes(
      url,
      { maxBytes, maxRedirects: MAX_REDIRECTS, timeoutMs: DOWNLOAD_TIMEOUT_MS },
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
