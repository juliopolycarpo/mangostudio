// Cross-compilation runtime resolver for `bun build --compile`.
//
// `--compile` builds a foreign-platform binary by downloading a prebuilt Bun for
// that platform, and it resolves the download from `Bun.version`. On the canary
// channel `Bun.version` reports a bare `1.4.0` — the channel suffix is dropped —
// so the lookup asks for the release tag `bun-v1.4.0`, which does not exist, and
// every target except the host fails. Fetching the channel's asset here and
// handing the path to `--compile-executable-path` skips that lookup entirely.
//
// On a released Bun this module stays out of the way: `bunCrossCompileChannel`
// returns null and the build keeps using Bun's own download path.

import { chmod, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { assertSafeArchiveEntries } from './actions-lint/bootstrap';
import { ROOT_DIR } from './config';
import { captureCommand } from './exec';
import type { BinaryTarget, ReleasePlatformId } from './release-targets';

const BUN_VERSION_FILE = join(ROOT_DIR, '.bun-version');
const CACHE_DIR = join(ROOT_DIR, '.mango', 'artifacts', 'bun-cross');
const RELEASE_DOWNLOAD_BASE = 'https://github.com/oven-sh/bun/releases/download';

/**
 * A released Bun, e.g. `1.3.14` or `1.4.0-canary.1` — anything else is a channel.
 *
 * Build metadata is accepted even though no Bun tag carries it, because this
 * only decides *who resolves the download*. Anything version-shaped belongs to
 * Bun and setup-bun, whose own semver accepts `+build`; treating such a string
 * as a channel instead would send it to a release URL that cannot exist.
 */
const RELEASED_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Bun release asset (without `.zip`) carrying the runtime for one release
 * target. Bun spells arm64 as `aarch64`, so this cannot be derived from the
 * platform id by identity; the map is keyed by `ReleasePlatformId` so a new
 * release target cannot land without one.
 */
const BUN_RUNTIME_ASSETS: Record<ReleasePlatformId, string> = {
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-aarch64',
  'linux-x64-musl': 'bun-linux-x64-musl',
  'linux-arm64-musl': 'bun-linux-aarch64-musl',
  'darwin-x64': 'bun-darwin-x64',
  'darwin-arm64': 'bun-darwin-aarch64',
  'windows-x64': 'bun-windows-x64',
  'windows-arm64': 'bun-windows-aarch64',
};

interface CrossRuntimeOptions {
  /** Bun release channel to fetch, as named by `.bun-version`. */
  readonly channel: string;
  readonly cacheDir?: string;
  /** Overrides the default `<channel>-<host Bun.revision>` cache key. */
  readonly cacheKey?: string;
}

/**
 * The Bun channel `.bun-version` names, or null when it pins a released version
 * and `--compile` can resolve its own downloads.
 * // Usage: const channel = await bunCrossCompileChannel(); // → 'canary' | null
 */
export async function bunCrossCompileChannel(
  versionFile = BUN_VERSION_FILE
): Promise<string | null> {
  const file = Bun.file(versionFile);
  if (!(await file.exists())) {
    return null;
  }

  const requested = (await file.text()).trim();
  if (!requested || RELEASED_VERSION.test(requested)) {
    return null;
  }
  return requested;
}

/**
 * Release platform this build is running on, or null when the host is not one
 * of the release targets. Only ever used to pick a runtime that can be executed
 * here, so the glibc ids stand in for their musl siblings: the two carry the
 * same Bun commit, and the revision is all the caller wants.
 * // Usage: hostReleasePlatform() // → 'linux-x64' on a CI runner
 */
export function hostReleasePlatform(): ReleasePlatformId | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (!arch) return null;

  switch (process.platform) {
    case 'linux':
      return `linux-${arch}`;
    case 'darwin':
      return `darwin-${arch}`;
    case 'win32':
      return `windows-${arch}`;
    default:
      return null;
  }
}

/**
 * Revision of the Bun that ends up inside the compiled binaries.
 *
 * On a released Bun that is the host's own, because `--compile` downloads the
 * build matching `Bun.version`. On a channel it is whatever the tag pointed at
 * when {@link ensureBunCrossRuntime} fetched it, which can differ from the host
 * — see the mutable-tag note below. Reads an already-installed runtime only and
 * never downloads, so a caller that has not built yet gets null rather than a
 * surprise 50 MB fetch.
 * // Usage: await bunCompileRuntimeRevision('canary') // → '1.4.0-canary.1+…'
 */
export async function bunCompileRuntimeRevision(
  channel: string | null,
  options: Omit<CrossRuntimeOptions, 'channel'> = {}
): Promise<string | null> {
  if (!channel) return Bun.revision;

  const arch = hostReleasePlatform();
  if (!arch) return null;

  const asset = BUN_RUNTIME_ASSETS[arch];
  const cacheKey = options.cacheKey ?? defaultCacheKey(channel);
  const installed = await findBunExecutable(join(options.cacheDir ?? CACHE_DIR, cacheKey, asset));
  if (!installed) return null;

  // `Bun.revision`, not `--revision`: the flag prints `1.4.0-canary.1+32e87032b`
  // while the API returns the full 40-character sha. Comparing the two spellings
  // of the same build would report drift on every run.
  const { stdout, exitCode } = await captureCommand([installed, '-e', 'console.log(Bun.revision)']);
  if (exitCode !== 0) return null;
  return stdout.trim() || null;
}

