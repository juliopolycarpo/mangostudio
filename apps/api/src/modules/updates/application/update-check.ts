/**
 * Background check against the release host: is a newer build available.
 *
 * One cached answer, written to `<run dir>/update-check.json`, read by three
 * surfaces (`status`, `doctor`, the machine page) that must never themselves
 * touch the network — `readCached()` only ever reads the file `check()` last
 * wrote. `check()` is the one place that talks to GitHub, is safe to call as
 * often as anyone likes (an in-flight or still-fresh answer is reused), and
 * never rejects: a network or parse failure becomes an `UpdateCheck` with
 * `error` set rather than a throw, so a caller in the request path is never
 * one bad DNS lookup away from a 500.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  SOURCE_SHA_MAX,
  UPDATE_ERROR_MAX,
  UPDATE_VERSION_MAX,
  type UpdateChannel,
  type UpdateCheck,
  UpdateCheckSchema,
} from '@mangostudio/shared/updates';
import Value from 'typebox/value';
import { type BuildInfo, getBuildInfo, isKnownBuildSha } from '../../../lib/build-info';
import { getConfig, getVersion, isDevelopmentVersion, type MangoConfig } from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getUpdateCheckPath } from '../../../lib/mango-paths';
import { type SafeFetchDeps, safeFetchBytes } from '../../../lib/safe-fetch';
import {
  CANARY_MANIFEST_ASSET,
  parseCanaryManifest,
} from '../../environments/domain/canary-manifest';
import { resolveRuntimeRelease } from '../../environments/domain/runtime-release-resolution';
import { fitToLimit } from '../../machine/domain/machine-limits';
import { versionChannel } from '../domain/install-origin';
import { RELEASES_BASE_URL, versionRoot } from '../domain/upgrade-plan';
import { compareStableVersions, sharesShaPrefix, stripLeadingV } from '../domain/version-compare';

const logger = createDiagnosticLogger('update-check');

const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 60 * 1000;
const SCHEDULE_INITIAL_DELAY_MS = 5_000;
const SCHEDULE_INTERVAL_MS = CHECK_TTL_MS;

const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_REDIRECTS = 5;
// The GitHub API response is JSON, but a release's notes travel in the same
// body — generous headroom over a bare tag name.
const FETCH_MAX_BYTES = 1024 * 1024;

const GITHUB_LATEST_RELEASE_API =
  'https://api.github.com/repos/juliopolycarpo/mangostudio/releases/latest';
// Same headers `release-index.ts` sends for the same host: GitHub's REST API
// answers 403 to a request with no User-Agent at all, and the `Accept` pins
// the response shape this parser reads `tag_name` out of.
const GITHUB_API_HEADERS = {
  'User-Agent': 'mangostudio-hub',
  Accept: 'application/vnd.github+json',
};

export type UpdateCheckSkipReason = 'disabled' | 'env' | 'dev';

/**
 * Why a check is skipped, or null when it should proceed. Shared by the
 * checker itself and by `doctor`'s row, which words the skip differently per
 * reason and must not invent a second copy of this rule.
 * // Usage: updateCheckSkipReason(config, process.env, getVersion())
 */
export function updateCheckSkipReason(
  config: Pick<MangoConfig, 'updates'>,
  env: NodeJS.ProcessEnv,
  version: string
): UpdateCheckSkipReason | null {
  if (!config.updates.check) return 'disabled';
  if (
    isSetNonEmpty(env.NO_UPDATE_NOTIFIER) ||
    isSetNonEmpty(env.DO_NOT_TRACK) ||
    isSetNonEmpty(env.CI)
  ) {
    return 'env';
  }
  if (isDevelopmentVersion(version)) return 'dev';
  return null;
}

