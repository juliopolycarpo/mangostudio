/**
 * Puts a matching Linux runtime inside a WSL distribution.
 *
 * The hub and the runtime ship from one release and the handshake refuses a
 * mismatched pair, so this is version-pinned by construction: it fetches the
 * archive for the hub's own version, verifies it against that release's
 * `SHA256SUMS`, and caches it under `~/.mango/runtime-cache/<version>/` so a
 * second distribution — or a re-provision after the hub updates — costs one
 * spawn instead of another download.
 *
 * The bytes never touch the distribution's filesystem as an archive: they are
 * piped into `tar` on stdin, which avoids writing through the 9P share and
 * leaves nothing to clean up if the transfer dies halfway.
 *
 * A hub running from a source checkout reports `dev`, which names no release
 * and never will, so it installs the Linux runtime the checkout built for
 * itself instead of asking GitHub for a tag that cannot exist.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHomeMangoDir, getVersion, isDevelopmentVersion } from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getRuntimeBaseDir } from '../../../lib/runtime-paths';
import { type SafeFetchDeps, SafeFetchError, safeFetchBytes } from '../../../lib/safe-fetch';
import {
  DISTRO_RUNTIME_PATH,
  type DistroPlatformProbe,
  findReleaseChecksum,
  INSTALL_ARCHIVE_SCRIPT,
  INSTALL_BINARY_SCRIPT,
  type LinuxPlatformId,
  localRuntimeBuildCommand,
  localRuntimeBuildPath,
  PLATFORM_PROBE_SCRIPT,
  releaseArchiveName,
  releaseAssetUrl,
  resolveLinuxPlatformId,
  VERSION_SCRIPT,
} from '../domain/wsl-runtime-release';

/** Platform archives are tens of megabytes; the cap is generous but finite. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 64 * 1024;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_REDIRECTS = 5;
/** Booting a stopped distribution is part of the first command's cost. */
const DISTRO_COMMAND_TIMEOUT_MS = 120_000;
const MAX_DISTRO_OUTPUT_BYTES = 64 * 1024;

const logger = createDiagnosticLogger('wsl-provisioner');

export class WslProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WslProvisioningError';
  }
}

/**
 * Failing to *reach* the release, as opposed to reaching one that has nothing
 * to offer. Only this one has an offline answer worth printing.
 */
class WslDownloadError extends WslProvisioningError {}

export interface DistroCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** Set when the command was killed rather than exiting, which a timeout does. */
  readonly signal?: string;
}

export interface WslProvisionerDeps extends SafeFetchDeps {
  /** Runs a shell script inside a distribution, optionally feeding it stdin. */
  runInDistro(
    distro: string,
    script: string,
    options?: { readonly stdin?: Uint8Array }
  ): Promise<DistroCommandResult>;
  /** Reads a file the hub only hopes is there, hence the null rather than a throw. */
  readBytes(path: string): Promise<Uint8Array | null>;
  writeCache(path: string, bytes: Uint8Array): Promise<void>;
  cacheDir(version: string): string;
  /** Where this checkout's own Linux runtime build would be. */
  localBuildPath(platformId: LinuxPlatformId): string;
  version(): string;
}

export interface WslProvisioner {
  /**
   * Leaves `distro` holding a runtime that matches this hub, installing one
   * when it is absent and replacing one left behind by an older release.
   */
  ensure(distro: string): Promise<void>;
}

export function createWslProvisioner(overrides: Partial<WslProvisionerDeps> = {}): WslProvisioner {
  const deps: WslProvisionerDeps = { ...defaultDeps, ...overrides };

  return {
    async ensure(distro: string): Promise<void> {
      const version = deps.version();
      // A hub update leaves behind a binary the handshake would refuse, so
      // drift is answered by reinstalling rather than by an error the user has
      // no action for. A binary built for another architecture fails this the
      // same way an absent one does, which is the same answer: install it.
      const present = await deps.runInDistro(distro, VERSION_SCRIPT);
      if (present.exitCode === 0 && present.stdout.trim() === version) return;

      const platformId = await install(deps, distro, version);

      const installed = await deps.runInDistro(distro, VERSION_SCRIPT);
      if (installed.exitCode !== 0) {
        throw new WslProvisioningError(
          `The runtime was placed in "${distro}" but does not run there: ${describe(installed)}`
        );
      }
      if (installed.stdout.trim() !== version) {
        const mismatch = `The runtime installed in "${distro}" reports version ${installed.stdout.trim()} rather than ${version}.`;
        // The likely cause in a checkout is a runtime compiled by
        // `bun run build:binary`, which stamps the package version into what it
        // builds — right for a release, wrong for a hub that reports `dev`.
        throw new WslProvisioningError(
          isDevelopmentVersion(version)
            ? `${mismatch} A checkout's runtime has to be compiled without a version stamp: \`${localRuntimeBuildCommand(platformId, deps.localBuildPath(platformId))}\`.`
            : mismatch
        );
      }
      logger.info('provisioned', { distro, version });
    },
  };
}