const inflight = new Map<string, Promise<string>>();

/**
 * Absolute path of a Bun executable able to compile for `target`, downloading
 * and caching the channel asset on first use. Concurrent callers asking for the
 * same asset share one download.
 * // Usage: await ensureBunCrossRuntime(target, { channel: 'canary' })
 */
export function ensureBunCrossRuntime(
  target: BinaryTarget,
  options: CrossRuntimeOptions
): Promise<string> {
  const asset = BUN_RUNTIME_ASSETS[target.arch];
  const cacheKey = options.cacheKey ?? defaultCacheKey(options.channel);
  const installDir = join(options.cacheDir ?? CACHE_DIR, cacheKey, asset);

  const pending = inflight.get(installDir);
  if (pending) return pending;

  const task = installCrossRuntime(asset, installDir, options.channel).finally(() => {
    inflight.delete(installDir);
  });
  inflight.set(installDir, task);
  return task;
}

/**
 * The channel alone would key a cache that serves the same runtime forever, so
 * the host build's revision joins it: upgrading the local Bun re-downloads.
 */
function defaultCacheKey(channel: string): string {
  return `${channel}-${Bun.revision}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function installCrossRuntime(
  asset: string,
  installDir: string,
  channel: string
): Promise<string> {
  const cached = await findBunExecutable(installDir);
  if (cached) {
    return cached;
  }

  // A channel tag is mutable — `canary` is rebuilt for every commit on main — so
  // the runtime fetched here can be a slightly different Bun commit than the one
  // that installed the host `bun`. That incoherence is inherent to tracking a
  // floating channel and is accepted, not a bug: the cache key above bounds it
  // to the lifetime of one host build.
  const url = `${RELEASE_DOWNLOAD_BASE}/${channel}/${asset}.zip`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());

  const parentDir = dirname(installDir);
  await mkdir(parentDir, { recursive: true });
  const stagingDir = await mkdtemp(join(parentDir, `.${asset}-`));
  try {
    const archivePath = join(stagingDir, `${asset}.zip`);
    await Bun.write(archivePath, bytes);

    const extractDir = join(stagingDir, 'extracted');
    await mkdir(extractDir, { recursive: true });
    await extractZipArchive(archivePath, extractDir);

    const extracted = await findBunExecutable(extractDir);
    if (!extracted) {
      throw new Error(`Archive ${asset}.zip contained no Bun executable`);
    }
    await chmod(extracted, 0o755);

    try {
      await rename(extractDir, installDir);
    } catch {
      // Lost an install race with another process; its copy came from the same
      // asset, so fall through to the check below.
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  const installed = await findBunExecutable(installDir);
  if (!installed) {
    throw new Error(`Installing ${asset}.zip left no Bun executable under ${installDir}`);
  }
  return installed;
}

/**
 * Bun's archives nest the executable under a directory named after the asset,
 * and name it `bun.exe` on Windows. Both shapes are searched so a layout change
 * upstream degrades into a clear error rather than a silent cache miss.
 */
async function findBunExecutable(directory: string): Promise<string | null> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.isFile() && (entry.name === 'bun' || entry.name === 'bun.exe')) {
      return join(directory, entry.name);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const name of ['bun', 'bun.exe']) {
      const candidate = join(directory, entry.name, name);
      if (await Bun.file(candidate).exists()) {
        return candidate;
      }
    }
  }
  return null;
}

async function extractZipArchive(archivePath: string, destination: string): Promise<void> {
  const { list, extract } = zipCommands(archivePath, destination);

  const listing = await runArchiveCommand('list', list);
  assertSafeArchiveEntries(listing.split(/\r?\n/).filter(Boolean));
  await runArchiveCommand('extract', extract);
}

function zipCommands(
  archivePath: string,
  destination: string
): { list: string[]; extract: string[] } {
  const unzip = Bun.which('unzip');
  if (unzip) {
    return {
      list: [unzip, '-Z1', archivePath],
      extract: [unzip, '-q', archivePath, '-d', destination],
    };
  }

  // Windows 10+ ships bsdtar as `tar`, which reads zip archives. GNU tar does
  // not, so this fallback only carries hosts that have no `unzip` at all, and
  // fails loudly with tar's own message when it cannot.
  const toTarPath = (path: string): string =>
    process.platform === 'win32' ? path.replaceAll('\\', '/') : path;
  return {
    list: ['tar', '-tf', toTarPath(archivePath)],
    extract: ['tar', '-xf', toTarPath(archivePath), '-C', toTarPath(destination)],
  };
}

async function runArchiveCommand(
  operation: 'list' | 'extract',
  command: string[]
): Promise<string> {
  const { stdout, stderr, exitCode } = await captureCommand(command);
  if (exitCode !== 0) {
    throw new Error(
      `Failed to ${operation} ${command[0]} archive: ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`
    );
  }
  return stdout;
}
