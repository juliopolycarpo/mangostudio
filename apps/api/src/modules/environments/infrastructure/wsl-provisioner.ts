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
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHomeMangoDir, getVersion } from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';
import { type SafeFetchDeps, SafeFetchError, safeFetchBytes } from '../../../lib/safe-fetch';
import {
  type DistroPlatformProbe,
  findReleaseChecksum,
  INSTALL_SCRIPT,
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

export interface DistroCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface WslProvisionerDeps extends SafeFetchDeps {
  /** Runs a shell script inside a distribution, optionally feeding it stdin. */
  runInDistro(
    distro: string,
    script: string,
    options?: { readonly stdin?: Uint8Array }
  ): Promise<DistroCommandResult>;
  readCache(path: string): Promise<Uint8Array | null>;
  writeCache(path: string, bytes: Uint8Array): Promise<void>;
  cacheDir(version: string): string;
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

      await install(deps, distro, version);

      const installed = await deps.runInDistro(distro, VERSION_SCRIPT);
      if (installed.exitCode !== 0) {
        throw new WslProvisioningError(
          `The runtime was placed in "${distro}" but does not run there: ${describe(installed)}`
        );
      }
      if (installed.stdout.trim() !== version) {
        throw new WslProvisioningError(
          `The runtime installed in "${distro}" reports version ${installed.stdout.trim()} rather than ${version}.`
        );
      }
      logger.info('provisioned', { distro, version });
    },
  };
}

async function install(deps: WslProvisionerDeps, distro: string, version: string): Promise<void> {
  const platformId = resolveLinuxPlatformId(await probePlatform(deps, distro));
  if (!platformId) {
    throw new WslProvisioningError(
      `Could not tell which Linux build "${distro}" needs. Only x86-64 and arm64 distributions are supported.`
    );
  }

  const assetName = releaseArchiveName(version, platformId);
  const archive = await loadArchive(deps, version, assetName);

  const result = await deps.runInDistro(distro, INSTALL_SCRIPT, { stdin: archive });
  if (result.exitCode !== 0) {
    throw new WslProvisioningError(
      `Could not unpack the runtime inside "${distro}": ${describe(result)}`
    );
  }
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

  const cached = await deps.readCache(cachePath);
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
      `Release v${version} does not publish ${assetName}, so there is no Linux runtime to install. Update MangoStudio, or install the runtime in the distribution by hand.`
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
      throw new WslProvisioningError(`Could not download ${url}: ${error.message}`);
    }
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function describe(result: DistroCommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
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
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));

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
  readCache: (path) => readFile(path).catch(() => null),
  writeCache: async (path, bytes) => {
    await mkdir(join(path, '..'), { recursive: true });
    // A reader that opens the cache while it is being written would see a
    // truncated archive and fail its digest check; renaming publishes it whole.
    const staging = `${path}.partial`;
    await writeFile(staging, bytes);
    await rename(staging, path);
  },
  cacheDir: (version) => join(getHomeMangoDir(), 'runtime-cache', version),
  version: getVersion,
};

export const wslProvisioner = createWslProvisioner();
