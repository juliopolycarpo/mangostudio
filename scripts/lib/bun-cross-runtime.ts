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

import { type Dirent, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { ROOT_DIR } from './config';
import { assertSafeDistributionArchiveEntries } from './distribution-manifest';
import { captureCommand } from './exec';
import type { BinaryTarget, ReleasePlatformId } from './release-targets';

const BUN_VERSION_FILE = join(ROOT_DIR, '.bun-version');
const CACHE_DIR = join(ROOT_DIR, '.mango', 'artifacts', 'bun-cross');
const RELEASE_DOWNLOAD_BASE = 'https://github.com/oven-sh/bun/releases/download';
/** Digest listing Bun publishes beside every release asset, on every tag. */
const CHECKSUM_FILE = 'SHASUMS256.txt';

/**
 * Ceilings on the two release-host requests, generous enough that only a stalled
 * connection trips them: the listing is 3 KB, and an asset is 24–38 MB, which CI
 * pulls in seconds.
 *
 * Present because a hang here is indistinguishable from a slow build until the
 * job's own timeout kills it — 25 minutes of silence, no failing output, and
 * nothing in the log naming the request that never came back.
 */
const CHECKSUM_TIMEOUT_MS = 30_000;
const ASSET_TIMEOUT_MS = 120_000;

/** Per-request ceilings, overridable so a test can stall a request cheaply. */
interface AssetTimeouts {
  readonly checksumMs?: number;
  readonly assetMs?: number;
}

/**
 * Runs one release-host request under a deadline and, when the deadline is what
 * ended it, reports which request stalled.
 *
 * The deadline covers reading the body, not just the response headers: the
 * failure this bounds is a download that is accepted and then never delivers a
 * byte, which a headers-only timeout would let through.
 *
 * `signal.aborted` decides, rather than the rejection's name — a body read that
 * is cut short surfaces as several different errors across runtimes, and only
 * one thing here can abort the signal.
 */
async function underDeadline<T>(
  what: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await run(signal);
  } catch (caught) {
    if (signal.aborted) {
      throw new Error(`Timed out after ${timeoutMs}ms ${what}`);
    }
    throw caught;
  }
}

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
export const BUN_RUNTIME_ASSETS: Record<ReleasePlatformId, string> = {
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
 * ELF interpreters that identify a Linux host's C library, by `process.arch`.
 *
 * The path is fixed per libc and architecture, so finding one is a positive
 * identification rather than an inference from something correlated with it.
 */
const LIBC_LOADERS = {
  x64: {
    musl: ['/lib/ld-musl-x86_64.so.1'],
    glibc: ['/lib64/ld-linux-x86-64.so.2', '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'],
  },
  arm64: {
    musl: ['/lib/ld-musl-aarch64.so.1'],
    glibc: ['/lib/ld-linux-aarch64.so.1', '/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1'],
  },
} as const satisfies Record<string, { musl: readonly string[]; glibc: readonly string[] }>;

/**
 * Which C library this Linux host runs, or null when neither can be positively
 * identified.
 *
 * `process.platform` reports `linux` for both, and the difference decides which
 * Bun asset can execute here. Null is a real answer rather than a failure: the
 * caller uses this to decide whether the running Bun may stand in for a target's
 * runtime, and being wrong there ships a musl binary as the glibc artifact.
 * Downloading is always correct, so an unidentifiable host takes that path.
 *
 * Loader paths are checked before Bun's own report, and the musl loader before
 * the glibc one: `glibcVersionRuntime` is a useful third signal for a layout the
 * two lists do not cover, but a Bun that stopped populating it would otherwise
 * make every glibc host look unidentifiable.
 */
function hostLibc(arch: 'x64' | 'arm64'): 'glibc' | 'musl' | null {
  const loaders = LIBC_LOADERS[arch];
  if (loaders.musl.some((path) => existsSync(path))) return 'musl';
  if (loaders.glibc.some((path) => existsSync(path))) return 'glibc';

  const report: unknown = process.report?.getReport();
  const header = isRecord(report) ? report.header : undefined;
  const glibcVersion = isRecord(header) ? header.glibcVersionRuntime : undefined;
  return typeof glibcVersion === 'string' && glibcVersion.length > 0 ? 'glibc' : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Release platform this build is running on, or null when the host is not one
 * of the release targets — or is a Linux whose libc could not be identified.
 * // Usage: hostReleasePlatform() // → 'linux-x64' on a CI runner
 */
export function hostReleasePlatform(): ReleasePlatformId | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (!arch) return null;

  switch (process.platform) {
    case 'linux': {
      const libc = hostLibc(arch);
      if (!libc) return null;
      return libc === 'musl' ? `linux-${arch}-musl` : `linux-${arch}`;
    }
    case 'darwin':
      return `darwin-${arch}`;
    case 'win32':
      return `windows-${arch}`;
    default:
      return null;
  }
}

/**
 * Which Bun ended up inside one target's binaries.
 *
 * A foreign runtime cannot be executed here to ask its revision, so the two
 * sources answer with what each can actually prove: the host's own target is
 * compiled against the running Bun and reports its revision exactly, while a
 * fetched one is identified by the digest that was verified before it was used.
 */
export interface BunRuntimeProvenance {
  readonly source: 'host' | 'channel';
  /** Full 40-character revision. Known only for the running Bun. */
  readonly revision: string | null;
  /** SHA-256 of the verified channel asset. Null for the host's own runtime. */
  readonly sha256: string | null;
  /**
   * The channel tag moved while this asset was downloading: the digest published
   * when the listing was read did not match the bytes that arrived, and a fresh
   * listing did. Harmless on its own, and the reason binaries from one build can
   * carry different Bun commits.
   */
  readonly tagAdvanced: boolean;
}

/** Provenance recorded beside a cached runtime, so a cache hit answers too. */
const PROVENANCE_FILE = '.bun-runtime.json';

/**
 * Provenance of every runtime this build has already resolved, keyed by target.
 *
 * Reads the cache and never downloads, so a caller that has not built yet gets
 * an empty map rather than a surprise 500 MB of fetches. A `--platform`-limited
 * build reports only the targets it actually built.
 * // Usage: await bunCompiledRuntimes('canary') // → { 'linux-x64': { … } }
 */
export async function bunCompiledRuntimes(
  channel: string | null,
  options: Omit<CrossRuntimeOptions, 'channel'> = {}
): Promise<Partial<Record<ReleasePlatformId, BunRuntimeProvenance>>> {
  const host = hostReleasePlatform();
  // Without a channel `--compile` downloads the build matching `Bun.version`,
  // so every target carries the host's own Bun and there is nothing to look up.
  if (!channel) {
    return Object.fromEntries(
      Object.keys(BUN_RUNTIME_ASSETS).map((id) => [id, hostProvenance()])
    ) as Record<ReleasePlatformId, BunRuntimeProvenance>;
  }

  const cacheKey = options.cacheKey ?? defaultCacheKey(channel);
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const resolved: Partial<Record<ReleasePlatformId, BunRuntimeProvenance>> = {};

  for (const [id, asset] of Object.entries(BUN_RUNTIME_ASSETS) as Array<
    [ReleasePlatformId, string]
  >) {
    if (id === host) {
      resolved[id] = hostProvenance();
      continue;
    }
    const recorded = await readProvenance(join(cacheDir, cacheKey, asset));
    if (recorded) resolved[id] = recorded;
  }
  return resolved;
}

function hostProvenance(): BunRuntimeProvenance {
  // `Bun.revision`, not `--revision`: the flag prints `1.4.0-canary.1+32e87032b`
  // while the API returns the full 40-character sha, and the two spellings of one
  // build do not compare equal.
  return { source: 'host', revision: Bun.revision, sha256: null, tagAdvanced: false };
}

async function readProvenance(installDir: string): Promise<BunRuntimeProvenance | null> {
  const file = Bun.file(join(installDir, PROVENANCE_FILE));
  if (!(await file.exists())) return null;
  try {
    const recorded: unknown = await file.json();
    if (!isRecord(recorded) || typeof recorded.sha256 !== 'string') return null;
    return {
      source: 'channel',
      revision: null,
      sha256: recorded.sha256,
      tagAdvanced: recorded.tagAdvanced === true,
    };
  } catch {
    // A truncated record describes a runtime nobody can identify, which is what
    // an absent one means too.
    return null;
  }
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
  // The host's own target needs nothing fetched: `process.execPath` is the exact
  // build running this script. That saves a download per build, and closes the
  // one window in which the host's binary could carry a different channel commit
  // than the Bun that ran the suite. Only taken when the host platform is
  // positively identified, libc included — see hostLibc.
  if (target.arch === hostReleasePlatform()) {
    return Promise.resolve(process.execPath);
  }

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

/**
 * Discards what this host has cached for `channel`, so the next resolve really
 * fetches. Returns the directory it removed.
 *
 * The cache is keyed by the host Bun's revision and survives across branches, so
 * a build that has run once on this machine never touches the network again —
 * which is how a download path can break and every local build stay green. This
 * is the deliberate way back to the cold path.
 *
 * It clears the resolved key rather than moving the build to a throwaway one:
 * provenance is read back later from the same directory, by the drift report
 * here and by `scripts/release/distribution-manifest.ts` in its own process, and
 * a key only this build knows would leave both reporting no runtimes at all.
 * // Usage: await clearBunCrossRuntimeCache('canary')
 */
export async function clearBunCrossRuntimeCache(
  channel: string,
  options: Omit<CrossRuntimeOptions, 'channel'> = {}
): Promise<string> {
  const directory = join(
    options.cacheDir ?? CACHE_DIR,
    options.cacheKey ?? defaultCacheKey(channel)
  );
  await rm(directory, { recursive: true, force: true });
  return directory;
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
  const parentDir = dirname(installDir);
  await mkdir(parentDir, { recursive: true });
  const stagingDir = await mkdtemp(join(parentDir, `.${asset}-`));
  let renameError: unknown;
  try {
    const archivePath = join(stagingDir, `${asset}.zip`);
    const verified = await downloadVerifiedAsset(asset, channel, archivePath);

    const extractDir = join(stagingDir, 'extracted');
    await mkdir(extractDir, { recursive: true });
    await extractZipArchive(archivePath, extractDir);

    const extracted = await findBunExecutable(extractDir);
    if (!extracted) {
      throw new Error(`Archive ${asset}.zip contained no Bun executable`);
    }
    await chmod(extracted, 0o755);

    // Written before the rename so it lands atomically with the runtime it
    // describes: a cache hit skips everything above, and the digest is the only
    // identity a runtime that cannot be executed here will ever have.
    await Bun.write(join(extractDir, PROVENANCE_FILE), `${JSON.stringify(verified)}\n`);

    try {
      await rename(extractDir, installDir);
    } catch (caught) {
      // Usually an install race with another process, whose copy came from the
      // same verified asset, so fall through to the check below. Kept so that a
      // rename which failed for any other reason (EXDEV, EPERM) is not reduced
      // to a bare "no executable".
      renameError = caught;
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  const installed = await findBunExecutable(installDir);
  if (!installed) {
    const cause = renameError instanceof Error ? `: ${renameError.message}` : '';
    throw new Error(`Installing ${asset}.zip left no Bun executable under ${installDir}${cause}`);
  }
  return installed;
}

/**
 * Streams one channel asset to `archivePath` and checks it against the
 * `SHASUMS256.txt` published beside it.
 *
 * The repo's other installer verifies every byte it executes
 * (`actions-lint/bootstrap.ts`), and this one has at least that reach: the
 * runtime is copied into every shipped binary. A mutable tag bounds what a
 * digest from the same tag can prove, but a truncated or corrupted download
 * failing here rather than inside a release artifact is the point.
 *
 * The tag can also advance between the two fetches, which is indistinguishable
 * from corruption at this layer. The listing is re-read once before failing: a
 * genuine mismatch survives a fresh listing, a tag that moved does not. That
 * second case is reported rather than merely tolerated — it is the one moment a
 * build can observe the channel moving underneath it.
 *
 * `downloadBase` is a parameter rather than a constant so the verification can
 * be tested against a local server: every branch worth having — a corrupted
 * body, a tag that advanced mid-download, a listing that omits the asset — is
 * unreachable through the real one. `timeouts` follows the same seam, because a
 * ceiling nothing exercises is a ceiling nobody knows still fires.
 *
 * // Usage: await downloadVerifiedAsset('bun-linux-x64', 'canary', '/tmp/bun.zip')
 */
export async function downloadVerifiedAsset(
  asset: string,
  channel: string,
  archivePath: string,
  downloadBase: string = RELEASE_DOWNLOAD_BASE,
  timeouts: AssetTimeouts = {}
): Promise<{ sha256: string; tagAdvanced: boolean }> {
  const expected = await fetchAssetChecksum(asset, channel, downloadBase, timeouts);

  const url = `${downloadBase}/${channel}/${asset}.zip`;
  // Buffered, not `Bun.write(archivePath, response)`. Streaming the response
  // straight to disk is the obvious way to keep a whole Bun per target out of
  // memory, and it **deadlocks** on Bun 1.4.0-canary.1: with the seven foreign
  // targets downloading at once, a few complete and the rest never write a byte
  // — measured in CI (4 of 8 targets, then 25 minutes of silence to the job
  // timeout) and reproduced locally in isolation, where the same seven finish in
  // 4.7s buffered. One streamed download alone is fine, which is what makes it
  // easy to reintroduce. The peak this costs is ~222 MB across all seven; the
  // assets are 24–38 MB each, not the 60 MB the size of a Bun install suggests.
  //
  // The deadline below is not a substitute: an abort does not unblock a stalled
  // `Bun.write(path, response)`. Measured against the release host — the ceiling
  // came and went and the process was still hung when killed externally, which
  // is why the CI lane that exercises this carries a job timeout of its own.
  const bytes = await underDeadline(
    `downloading ${asset}.zip from the "${channel}" channel: ${url}`,
    timeouts.assetMs ?? ASSET_TIMEOUT_MS,
    async (signal) => {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    }
  );
  await Bun.write(archivePath, bytes);

  const actual = await sha256File(archivePath);
  if (actual === expected) return { sha256: actual, tagAdvanced: false };

  const reread = await fetchAssetChecksum(asset, channel, downloadBase, timeouts);
  if (actual === reread) return { sha256: actual, tagAdvanced: true };

  throw new Error(
    `SHA-256 mismatch for ${asset}.zip on the "${channel}" channel: expected ${reread}, got ${actual}`
  );
}

async function fetchAssetChecksum(
  asset: string,
  channel: string,
  downloadBase: string,
  timeouts: AssetTimeouts
): Promise<string> {
  const url = `${downloadBase}/${channel}/${CHECKSUM_FILE}`;
  const listing = await underDeadline(
    `reading ${CHECKSUM_FILE} for the "${channel}" channel: ${url}`,
    timeouts.checksumMs ?? CHECKSUM_TIMEOUT_MS,
    async (signal) => {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new Error(
          `Checksum download failed (${response.status} ${response.statusText}): ${url}`
        );
      }
      return await response.text();
    }
  );

  const wanted = `${asset}.zip`;
  for (const line of listing.split('\n')) {
    // `<digest>  <name>`, with the name optionally marked `*` for binary mode.
    const [digest, ...rest] = line.trim().split(/\s+/);
    if (rest.join(' ').replace(/^\*/, '') !== wanted) continue;
    if (digest && /^[a-f0-9]{64}$/.test(digest)) return digest;
  }
  throw new Error(`${CHECKSUM_FILE} on the "${channel}" channel lists no digest for ${wanted}`);
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest('hex');
}

/**
 * Bun's archives nest the executable under a directory named after the asset,
 * and name it `bun.exe` on Windows. Both shapes are searched so a layout change
 * upstream degrades into a clear error rather than a silent cache miss.
 */
async function findBunExecutable(directory: string): Promise<string | null> {
  // Named outright rather than as `Awaited<ReturnType<typeof readdir>>`, which
  // picks the first of readdir's overloads — the buffer one — and types every
  // `entry.name` below as a Buffer that no string comparison can ever match.
  let entries: Dirent[];
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
  assertSafeDistributionArchiveEntries(listing.split(/\r?\n/).filter(Boolean));
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
  // not, so this fallback only carries hosts that have no `unzip` at all; a host
  // with neither is reported by name when the command cannot be spawned.
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
  const tool = basename(command[0] ?? 'archiver');

  let result: Awaited<ReturnType<typeof captureCommand>>;
  try {
    result = await captureCommand(command);
  } catch (caught) {
    // `Bun.spawn` throws rather than exiting non-zero when the program is not
    // on PATH, which is exactly how a host with neither `unzip` nor `tar` fails.
    throw new Error(
      `Cannot run ${tool} to ${operation} the archive: ${
        caught instanceof Error ? caught.message : String(caught)
      }`
    );
  }

  const { stdout, stderr, exitCode } = result;
  if (exitCode !== 0) {
    throw new Error(
      `Failed to ${operation} the archive with ${tool}: ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`
    );
  }
  return stdout;
}
