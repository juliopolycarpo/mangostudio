/**
 * Puts a matching Linux runtime inside a WSL distribution.
 *
 * The hub and the runtime ship from one release and the handshake refuses a
 * mismatched pair, so this is version-pinned by construction: it fetches the
 * raw runtime asset for the hub's own version (falling back to the platform
 * archive for older releases), verifies it against that release's
 * `SHA256SUMS`, and caches it under `~/.mango/runtime-cache/<version>/` so a
 * second distribution — or a re-provision after the hub updates — costs one
 * spawn instead of another download.
 *
 * The bytes never touch the distribution's filesystem as an archive: they are
 * piped into the install script on stdin, which avoids writing through the 9P
 * share and leaves nothing to clean up if the transfer dies halfway. The
 * stage-verify-publish sequence lives in `runtime-push.ts`.
 *
 * A hub running from a source checkout reports `dev`, which names no release
 * and never will, so it installs the Linux runtime the checkout built for
 * itself instead of asking GitHub for a tag that cannot exist.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { getHomeMangoDir, getVersion, isDevelopmentVersion } from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getRuntimeBaseDir } from '../../../lib/runtime-paths';
import { type SafeFetchDeps, SafeFetchError, safeFetchBytes } from '../../../lib/safe-fetch';
import {
  pushRuntimeBinary,
  type RuntimeCommandOptions,
  type RuntimeCommandResult,
  RuntimePushError,
  runtimeRemoveSlotBytesScript,
  runtimeSlotBytesScript,
} from '../domain/runtime-push';
import { pruneRuntimeCache } from '../domain/runtime-release-fetch';
import {
  type RuntimeReleaseResolution,
  resolveRuntimeRelease,
} from '../domain/runtime-release-resolution';
import {
  CONFIG_LOCK_BUSY_EXIT,
  DISTRO_RUNTIME_PATH,
  type DistroPlatformProbe,
  type DistroSlotProbe,
  distroRuntimeConfigAfterInstall,
  findReleaseChecksum,
  LEGACY_DISTRO_RUNTIME_PATH,
  type LinuxPlatformId,
  localRuntimeBuildCommand,
  localRuntimeBuildPath,
  PLATFORM_PROBE_SCRIPT,
  PROBE_SLOT_SCRIPT,
  parseDistroSlotProbe,
  REMOVE_LEGACY_RUNTIME_SCRIPT,
  releaseArchiveName,
  releaseAssetUrl,
  resolveLinuxPlatformId,
  SETUP_FULL_SCRIPT,
  VERSION_SCRIPT,
  WRITE_CONFIG_SCRIPT,
} from '../domain/wsl-runtime-release';

/** Platform archives / raw binaries are tens of megabytes; the cap is generous but finite. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 64 * 1024;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_REDIRECTS = 5;
/** Booting a stopped distribution is part of the first command's cost. */
const DISTRO_COMMAND_TIMEOUT_MS = 120_000;
/** A ~95 MB push to a cold distro needs more than the default probe timeout. */
const DISTRO_INSTALL_TIMEOUT_MS = 600_000;
const MAX_DISTRO_OUTPUT_BYTES = 64 * 1024;
const STDIN_CHUNK_BYTES = 64 * 1024;

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

export type DistroCommandResult = RuntimeCommandResult;

export interface WslProvisionerDeps extends SafeFetchDeps {
  /**
   * Runs a shell script inside a distribution, optionally feeding it stdin and
   * positional arguments. Every script is a constant and every value that
   * varies — a distribution name, a version — travels as an argv entry.
   */
  runInDistro(
    distro: string,
    script: string,
    options?: RuntimeCommandOptions
  ): Promise<DistroCommandResult>;
  /** Reads a file the hub only hopes is there, hence the null rather than a throw. */
  readBytes(path: string): Promise<Uint8Array | null>;
  writeCache(path: string, bytes: Uint8Array): Promise<void>;
  cacheDir(version: string): string;
  /** Where this checkout's own Linux runtime build would be. */
  localBuildPath(platformId: LinuxPlatformId): string;
  version(): string;
  /** Name this hub records as the installer, for the config it writes. */
  hubHost(): string;
}

