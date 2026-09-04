/**
 * The release platform id this binary belongs to — `linux-x64`,
 * `windows-arm64`, ... — mirroring `scripts/lib/release-targets.ts`. The api
 * workspace cannot import from `scripts/` (it is not a workspace), so the
 * eight ids are frozen here as well; a platform release-targets.ts adds must
 * be added here too.
 *
 * A release binary knows its id exactly: `scripts/build.ts` bakes it in as
 * `BUILD_PLATFORM_ID` through `--define`, the same mechanism that stamps
 * `BUILD_GIT_SHA` (see `../../../lib/build-info.ts`). A source checkout has no
 * such stamp, so it falls back to a guess from the running host — which is
 * wrong exactly once, for musl: a glibc-built Bun cannot detect musl at
 * runtime, so the guess always assumes glibc. That is fine for a checkout,
 * which never resolves an upgrade target for itself.
 */

export type ReleasePlatformId =
  | 'linux-x64'
  | 'linux-arm64'
  | 'windows-x64'
  | 'windows-arm64'
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'linux-x64-musl'
  | 'linux-arm64-musl';

export const RELEASE_PLATFORM_IDS: readonly ReleasePlatformId[] = [
  'linux-x64',
  'linux-arm64',
  'windows-x64',
  'windows-arm64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64-musl',
  'linux-arm64-musl',
];

/** Parses a release platform id, or null for anything else. // Usage: parseReleasePlatformId('linux-x64') */
export function parseReleasePlatformId(value: string): ReleasePlatformId | null {
  return (RELEASE_PLATFORM_IDS as readonly string[]).includes(value)
    ? (value as ReleasePlatformId)
    : null;
}

/**
 * Reads `BUILD_PLATFORM_ID` as a literal `process.env` member access, the way
 * `--define` requires: Bun's compile-time define substitutes the exact token
 * `process.env.BUILD_PLATFORM_ID`, not a dynamic `env[key]` lookup through an
 * aliased object. A helper that read through an alias would silently never see
 * the baked value in a release binary — the one place this id must be exact —
 * and fall back to the host guess instead.
 */
function readBakedPlatformId(): string | undefined {
  return process.env.BUILD_PLATFORM_ID;
}

export interface HostPlatformProbe {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

const HOST_OS_NAMES: Partial<Record<NodeJS.Platform, 'linux' | 'darwin' | 'windows'>> = {
  linux: 'linux',
  darwin: 'darwin',
  win32: 'windows',
};

/**
 * Best-effort platform id for a process with no `BUILD_PLATFORM_ID` stamp —
 * a source checkout, or a binary compiled without `scripts/build.ts`. Only
 * `x64` and `arm64` are recognised archs; anything else guesses `x64`, which
 * is wrong but never worse than refusing to guess at all for a path that only
 * feeds a "current platform" default, never an upgrade decision made for
 * someone else.
 */
function guessHostPlatformId(host: HostPlatformProbe): ReleasePlatformId {
  const os = HOST_OS_NAMES[host.platform] ?? 'linux';
  const arch = host.arch === 'arm64' ? 'arm64' : 'x64';
  return `${os}-${arch}` as ReleasePlatformId;
}

/**
 * The release platform id this process should act as. Trusts a baked
 * `BUILD_PLATFORM_ID` — present on every release binary and never on a source
 * checkout — over the host guess, which cannot tell musl from glibc.
 *
 * `env` and `host` are for tests only: production callers take the defaults,
 * which read `process.env.BUILD_PLATFORM_ID` as the literal member access
 * `--define` requires.
 * // Usage: resolveBuildPlatformId() // 'linux-x64' on a release binary, a host guess on a checkout
 */
export function resolveBuildPlatformId(
  env: { readonly BUILD_PLATFORM_ID?: string } = { BUILD_PLATFORM_ID: readBakedPlatformId() },
  host: HostPlatformProbe = { platform: process.platform, arch: process.arch }
): ReleasePlatformId {
  const baked = env.BUILD_PLATFORM_ID?.trim();
  const parsed = baked ? parseReleasePlatformId(baked) : null;
  return parsed ?? guessHostPlatformId(host);
}