function isSetNonEmpty(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

export interface UpdateChecker {
  /** Whatever `check()` last wrote to disk, or null when skipped or never run. */
  readCached(): UpdateCheck | null;
  /** The fresh or cached answer; never rejects. */
  check(options?: { readonly force?: boolean }): Promise<UpdateCheck | null>;
  /** Runs `check()` once shortly after start, then every 24h. Returns a stop function. */
  schedule(): () => void;
}

export interface UpdateCheckerDeps {
  readonly getConfig: () => MangoConfig;
  readonly getCurrentVersion: () => string;
  readonly getBuildInfo: () => BuildInfo;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch: typeof fetch;
  /** Injectable for tests only; the real address policy resolves DNS itself in production. */
  readonly resolveHostname: SafeFetchDeps['resolveHostname'];
  readonly cachePath: () => string;
  readonly readCacheFile: (path: string) => UpdateCheck | null;
  readonly writeCacheFile: (path: string, check: UpdateCheck) => Promise<void>;
  readonly now: () => number;
  readonly setTimeout: typeof setTimeout;
  readonly setInterval: typeof setInterval;
  readonly clearTimeout: typeof clearTimeout;
  readonly clearInterval: typeof clearInterval;
}

/** Build the checker. // Usage: createUpdateChecker().check() */
export function createUpdateChecker(deps: Partial<UpdateCheckerDeps> = {}): UpdateChecker {
  const d = resolveDeps(deps);
  let inFlight: Promise<UpdateCheck | null> | null = null;

  function skipReason(): UpdateCheckSkipReason | null {
    return updateCheckSkipReason(d.getConfig(), d.env, d.getCurrentVersion());
  }

  /** The channel a fresh check would run against right now: config's own choice, or the build's. */
  function effectiveChannel(): UpdateChannel {
    return d.getConfig().updates.channel ?? versionChannel(d.getCurrentVersion());
  }

  /**
   * Whatever `check()` last wrote — but not a cache left over from a channel
   * `[updates] channel` no longer names, and not one computed for a version
   * this process is no longer running. Without the channel rule, flipping the
   * config would keep answering from the old channel's cache until the next
   * `check()` call happened to overwrite it, up to 24h later; without the
   * version rule, the process that comes back after an upgrade reuses its
   * predecessor's answer and the banner, `status` and `doctor` keep offering
   * the release that is already installed.
   */
  function readCached(): UpdateCheck | null {
    if (skipReason() !== null) return null;
    const cached = d.readCacheFile(d.cachePath());
    if (!cached) return null;
    if (cached.channel !== effectiveChannel()) return null;
    if (cached.currentVersion !== d.getCurrentVersion()) return null;
    return cached;
  }

  /**
   * Fresh enough to reuse without a fetch: within its TTL, which is shorter
   * for an errored answer so a transient failure is retried sooner. The
   * channel it belongs to is already `readCached`'s business.
   */
  function isFresh(check: UpdateCheck): boolean {
    const ttl = check.error === undefined ? CHECK_TTL_MS : ERROR_TTL_MS;
    return d.now() - check.checkedAt < ttl;
  }

  function check(options: { readonly force?: boolean } = {}): Promise<UpdateCheck | null> {
    if (skipReason() !== null) return Promise.resolve(null);
    if (inFlight) return inFlight;

    const existing = readCached();
    if (!options.force && existing && isFresh(existing)) {
      return Promise.resolve(existing);
    }

    inFlight = performCheck().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function performCheck(): Promise<UpdateCheck> {
    const currentVersion = d.getCurrentVersion();
    const channel = effectiveChannel();
    let result: UpdateCheck;
    try {
      result =
        channel === 'canary'
          ? await checkCanary(d, currentVersion)
          : await checkStable(d, currentVersion);
    } catch (error) {
      result = {
        channel,
        currentVersion,
        updateAvailable: false,
        checkedAt: d.now(),
        error: fitToLimit(errorMessage(error), UPDATE_ERROR_MAX),
      };
    }
    try {
      await d.writeCacheFile(d.cachePath(), result);
    } catch (writeError) {
      logger.error('cache_write_failed', { error: errorMessage(writeError) });
    }
    return result;
  }

  function schedule(): () => void {
    const runOnce = (): void => {
      void check().catch((error: unknown) => {
        logger.error('scheduled_check_failed', { error: errorMessage(error) });
      });
    };
    const initial = d.setTimeout(runOnce, SCHEDULE_INITIAL_DELAY_MS);
    initial.unref?.();
    const interval = d.setInterval(runOnce, SCHEDULE_INTERVAL_MS);
    interval.unref?.();
    return () => {
      d.clearTimeout(initial);
      d.clearInterval(interval);
    };
  }

  return { readCached, check, schedule };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkStable(d: ResolvedDeps, currentVersion: string): Promise<UpdateCheck> {
  const result = await safeFetchBytes(
    GITHUB_LATEST_RELEASE_API,
    {
      maxBytes: FETCH_MAX_BYTES,
      maxRedirects: FETCH_MAX_REDIRECTS,
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: GITHUB_API_HEADERS,
    },
    { fetch: d.fetch, resolveHostname: d.resolveHostname }
  );
  const parsed = JSON.parse(new TextDecoder().decode(result.bytes)) as { tag_name?: unknown };
  if (typeof parsed.tag_name !== 'string' || !parsed.tag_name) {
    throw new Error('GitHub release response had no tag_name.');
  }
  const latestVersion = stripLeadingV(parsed.tag_name);
  return {
    channel: 'stable',
    currentVersion,
    latestVersion: fitToLimit(latestVersion, UPDATE_VERSION_MAX),
    // Not `!==`: a yanked release can leave "latest" behind the version
    // already running, and string inequality would still call that an
    // "update" — one the button would then install as a downgrade.
    updateAvailable: compareStableVersions(latestVersion, currentVersion) > 0,
    checkedAt: d.now(),
  };
}

/**
 * `v<root>-canary`: the release tag the rolling canary channel publishes
 * under. `resolveRuntimeRelease`'s `tagVersion` already carries the
 * `-canary` suffix for a canary version, so a stable current version takes
 * the other branch to reach the same shape rather than appending it twice.
 */
function canaryReleaseTag(currentVersion: string): string {
  const resolution = resolveRuntimeRelease(currentVersion, 'linux-x64');
  const root =
    resolution.channel === 'canary'
      ? resolution.tagVersion
      : `${versionRoot(currentVersion)}-canary`;
  return `v${root}`;
}

async function checkCanary(d: ResolvedDeps, currentVersion: string): Promise<UpdateCheck> {
  const tag = canaryReleaseTag(currentVersion);
  const url = `${RELEASES_BASE_URL}/download/${tag}/${CANARY_MANIFEST_ASSET}`;
  const result = await safeFetchBytes(
    url,
    { maxBytes: FETCH_MAX_BYTES, maxRedirects: FETCH_MAX_REDIRECTS, timeoutMs: FETCH_TIMEOUT_MS },
    { fetch: d.fetch, resolveHostname: d.resolveHostname }
  );
  const manifest = parseCanaryManifest(new TextDecoder().decode(result.bytes));
  if (!manifest) throw new Error(`Canary manifest at ${tag} could not be parsed.`);

  const buildInfo = d.getBuildInfo();
  // A canary build with no BUILD_GIT_SHA stamped in (buildInfo.gitSha ===
  // 'unknown') can never share a prefix with a real sha, so the prefix
  // compare would call every check an update — permanently, even running
  // the exact commit the manifest names. Falling back to a version compare
  // is the same signal update-check.ts already has for every other channel.
  const updateAvailable = isKnownBuildSha(buildInfo)
    ? !sharesShaPrefix(manifest.sourceSha, buildInfo.gitSha)
    : manifest.version !== currentVersion;
  return {
    channel: 'canary',
    currentVersion,
    latestVersion: fitToLimit(manifest.version, UPDATE_VERSION_MAX),
    latestSourceSha: fitToLimit(manifest.sourceSha, SOURCE_SHA_MAX),
    updateAvailable,
    checkedAt: d.now(),
  };
}

type ResolvedDeps = ReturnType<typeof resolveDeps>;

function resolveDeps(deps: Partial<UpdateCheckerDeps>): UpdateCheckerDeps {
  return {
    getConfig: deps.getConfig ?? getConfig,
    getCurrentVersion: deps.getCurrentVersion ?? getVersion,
    getBuildInfo: deps.getBuildInfo ?? getBuildInfo,
    env: deps.env ?? process.env,
    fetch: deps.fetch ?? fetch,
    resolveHostname: deps.resolveHostname,
    cachePath: deps.cachePath ?? getUpdateCheckPath,
    readCacheFile: deps.readCacheFile ?? readCacheFileReal,
    writeCacheFile: deps.writeCacheFile ?? writeCacheFileReal,
    now: deps.now ?? Date.now,
    setTimeout: deps.setTimeout ?? setTimeout,
    setInterval: deps.setInterval ?? setInterval,
    clearTimeout: deps.clearTimeout ?? clearTimeout,
    clearInterval: deps.clearInterval ?? clearInterval,
  };
}

/**
 * Synchronous by contract (`readCached()` is not async): the file is a few
 * hundred bytes, and every caller wants an answer now rather than a promise
 * to resolve later.
 */
/**
 * Parses one cache file's contents against the wire schema — not a
 * hand-written shape guard, so a corrupt `latestVersion`/`latestSourceSha`
 * type or a negative `checkedAt` reads as "no cache" the same as invalid
 * JSON, rather than reaching a caller as a value it then has to trust.
 * // Usage: parseUpdateCheckFile('{"channel":"stable",...}')
 */
export function parseUpdateCheckFile(raw: string): UpdateCheck | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Value.Check(UpdateCheckSchema, parsed) ? (parsed as UpdateCheck) : null;
  } catch {
    return null;
  }
}

function readCacheFileReal(path: string): UpdateCheck | null {
  try {
    return parseUpdateCheckFile(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeCacheFileReal(path: string, check: UpdateCheck): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(check, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

/** Shared across the CLI, the API and the server hook. */
export const updateChecker: UpdateChecker = createUpdateChecker();
