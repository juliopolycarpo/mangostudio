/**
 * Produces a runtime binary on the hub's own filesystem for a container to
 * mount.
 *
 * Containers are the one target the hub does not push bytes to: it mounts them.
 * So this needs a *path*, where WSL and SSH need the bytes themselves — which is
 * the only reason this file exists rather than the connector calling
 * {@link loadRuntimeReleaseBytes} directly.
 *
 * Everything about *which* bytes is delegated. The channel-aware resolver
 * decides the tag and asset name, the rolling guardrails decide whether a
 * cached copy may satisfy a canary version, and the checksum is verified
 * against the release before any of it reaches disk. A second fetch path here
 * would be a second place for those rules to be forgotten.
 *
 * One cache, the documented one: `~/.mango/runtime-cache/<version>/`, pruned by
 * the rule that already prunes it and reported by the `doctor` check that
 * already reports it.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LinuxPlatformId } from '@mangostudio/shared/runtime-home';
import { getHomeMangoDir, getVersion, isDevelopmentVersion } from '../../../lib/config';
import { getRuntimeBaseDir } from '../../../lib/runtime-paths';
import { loadRuntimeReleaseBytes, RuntimeAssetLoadError } from './runtime-release-fetch';
import { resolveRuntimeRelease } from './runtime-release-resolution';
import { localRuntimeBuildCommand, localRuntimeBuildPath } from './wsl-runtime-release';

export class ContainerRuntimeSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerRuntimeSourceError';
  }
}

export interface ContainerRuntimeSourceDeps {
  readonly version: string;
  readonly mangoHome: string;
  readonly baseDir: string;
  readonly loadBytes: typeof loadRuntimeReleaseBytes;
  readonly fileExists: (path: string) => Promise<boolean>;
  readonly writeBinary: (path: string, bytes: Uint8Array) => Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Writes the binary and marks it executable.
 *
 * The mount is read-only inside the container, but the bit has to be set on the
 * host side: a file the hub wrote without it is mounted just as unexecutable,
 * and the container fails with a permission error that says nothing about why.
 *
 * Written to a sibling temp file and renamed into place rather than truncated
 * in place: `path` may already be bind-mounted and running as another
 * container's entrypoint, and truncating that inode fails the host-side write
 * with `ETXTBSY`. A rename swaps the directory entry instead, so a container
 * launched from the old bytes keeps them and a new launch sees the new ones.
 */
async function writeExecutable(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, bytes, { mode: 0o755 });
  // `writeFile`'s mode applies only when it creates the file, which `tmp`
  // always is, but a restrictive umask can still strip the bit.
  await chmod(tmp, 0o755);
  await rename(tmp, path);
}

const defaultDeps: ContainerRuntimeSourceDeps = {
  get version() {
    return getVersion();
  },
  get mangoHome() {
    return getHomeMangoDir();
  },
  get baseDir() {
    return getRuntimeBaseDir();
  },
  loadBytes: loadRuntimeReleaseBytes,
  fileExists: exists,
  writeBinary: writeExecutable,
};

/**
 * Host path of a runtime binary that runs on `platformId`.
 *
 * A source checkout has no release to fetch from and never will, so it uses
 * what the checkout built for itself — the same `.mango/out/<platform>/` pipe-in
 * WSL provisioning uses. When there is no such build the refusal names the one
 * command that produces it, because "no runtime available" with no next step is
 * the least useful thing this could say.
 */
export async function resolveContainerRuntimeBinary(
  platformId: LinuxPlatformId,
  overrides: Partial<ContainerRuntimeSourceDeps> = {}
): Promise<string> {
  const deps = { ...defaultDeps, ...overrides };

  if (isDevelopmentVersion(deps.version)) {
    const built = localRuntimeBuildPath(deps.baseDir, platformId);
    if (await deps.fileExists(built)) return built;
    throw new ContainerRuntimeSourceError(
      `This checkout has no ${platformId} runtime to mount into the container. Build one with: ${localRuntimeBuildCommand(platformId, built)}`
    );
  }

  const release = resolveRuntimeRelease(deps.version, platformId);
  const cached = join(deps.mangoHome, 'runtime-cache', deps.version, release.runtimeAssetName);

  let asset: Awaited<ReturnType<typeof loadRuntimeReleaseBytes>>;
  try {
    asset = await deps.loadBytes(platformId);
  } catch (error) {
    throw new ContainerRuntimeSourceError(
      error instanceof RuntimeAssetLoadError
        ? `Could not get a ${platformId} runtime for release ${deps.version}: ${error.message}`
        : String(error)
    );
  }

  // The archive fallback exists for releases published before raw assets did.
  // A hub only ever fetches its own version, so reaching it means this release
  // has no raw runtime for this platform — an image on an architecture the
  // channel does not publish. Extracting a tar member here to mount it would be
  // a second unpack path for one impossible-by-construction case.
  if (asset.fromArchive) {
    throw new ContainerRuntimeSourceError(
      `Release ${deps.version} publishes no standalone ${platformId} runtime, only a platform archive. Use an image whose platform this release builds for.`
    );
  }

  // Written rather than assumed present: the fetch caches on a best-effort
  // basis, and a mount source that may or may not be there is not a source.
  await deps.writeBinary(cached, asset.bytes);
  return cached;
}