/** Returns the target the distribution was provisioned for, which the caller reports against. */
async function install(
  deps: WslProvisionerDeps,
  distro: string,
  version: string
): Promise<LinuxPlatformId> {
  const platformId = resolveLinuxPlatformId(await probePlatform(deps, distro));
  if (!platformId) {
    throw new WslProvisioningError(
      `Could not tell which Linux build "${distro}" needs. Only x86-64 and arm64 distributions are supported.`
    );
  }

  // A checkout's version names no release, so asking one for assets can only
  // 404: the answer there is the build the developer already has, taken whole
  // rather than out of an archive nobody published.
  const source = isDevelopmentVersion(version)
    ? { script: INSTALL_BINARY_SCRIPT, bytes: await loadLocalBuild(deps, distro, platformId) }
    : {
        script: INSTALL_ARCHIVE_SCRIPT,
        bytes: await loadRelease(deps, distro, version, platformId),
      };

  const result = await deps.runInDistro(distro, source.script, { stdin: source.bytes });
  if (result.exitCode !== 0) {
    throw new WslProvisioningError(
      `Could not unpack the runtime inside "${distro}": ${describe(result)}`
    );
  }
  return platformId;
}

async function loadRelease(
  deps: WslProvisionerDeps,
  distro: string,
  version: string,
  platformId: LinuxPlatformId
): Promise<Uint8Array> {
  const assetName = releaseArchiveName(version, platformId);
  // Getting the bytes is the step that needs the network, so it is the step
  // with an offline answer. A hub that cannot reach the release should say what
  // to do about it rather than only what went wrong.
  return await loadArchive(deps, version, assetName).catch((error: unknown) => {
    if (error instanceof WslDownloadError) {
      throw new WslProvisioningError(
        `${error.message} ${manualInstallHint(deps, distro, version, assetName)}`
      );
    }
    throw error;
  });
}

/**
 * The runtime a source checkout provides for itself. Compiling it is left to
 * the developer rather than done here: it is a one-line `bun build` they can
 * see the output of, and it is the same command whether or not WSL is involved.
 *
 * Nothing is verified against a checksum because there is nothing to verify
 * against — the file came from this machine, not from a release.
 */
async function loadLocalBuild(
  deps: WslProvisionerDeps,
  distro: string,
  platformId: LinuxPlatformId
): Promise<Uint8Array> {
  const path = deps.localBuildPath(platformId);
  const bytes = await deps.readBytes(path);
  if (bytes) return bytes;

  throw new WslProvisioningError(
    'This MangoStudio runs from a source checkout, so no release carries a Linux runtime ' +
      `to install. Build one from the repository root with \`${localRuntimeBuildCommand(platformId, path)}\` ` +
      `and connect again, or put a runtime that reports version dev at ${DISTRO_RUNTIME_PATH} ` +
      `inside "${distro}" yourself.`
  );
}

/**
 * The two ways out when the release cannot be reached: drop the archive where
 * the cache would have put it and reconnect, or place the binary in the
 * distribution directly. Both are named because a hub behind a proxy, on an air
 * gap, or on a release whose assets were pulled has no other move.
 */
function manualInstallHint(
  deps: WslProvisionerDeps,
  distro: string,
  version: string,
  assetName: string
): string {
  return (
    `Either download ${releaseAssetUrl(version, assetName)} to ` +
    `${join(deps.cacheDir(version), assetName)} on this host and connect again, ` +
    `or put the ${version} runtime at ${DISTRO_RUNTIME_PATH} inside "${distro}" yourself.`
  );
}

async function probePlatform(
  deps: WslProvisionerDeps,
  distro: string
): Promise<DistroPlatformProbe> {
  const result = await deps.runInDistro(distro, PLATFORM_PROBE_SCRIPT);
  if (result.exitCode !== 0) {
    throw new WslProvisioningError(
      `Could not start the "${distro}" distribution: ${describe(result)}`
    );
  }
  const [machine = '', libc = ''] = result.stdout.trim().split(/\r?\n/);
  return { machine, libc };
}

/**
 * Returns the verified archive bytes, downloading them only when the cache does
 * not already hold a copy whose digest matches the release.
 */