export interface WslProvisioner {
  /**
   * Leaves `distro` holding a runtime that matches this hub, installing one
   * when it is absent and replacing one left behind by an older release.
   */
  ensure(
    distro: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly force?: boolean;
      /**
       * Byte progress for the install stream. A ~95 MB push across the 9P share
       * into a cold distribution is the slowest transfer this hub performs; a
       * caller with a console to fill passes this so it is a progress bar
       * rather than a silent minute.
       */
      readonly onTransferProgress?: (written: number, total: number) => void;
    }
  ): Promise<void>;
  /** Removes version dirs and `current`; leaves consent (`runtime.json`) alone. */
  removeSlotBytes(distro: string): Promise<void>;
  /**
   * Approximate byte size of the `wsl` slot, for the removal dialog's byte
   * count. Not called on every card poll — a cold distro boot is too
   * expensive for that — only when a caller explicitly asks (018/020's
   * removal confirmation).
   */
  slotBytes(distro: string): Promise<number | null>;
}

export function createWslProvisioner(overrides: Partial<WslProvisionerDeps> = {}): WslProvisioner {
  const deps: WslProvisionerDeps = { ...defaultDeps, ...overrides };

  return {
    async ensure(distro, options = {}) {
      const signal = options.signal;
      if (signal?.aborted) {
        throw new WslProvisioningError(`Runtime provision for "${distro}" was cancelled.`);
      }
      const version = deps.version();
      const slot = parseDistroSlotProbe(
        (await deps.runInDistro(distro, PROBE_SLOT_SCRIPT, { signal })).stdout
      );
      const recorded = slot.config?.version === version;
      // Asked at most once: the answer is deterministic, and every question put
      // to a stopped distribution pays for booting it.
      let runs: boolean | null = null;
      const stillRuns = async (): Promise<boolean> =>
        (runs ??= await runsVersion(deps, distro, version, signal));

      // Version equality settles it for a release: a published tag's bytes
      // never change, so a distribution holding that version holds these bytes.
      // Canary counts as a release here — its version carries the source sha,
      // so what the slot recorded still names one build, even though the tag
      // those bytes came from has since been clobbered.
      // Reinstall forces a replace even when the version already matches.
      if (!options.force && recorded && !isDevelopmentVersion(version) && (await stillRuns()))
        return;

      const platformId = resolvePlatformId(await probePlatform(deps, distro, signal), distro);
      const source = await loadSource(deps, distro, version, platformId);
      if (signal?.aborted) {
        throw new WslProvisioningError(`Runtime provision for "${distro}" was cancelled.`);
      }
      const digest = `sha256:${sha256(source.bytes)}`;

      // A checkout rebuilds under the same `dev` name, so nothing but the
      // digest can tell one build from another — and that is the hole this
      // closes: a rebuilt runtime used to stay on the hub forever, because the
      // distribution's copy also called itself `dev`.
      if (!options.force && recorded && slot.config?.digest === digest && (await stillRuns()))
        return;

      await install(deps, distro, version, platformId, source, signal, options.onTransferProgress);
      await recordInstall(deps, distro, version, slot, digest);
      // First provision only: an upgrade replaces bytes, never the answer
      // somebody gave about what a hub may do inside this distribution. A
      // config that could not be read is neither case — `recordInstall` left
      // the gate closed, and somebody at the machine answers it again.
      if (!(slot.config?.setup || slot.unreadable)) await grantConsent(deps, distro);
      await removeLegacyRuntime(deps, distro);
      logger.info('provisioned', { distro, version });
    },
    async removeSlotBytes(distro: string): Promise<void> {
      const result = await deps.runInDistro(distro, runtimeRemoveSlotBytesScript('wsl'));
      if (result.exitCode !== 0) {
        throw new WslProvisioningError(
          `Could not remove the runtime from "${distro}": ${describe(result)}`
        );
      }
    },
    async slotBytes(distro: string): Promise<number | null> {
      const result = await deps.runInDistro(distro, runtimeSlotBytesScript('wsl'));
      if (result.exitCode !== 0) return null;
      const parsed = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(parsed) ? parsed : null;
    },
  };
}

