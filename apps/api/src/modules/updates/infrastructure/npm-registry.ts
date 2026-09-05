/**
 * The npm side of resolving a canary `<sha>` upgrade target.
 *
 * A per-commit canary build is never republished under a rolling tag the way
 * `mangostudio-<root>-canary-<platformId>` is on GitHub; it is published to npm
 * as a per-platform optional-dependency package (the same ones
 * `packages/cli/bin/mangostudio.js` resolves at install time), one version per
 * build. Finding the version behind a given sha is therefore an npm registry
 * lookup, not a GitHub one.
 */

import type { SafeFetchDeps } from '../../../lib/safe-fetch';
import { safeFetchBytes } from '../../../lib/safe-fetch';
import type { ReleasePlatformId } from '../domain/platform-id';

const NPM_REGISTRY_BASE = 'https://registry.npmjs.org';

/**
 * Abbreviated-packument media type: the registry answers with only `dist-tags`
 * and `versions[].dist`, dropping the full manifest (readme, dependents...)
 * per version that a canary build accumulates hundreds of. Requesting the full
 * document for a package with a long publish history is the slow, wasteful
 * path this exists to avoid.
 */
const ABBREVIATED_PACKUMENT_ACCEPT = 'application/vnd.npm.install-v1+json';

/** Generous cap for an abbreviated packument; still far below a full one. */
const MAX_PACKUMENT_BYTES = 4 * 1024 * 1024;
/** Same reason as release-index.ts's: an untimed lookup wedges the upgrade lock. */
const LOOKUP_TIMEOUT_MS = 30_000;

/** Maps a release platform id onto the npm package that ships its binary. musl has none — see `install.sh`/the shell installer instead. */
const RELEASE_PLATFORM_NPM_PACKAGES: Partial<Record<ReleasePlatformId, string>> = {
  'linux-x64': '@mangostudio/cli-linux-x64',
  'linux-arm64': '@mangostudio/cli-linux-arm64',
  'darwin-x64': '@mangostudio/cli-darwin-x64',
  'darwin-arm64': '@mangostudio/cli-darwin-arm64',
  'windows-x64': '@mangostudio/cli-win32-x64',
  'windows-arm64': '@mangostudio/cli-win32-arm64',
};

/** The npm package that ships `platformId`'s binary, or null for a platform npm does not publish (musl). // Usage: npmPackageForPlatform('linux-x64') */
export function npmPackageForPlatform(platformId: ReleasePlatformId): string | null {
  return RELEASE_PLATFORM_NPM_PACKAGES[platformId] ?? null;
}

export interface NpmPackumentVersion {
  readonly dist: {
    readonly tarball: string;
    readonly integrity?: string;
    readonly shasum?: string;
  };
}

export interface NpmPackument {
  readonly name: string;
  readonly versions: Readonly<Record<string, NpmPackumentVersion>>;
}

function isDistInfo(value: unknown): value is NpmPackumentVersion['dist'] {
  if (typeof value !== 'object' || value === null) return false;
  const dist = value as Record<string, unknown>;
  return typeof dist.tarball === 'string';
}

/** Parses an (abbreviated) packument, or null for anything that is not one. */
export function parseNpmPackument(text: string): NpmPackument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.name !== 'string') return null;
  if (typeof candidate.versions !== 'object' || candidate.versions === null) return null;

  const versions: Record<string, NpmPackumentVersion> = {};
  for (const [version, entry] of Object.entries(candidate.versions as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const dist = (entry as Record<string, unknown>).dist;
    if (isDistInfo(dist)) versions[version] = { dist };
  }
  return { name: candidate.name, versions };
}

/**
 * A canary prerelease identifier's sha, git-describe style (`g`-prefixed) or
 * bare — the same ambiguity `resolveRuntimeRelease`'s `CANARY_VERSION` handles
 * for the version string itself, here scoped to just the identifier. Returns
 * lowercase hex, or null when the version carries no such identifier.
 */
export function canaryPrereleaseSha(version: string): string | null {
  const match = /-canary\.g?([0-9a-f]{7,40})$/i.exec(version);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * The packument version whose encoded commit shares a 7+ char prefix with
 * `sha`, or null when none does.
 * // Usage: findCanaryVersionForSha(packument, 'abc1234def') // '0.1.1-canary.abc1234'
 */
export function findCanaryVersionForSha(packument: NpmPackument, sha: string): string | null {
  const target = sha.toLowerCase().slice(0, 7);
  for (const version of Object.keys(packument.versions)) {
    const candidate = canaryPrereleaseSha(version);
    if (candidate && candidate.slice(0, 7) === target) return version;
  }
  return null;
}

/**
 * Fetches one package's abbreviated packument.
 * // Usage: fetchNpmPackument('@mangostudio/cli-linux-x64', { fetch })
 */
export async function fetchNpmPackument(
  packageName: string,
  deps: SafeFetchDeps
): Promise<NpmPackument> {
  // The registry URL-encodes the scope's slash but keeps the leading `@`
  // literal — a plain encodeURIComponent would escape both. Every slash is
  // encoded, not just the first, so the name can never open a new path segment.
  const url = `${NPM_REGISTRY_BASE}/${packageName.replaceAll('/', '%2F')}`;
  const result = await safeFetchBytes(
    url,
    {
      maxBytes: MAX_PACKUMENT_BYTES,
      timeoutMs: LOOKUP_TIMEOUT_MS,
      maxRedirects: 3,
      headers: { Accept: ABBREVIATED_PACKUMENT_ACCEPT },
    },
    deps
  );
  const text = new TextDecoder().decode(result.bytes);
  const packument = parseNpmPackument(text);
  if (!packument) {
    throw new Error(`npm registry did not answer ${packageName} with a packument.`);
  }
  return packument;
}
