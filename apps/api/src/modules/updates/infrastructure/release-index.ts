/**
 * The GitHub side of resolving an upgrade target: which tag "stable latest"
 * and "canary latest" currently mean, and the rolling canary tag's provenance
 * manifest.
 *
 * `releaseAssetUrl`, `findReleaseChecksum` and the manifest parser already
 * exist for the runtime-provisioning paths (`wsl-runtime-release.ts`,
 * `canary-manifest.ts`); this module only adds the two lookups those paths
 * never needed — the tag "latest" resolves to right now, for each channel.
 */

import { type SafeFetchDeps, SafeFetchError, safeFetchBytes } from '../../../lib/safe-fetch';
import {
  CANARY_MANIFEST_ASSET,
  type CanaryManifest,
  parseCanaryManifest,
} from '../../environments/domain/canary-manifest';
import { releaseAssetUrl } from '../../environments/domain/wsl-runtime-release';

export const UPDATES_REPOSITORY = 'juliopolycarpo/mangostudio';
const GITHUB_RELEASES_BASE = `https://github.com/${UPDATES_REPOSITORY}`;
const GITHUB_API_BASE = `https://api.github.com/repos/${UPDATES_REPOSITORY}`;

// GitHub's REST API answers 403 to a request with no User-Agent at all;
// github.com itself does not require one, but sending it everywhere here
// keeps every call in this module identifiable the same way.
const GITHUB_HEADERS = { 'User-Agent': 'mangostudio-hub' };
const GITHUB_API_HEADERS = { ...GITHUB_HEADERS, Accept: 'application/vnd.github+json' };

/**
 * Without a deadline a stalled socket hangs the whole upgrade: the engine's
 * `running` flag and machine-service's `upgradeInFlight` both stay set, so no
 * further upgrade can start until the hub restarts. Generous enough for the
 * ~600KB release page on a slow link, and still bounded.
 */
const LOOKUP_TIMEOUT_MS = 30_000;
const MAX_TAG_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_LIST_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

/**
 * The stable channel's current version, read off the tag `releases/latest`
 * redirects to. A GET (not HEAD — `safeFetchBytes` only does the one method)
 * against the HTML release page, discarding the body: `result.url` is the
 * resolved URL after every redirect hop the address policy re-checked, so no
 * second, unauthenticated `api.github.com` call is needed for this lookup.
 * // Usage: resolveStableLatestVersion({ fetch }) // '1.2.3'
 */
export async function resolveStableLatestVersion(deps: SafeFetchDeps): Promise<string> {
  const result = await safeFetchBytes(
    `${GITHUB_RELEASES_BASE}/releases/latest`,
    {
      maxBytes: MAX_TAG_PAGE_BYTES,
      maxRedirects: 5,
      timeoutMs: LOOKUP_TIMEOUT_MS,
      headers: GITHUB_HEADERS,
    },
    deps
  );
  const tag = result.url.split('/').filter(Boolean).pop();
  if (!tag?.startsWith('v')) {
    throw new Error(`Could not read a release tag from ${result.url}.`);
  }
  return tag.slice(1);
}

interface GithubReleaseListEntry {
  readonly tag_name: string;
  readonly prerelease: boolean;
}

function isReleaseListEntry(value: unknown): value is GithubReleaseListEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.tag_name === 'string' && typeof candidate.prerelease === 'boolean';
}

/** `vX.Y.Z-canary` — the one tag shape the rolling canary release ever cuts. */
const CANARY_ROLLING_TAG = /^v\d+\.\d+\.\d+-canary$/;

/**
 * The rolling canary tag's version, found by listing recent releases and
 * taking the first pre-release whose tag is the rolling shape. Used only when
 * the current build is not itself canary — a canary hub already knows its own
 * tag from `resolveRuntimeRelease(currentVersion, platformId).tagVersion`.
 * // Usage: resolveCanaryRollingVersion({ fetch }) // '0.2.0-canary'
 */
export async function resolveCanaryRollingVersion(deps: SafeFetchDeps): Promise<string> {
  const result = await safeFetchBytes(
    `${GITHUB_API_BASE}/releases?per_page=30`,
    {
      maxBytes: MAX_RELEASE_LIST_BYTES,
      maxRedirects: 3,
      timeoutMs: LOOKUP_TIMEOUT_MS,
      headers: GITHUB_API_HEADERS,
    },
    deps
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(result.bytes));
  if (!Array.isArray(parsed)) {
    throw new Error('GitHub release listing did not answer with an array.');
  }
  const rolling = parsed
    .filter(isReleaseListEntry)
    .find((entry) => entry.prerelease && CANARY_ROLLING_TAG.test(entry.tag_name));
  if (!rolling) {
    throw new Error('No rolling canary pre-release is currently published.');
  }
  return rolling.tag_name.slice(1);
}

/**
 * The rolling tag's provenance manifest, or null when the tag predates the
 * manifest — the same tolerated fallback `checkRollingPair` uses for runtime
 * provisioning. Unlike that helper, this one makes no claim about whether the
 * *running* hub may install what the tag serves: it is read here purely to
 * report the sha-stamped version and source commit of an upgrade *target*,
 * which is expected to differ from the current build.
 * // Usage: fetchCanaryManifestForTag({ fetch }, '0.2.0-canary')
 */
export async function fetchCanaryManifestForTag(
  deps: SafeFetchDeps,
  tagVersion: string
): Promise<CanaryManifest | null> {
  try {
    const result = await safeFetchBytes(
      releaseAssetUrl(tagVersion, CANARY_MANIFEST_ASSET),
      {
        maxBytes: MAX_MANIFEST_BYTES,
        maxRedirects: 5,
        timeoutMs: LOOKUP_TIMEOUT_MS,
        headers: GITHUB_HEADERS,
      },
      deps
    );
    return parseCanaryManifest(new TextDecoder().decode(result.bytes));
  } catch (error) {
    if (error instanceof SafeFetchError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Fetches `SHA256SUMS` verbatim from a resolved target's own `checksumsUrl` —
 * not a tag, so the downloader never has to re-derive one from a URL it was
 * already handed.
 * // Usage: fetchReleaseChecksums({ fetch }, target.checksumsUrl)
 */
export async function fetchReleaseChecksums(
  deps: SafeFetchDeps,
  checksumsUrl: string
): Promise<string> {
  const result = await safeFetchBytes(
    checksumsUrl,
    {
      maxBytes: MAX_MANIFEST_BYTES,
      maxRedirects: 5,
      timeoutMs: LOOKUP_TIMEOUT_MS,
      headers: GITHUB_HEADERS,
    },
    deps
  );
  return new TextDecoder().decode(result.bytes);
}