function resolvePlatformId(probe: DistroPlatformProbe, distro: string): LinuxPlatformId {
  const platformId = resolveLinuxPlatformId(probe);
  if (!platformId) {
    throw new WslProvisioningError(
      `Could not tell which Linux build "${distro}" needs. Only x86-64 and arm64 distributions are supported.`
    );
  }
  return platformId;
}

/**
 * The bytes to push and whether they arrive as a raw binary or a platform archive.
 *
 * A checkout's version names no release, so asking one for assets can only
 * 404: the answer there is the build the developer already has, taken whole
 * rather than out of an archive nobody published.
 */
async function loadSource(
  deps: WslProvisionerDeps,
  distro: string,
  version: string,
  platformId: LinuxPlatformId
): Promise<{ readonly fromArchive: boolean; readonly bytes: Uint8Array }> {
  return isDevelopmentVersion(version)
    ? { fromArchive: false, bytes: await loadLocalBuild(deps, distro, platformId) }
    : await loadRelease(deps, distro, version, platformId);
}

/**
 * Whether the installed binary runs and says what the config claims.
 *
 * The config recording a version proves what was written, not that it survived:
 * a distribution whose runtime was deleted or built for another architecture
 * needs the answer "install one" rather than a launch failure later.
 */
async function runsVersion(
  deps: WslProvisionerDeps,
  distro: string,
  version: string,
  signal?: AbortSignal
): Promise<boolean> {
  const present = await deps.runInDistro(distro, VERSION_SCRIPT, { signal });
  return present.exitCode === 0 && present.stdout.trim() === version;
}

