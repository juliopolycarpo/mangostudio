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
  UPDATE_ERROR_MAX,
  UPDATE_VERSION_MAX,
  type UpdateCheck,
} from '@mangostudio/shared/updates';
import { type BuildInfo, getBuildInfo } from '../../../lib/build-info';
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
import { RELEASES_BASE_URL, versionRoot } from '../domain/upgrade-plan';

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

// Not exported by the shared schema on its own — it caps `latestSourceSha`
// alongside `UPDATE_VERSION_MAX` and `UPDATE_ERROR_MAX`, which are.
const SOURCE_SHA_MAX = 64;

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

  function readCached(): UpdateCheck | null {
    if (skipReason() !== null) return null;
    return d.readCacheFile(d.cachePath());
  }

  function isFresh(check: UpdateCheck): boolean {
    const ttl = check.error === undefined ? CHECK_TTL_MS : ERROR_TTL_MS;
    return d.now() - check.checkedAt < ttl;
  }

  function check(options: { readonly force?: boolean } = {}): Promise<UpdateCheck | null> {
    if (skipReason() !== null) return Promise.resolve(null);
    if (inFlight) return inFlight;

    const existing = d.readCacheFile(d.cachePath());
    if (!options.force && existing && isFresh(existing)) return Promise.resolve(existing);

    inFlight = performCheck().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function performCheck(): Promise<UpdateCheck> {
    const currentVersion = d.getCurrentVersion();
    const channel = d.getConfig().updates.channel ?? versionChannelOf(currentVersion);
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

/** The channel a version string belongs to, without importing the install-origin module. */
function versionChannelOf(version: string): 'stable' | 'canary' {
  return resolveRuntimeRelease(version, 'linux-x64').channel;
}

function stripLeadingV(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version;
}

async function checkStable(d: ResolvedDeps, currentVersion: string): Promise<UpdateCheck> {
  const result = await safeFetchBytes(
    GITHUB_LATEST_RELEASE_API,
    { maxBytes: FETCH_MAX_BYTES, maxRedirects: FETCH_MAX_REDIRECTS, timeoutMs: FETCH_TIMEOUT_MS },
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
    updateAvailable: latestVersion !== stripLeadingV(currentVersion),
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

/** Whether two source shas agree on at least their first `minLength` characters. */
function sharesShaPrefix(a: string, b: string, minLength = 7): boolean {
  const len = Math.min(a.length, b.length, Math.max(minLength, 0));
  let common = 0;
  while (common < len && a[common]?.toLowerCase() === b[common]?.toLowerCase()) common += 1;
  return common >= minLength;
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

  const buildSha = d.getBuildInfo().gitSha;
  return {
    channel: 'canary',
    currentVersion,
    latestVersion: fitToLimit(manifest.version, UPDATE_VERSION_MAX),
    latestSourceSha: fitToLimit(manifest.sourceSha, SOURCE_SHA_MAX),
    updateAvailable: !sharesShaPrefix(manifest.sourceSha, buildSha),
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
function readCacheFileReal(path: string): UpdateCheck | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isUpdateCheck(parsed) ? parsed : null;
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

function isUpdateCheck(value: unknown): value is UpdateCheck {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.channel === 'stable' || v.channel === 'canary') &&
    typeof v.currentVersion === 'string' &&
    typeof v.updateAvailable === 'boolean' &&
    typeof v.checkedAt === 'number'
  );
}

/** Shared across the CLI, the API and the server hook. */
export const updateChecker: UpdateChecker = createUpdateChecker();