async function loadArchive(
  deps: WslProvisionerDeps,
  version: string,
  assetName: string
): Promise<Uint8Array> {
  const cachePath = join(deps.cacheDir(version), assetName);
  const expected = await fetchExpectedChecksum(deps, version, assetName);

  const cached = await deps.readBytes(cachePath);
  if (cached && sha256(cached) === expected) return cached;

  const bytes = await download(deps, releaseAssetUrl(version, assetName), MAX_ARCHIVE_BYTES);
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new WslProvisioningError(
      `The downloaded ${assetName} does not match the checksum published for this release. Expected ${expected}, got ${actual}.`
    );
  }

  // Caching is a courtesy, not part of the contract: a hub that cannot write
  // here still provisions, it just pays for the download again next time.
  await deps.writeCache(cachePath, bytes).catch((error: unknown) => {
    logger.warn('cache_write_failed', { path: cachePath, error: String(error) });
  });
  return bytes;
}

async function fetchExpectedChecksum(
  deps: WslProvisionerDeps,
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
    throw new WslProvisioningError(
      `Release v${version} does not publish ${assetName}, so there is no Linux runtime to install. Update MangoStudio, or put a matching runtime at ${DISTRO_RUNTIME_PATH} in the distribution yourself.`
    );
  }
  return expected;
}

async function download(
  deps: WslProvisionerDeps,
  url: string,
  maxBytes: number
): Promise<Uint8Array> {
  try {
    const result = await safeFetchBytes(
      url,
      { maxBytes, maxRedirects: MAX_REDIRECTS, timeoutMs: DOWNLOAD_TIMEOUT_MS },
      deps
    );
    return result.bytes;
  } catch (error) {
    if (error instanceof SafeFetchError) {
      throw new WslDownloadError(`Could not download ${url}: ${error.message}.`);
    }
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function describe(result: DistroCommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  // A killed command usually says nothing at all, and "exited with code -1" is
  // the least useful thing to tell someone whose distribution took too long to
  // boot — which is the cause this timeout exists for.
  if (result.signal) {
    const cause = `it was stopped by ${result.signal} after ${DISTRO_COMMAND_TIMEOUT_MS / 1000}s`;
    return detail ? `${detail} (${cause})` : cause;
  }
  return detail || `the command exited with code ${result.exitCode}`;
}

/**
 * Runs one script through the distribution's `sh`. The distribution name is an
 * argv entry and the script is a constant, so nothing user-supplied is ever
 * parsed as shell.
 */
function runInDistroWithWsl(
  distro: string,
  script: string,
  options: { readonly stdin?: Uint8Array } = {}
): Promise<DistroCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', ['-d', distro, '--exec', 'sh', '-c', script], {
      stdio: 'pipe',
      windowsHide: true,
      timeout: DISTRO_COMMAND_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    // Every other failure here arrives as a `WslProvisioningError` carrying
    // something the user can act on, and a host with WSL support but no
    // `wsl.exe` on the hub's PATH is the one spawn failure worth naming.
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        new WslProvisioningError(
          error.code === 'ENOENT'
            ? 'Could not run "wsl.exe". WSL is not installed on this host, or it is not on the PATH MangoStudio was started with.'
            : `Could not run "wsl.exe": ${error.message}`
        )
      );
    });
    child.on('close', (code, signal) =>
      resolve({ stdout, stderr, exitCode: code ?? -1, ...(signal ? { signal } : {}) })
    );

    // The archive is written before stdin closes, which is the end-of-input tar
    // waits for. An early exit surfaces as EPIPE and is already reported by the
    // exit code, so it must not also become an unhandled error.
    child.stdin.on('error', () => undefined);
    if (options.stdin) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}

function appendBounded(current: string, chunk: Buffer): string {
  if (current.length >= MAX_DISTRO_OUTPUT_BYTES) return current;
  return (current + chunk.toString('utf8')).slice(0, MAX_DISTRO_OUTPUT_BYTES);
}

const defaultDeps: WslProvisionerDeps = {
  fetch,
  runInDistro: runInDistroWithWsl,
  readBytes: (path) => readFile(path).catch(() => null),
  writeCache: async (path, bytes) => {
    await mkdir(join(path, '..'), { recursive: true });
    // A reader that opens the cache while it is being written would see a
    // truncated archive and fail its digest check; renaming publishes it whole.
    const staging = `${path}.partial`;
    await writeFile(staging, bytes);
    await rename(staging, path);
  },
  cacheDir: (version) => join(getHomeMangoDir(), 'runtime-cache', version),
  localBuildPath: (platformId) => localRuntimeBuildPath(getRuntimeBaseDir(), platformId),
  version: getVersion,
};

export const wslProvisioner = createWslProvisioner();