/** Places the bytes and confirms what landed actually runs as this version. */
async function install(
  deps: WslProvisionerDeps,
  distro: string,
  version: string,
  platformId: LinuxPlatformId,
  source: { readonly fromArchive: boolean; readonly bytes: Uint8Array },
  signal?: AbortSignal,
  onTransferProgress?: (written: number, total: number) => void
): Promise<void> {
  try {
    await pushRuntimeBinary({
      runner: (script, options) =>
        deps.runInDistro(distro, script, { ...options, signal: options?.signal ?? signal }),
      slot: 'wsl',
      version,
      bytes: source.bytes,
      fromArchive: source.fromArchive,
      timeoutMs: DISTRO_INSTALL_TIMEOUT_MS,
      signal,
      ...(onTransferProgress
        ? {
            onStdinProgress: (written: number) =>
              onTransferProgress(written, source.bytes.byteLength),
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof RuntimePushError) {
      let message = error.message
        .replace(
          'Could not place the runtime in the wsl slot',
          `Could not unpack the runtime inside "${distro}"`
        )
        .replace(
          'The runtime was placed in the wsl slot but does not run',
          `The runtime was placed in "${distro}" but does not run there`
        )
        .replace(
          `The runtime in the wsl slot reports version`,
          `The runtime installed in "${distro}" reports version`
        );
      if (isDevelopmentVersion(version) && message.includes('reports version')) {
        message = `${message} A checkout's runtime has to be compiled without a version stamp: \`${localRuntimeBuildCommand(platformId, deps.localBuildPath(platformId))}\`.`;
      }
      throw new WslProvisioningError(message);
    }
    throw error;
  }
}

/**
 * Writes down what was installed, keeping whatever the distribution already
 * said about consent. Not fatal on its own: a distribution that holds the right
 * binary but could not record it still runs, it just re-provisions next time.
 *
 * The consent it carries forward is re-read here rather than taken from the
 * probe `ensure` started with. That probe happened before a download and an
 * extraction — minutes, on a first provision — and anything somebody answered
 * inside the distribution in between would be written back out as the older
 * answer. Re-reading costs one round trip and leaves a window of exactly that
 * round trip, which the lock the write itself takes then covers.
 */
async function recordInstall(
  deps: WslProvisionerDeps,
  distro: string,
  version: string,
  installed: DistroSlotProbe,
  digest: string
): Promise<void> {
  const slot = await reprobeSlot(deps, distro, installed);
  const config = distroRuntimeConfigAfterInstall({
    stored: slot.config,
    home: slot.home,
    version,
    digest,
    hubVersion: deps.version(),
    hubHost: deps.hubHost(),
    at: new Date().toISOString(),
    armGate: slot.unreadable,
  });
  if (slot.unreadable) {
    logger.warn('consent_unreadable', { distro });
  }

  const result = await deps.runInDistro(distro, WRITE_CONFIG_SCRIPT, {
    stdin: new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`),
  });
  if (result.exitCode === CONFIG_LOCK_BUSY_EXIT) {
    // Somebody inside the distribution is answering the consent question right
    // now. Their answer is the one that matters; these install facts are
    // rewritten on the next provision anyway.
    logger.warn('config_write_locked', { distro });
    return;
  }
  if (result.exitCode !== 0) {
    logger.warn('config_write_failed', { distro, detail: describe(result) });
  }
}

/**
 * The slot as it stands now, falling back to the pre-install read.
 *
 * A probe that fails here must not be read as "no config": that is the state
 * that lets the caller re-grant full consent, and the distribution demonstrably
 * had a runtime a moment ago. The earlier read is the better guess, and an
 * unreadable answer stays unreadable.
 */
async function reprobeSlot(
  deps: WslProvisionerDeps,
  distro: string,
  installed: DistroSlotProbe
): Promise<DistroSlotProbe> {
  try {
    const result = await deps.runInDistro(distro, PROBE_SLOT_SCRIPT);
    if (result.exitCode !== 0) return installed;
    const fresh = parseDistroSlotProbe(result.stdout);
    return fresh.home ? fresh : installed;
  } catch {
    return installed;
  }
}

async function grantConsent(deps: WslProvisionerDeps, distro: string): Promise<void> {
  const result = await deps.runInDistro(distro, SETUP_FULL_SCRIPT);
  if (result.exitCode !== 0) {
    throw new WslProvisioningError(
      `The runtime in "${distro}" could not record what it is allowed to do: ${describe(result)}`
    );
  }
}

/**
 * Deletes the unversioned binary #771 left at `~/.mango/bin`.
 *
 * Two runtimes in one distribution guarantee somebody eventually debugs the
 * wrong one, and the old path is unreleased, so there is nothing to migrate —
 * only something to remove. A failure here is logged rather than raised: the
 * distribution is provisioned either way.
 */
async function removeLegacyRuntime(deps: WslProvisionerDeps, distro: string): Promise<void> {
  const result = await deps.runInDistro(distro, REMOVE_LEGACY_RUNTIME_SCRIPT);
  if (result.exitCode !== 0) {
    logger.warn('legacy_runtime_removal_failed', { distro, detail: describe(result) });
    return;
  }
  if (result.stdout.includes('removed')) {
    logger.info('legacy_runtime_removed', { distro, path: LEGACY_DISTRO_RUNTIME_PATH });
  }
}

/**
 * Prefers the raw runtime asset; falls back to the platform archive when the
 * raw asset is missing from SHA256SUMS or 404s (older releases).
 *
 * Names and tag both come from the channel resolver rather than the hub's own
 * version string. A canary hub calls itself `<root>-canary.<sha7>` while the
 * rolling pre-release is tagged `v<root>-canary` and carries assets named for
 * the same rolling version — splicing the running version into either would
 * ask GitHub for a tag and a filename that no release ever published.
 */
async function loadRelease(
  deps: WslProvisionerDeps,
  distro: string,
  version: string,
  platformId: LinuxPlatformId
): Promise<{ readonly fromArchive: boolean; readonly bytes: Uint8Array }> {
  const release = resolveRuntimeRelease(version, platformId);
  const rawName = release.runtimeAssetName;
  const archiveName = releaseArchiveName(release.assetVersion, platformId);

  try {
    const bytes = await loadAsset(deps, version, release, rawName);
    return { fromArchive: false, bytes };
  } catch (error) {
    if (!(error instanceof WslAssetMissingError)) {
      if (error instanceof WslDownloadError) {
        throw new WslProvisioningError(
          `${error.message} ${manualInstallHint(deps, distro, version, release, rawName)}`
        );
      }
      throw error;
    }
  }

  try {
    const bytes = await loadAsset(deps, version, release, archiveName);
    return { fromArchive: true, bytes };
  } catch (error) {
    if (error instanceof WslDownloadError || error instanceof WslAssetMissingError) {
      throw new WslProvisioningError(
        `${error.message} ${manualInstallHint(deps, distro, version, release, archiveName)}`
      );
    }
    throw error;
  }
}

class WslAssetMissingError extends WslProvisioningError {}

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
  release: RuntimeReleaseResolution,
  assetName: string
): string {
  return (
    `Either download ${releaseAssetUrl(release.tagVersion, assetName)} to ` +
    `${join(deps.cacheDir(version), assetName)} on this host and connect again, ` +
    `or put the ${version} runtime at ${DISTRO_RUNTIME_PATH} inside "${distro}" yourself.`
  );
}

async function probePlatform(
  deps: WslProvisionerDeps,
  distro: string,
  signal?: AbortSignal
): Promise<DistroPlatformProbe> {
  const result = await deps.runInDistro(distro, PLATFORM_PROBE_SCRIPT, { signal });
  if (result.exitCode !== 0) {
    throw new WslProvisioningError(
      `Could not start the "${distro}" distribution: ${describe(result)}`
    );
  }
  // `PLATFORM_PROBE_SCRIPT` is a constant this hub just sent, so the shape is
  // known: kernel, machine, libc. Guessing an older two-line shape instead
  // would misread `uname -s` as the machine on any host whose `ldd` prints
  // nothing at all — the resolver would then reject a perfectly good target.
  const [kernel = '', machine = '', libc = ''] = result.stdout.trim().split(/\r?\n/);
  return { kernel, machine, libc };
}

/**
 * Returns the verified asset bytes, downloading them only when the cache does
 * not already hold a copy whose digest matches the release.
 */
async function loadAsset(
  deps: WslProvisionerDeps,
  version: string,
  release: RuntimeReleaseResolution,
  assetName: string
): Promise<Uint8Array> {
  // Cached under the hub's own version, downloaded from the resolved tag. On a
  // rolling channel those differ, and it is the difference that keeps two
  // canary builds in separate cache directories while both read one tag.
  const cachePath = join(deps.cacheDir(version), assetName);
  // Never cached, on any channel: the manifest is what decides whether the
  // bytes on disk are still the bytes this tag publishes. A rolling tag
  // republishes under one filename, so a cached copy of yesterday's canary is
  // only distinguishable from today's by failing this comparison.
  const expected = await fetchExpectedChecksum(deps, release.tagVersion, assetName);

  const cached = await deps.readBytes(cachePath);
  if (cached && sha256(cached) === expected) return cached;

  const bytes = await download(
    deps,
    releaseAssetUrl(release.tagVersion, assetName),
    MAX_ARCHIVE_BYTES
  );
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
  await pruneRuntimeCache(deps.cacheDir(version), version).catch((error: unknown) => {
    logger.warn('cache_prune_failed', { path: deps.cacheDir(version), error: String(error) });
  });
  return bytes;
}

async function fetchExpectedChecksum(
  deps: WslProvisionerDeps,
  tagVersion: string,
  assetName: string
): Promise<string> {
  const checksums = await download(
    deps,
    releaseAssetUrl(tagVersion, 'SHA256SUMS'),
    MAX_CHECKSUMS_BYTES
  );
  const expected = findReleaseChecksum(new TextDecoder().decode(checksums), assetName);
  if (!expected) {
    throw new WslAssetMissingError(
      `Release v${tagVersion} does not publish ${assetName}, so there is no Linux runtime to install. Update MangoStudio, or put a matching runtime at ${DISTRO_RUNTIME_PATH} in the distribution yourself.`
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
      if (error.message.includes('404') || /\b404\b/.test(error.message)) {
        throw new WslAssetMissingError(`Could not download ${url}: ${error.message}.`);
      }
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
 * parsed as shell. Positional arguments land as `$1`, `$2`, … after the `$0`
 * that names the runtime in anything the shell reports.
 *
 * Large stdin payloads are written in chunks that honour backpressure, with an
 * optional progress callback — a ~95 MB push that does a single write stalls
 * the event loop and has no progress to surface.
 */
function runInDistroWithWsl(
  distro: string,
  script: string,
  options: RuntimeCommandOptions = {}
): Promise<DistroCommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ stdout: '', stderr: '', exitCode: -1, signal: 'SIGKILL' });
      return;
    }

    const argv = ['-d', distro, '--exec', 'sh', '-c', script];
    if (options.args?.length) argv.push('mangostudio-runtime', ...options.args);
    const timeoutMs = options.timeoutMs ?? DISTRO_COMMAND_TIMEOUT_MS;
    const child = spawn('wsl.exe', argv, {
      stdio: 'pipe',
      windowsHide: true,
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    const onAbort = () => {
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

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
      options.signal?.removeEventListener('abort', onAbort);
      reject(
        new WslProvisioningError(
          error.code === 'ENOENT'
            ? 'Could not run "wsl.exe". WSL is not installed on this host, or it is not on the PATH MangoStudio was started with.'
            : `Could not run "wsl.exe": ${error.message}`
        )
      );
    });
    child.on('close', (code, signal) => {
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode: code ?? -1, ...(signal ? { signal } : {}) });
    });

    // The archive is written before stdin closes, which is the end-of-input tar
    // waits for. An early exit surfaces as EPIPE and is already reported by the
    // exit code, so it must not also become an unhandled error.
    child.stdin.on('error', () => undefined);
    void writeStdinChunked(
      child.stdin,
      options.stdin,
      options.onStdinProgress,
      options.signal
    ).then(
      () => child.stdin.end(),
      () => child.stdin.end()
    );
  });
}

async function writeStdinChunked(
  stdin: NodeJS.WritableStream,
  bytes: Uint8Array | undefined,
  onProgress: ((bytesWritten: number) => void) | undefined,
  signal?: AbortSignal
): Promise<void> {
  if (!bytes || bytes.byteLength === 0) return;

  // One `error` listener for the whole loop, and a `close` listener beside it:
  // a distribution that exits mid-transfer never emits `drain` again, so a wait
  // that only listens for `drain` parks forever holding the payload.
  const settled = waitForStdinEnd(stdin);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (signal?.aborted) return;
      const end = Math.min(offset + STDIN_CHUNK_BYTES, bytes.byteLength);
      const chunk = bytes.subarray(offset, end);
      const canContinue = stdin.write(chunk);
      offset = end;
      onProgress?.(offset);
      if (!canContinue) {
        await Promise.race([
          new Promise<void>((resolve) => stdin.once('drain', resolve)),
          settled.promise,
        ]);
        if (settled.done) return;
      }
    }
  } finally {
    settled.dispose();
  }
}

/**
 * Resolves when the pipe can no longer take bytes, whichever way that happens.
 * `dispose` is what keeps this from leaking a listener per drain wait.
 */
function waitForStdinEnd(stdin: NodeJS.WritableStream): {
  readonly promise: Promise<void>;
  readonly dispose: () => void;
  readonly done: boolean;
} {
  const emitter = stdin as unknown as NodeJS.EventEmitter;
  let done = false;
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = () => {
      done = true;
      resolve();
    };
  });
  const onEnd = () => settle?.();
  emitter.on('error', onEnd);
  emitter.on('close', onEnd);
  return {
    promise,
    dispose: () => {
      emitter.off('error', onEnd);
      emitter.off('close', onEnd);
    },
    get done() {
      return done;
    },
  };
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
  hubHost: hostname,
};

export const wslProvisioner = createWslProvisioner();
