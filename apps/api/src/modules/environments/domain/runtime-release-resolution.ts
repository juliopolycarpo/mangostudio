/** Channel-aware identity for the raw runtime asset a hub needs. */

/**
 * The sha identifier is optionally `g`-prefixed: a short sha that is all digits
 * with a leading zero is an illegal semver numeric identifier, so the release
 * scripts write it git-describe style. Missing that spelling would resolve the
 * build onto a stable tag that was never published.
 */
const CANARY_VERSION = /^\d+\.\d+\.\d+-canary(?:\.g?[a-f0-9]{7,40})?$/;

export interface RuntimeReleaseResolution {
  readonly channel: 'stable' | 'canary';
  /** Release tag without its `v` prefix. */
  readonly tagVersion: string;
  /** Version segment used by assets on that tag. */
  readonly assetVersion: string;
  readonly runtimeAssetName: string;
}

/**
 * Every channel publishes under its exact version: the tag is `v<version>` and
 * the assets carry `<version>`, canary sha included. Every release is immutable,
 * so a version names one build's bytes and nothing else ever answers for it.
 *
 * Windows keeps the `.exe` the release writes (`releaseRawRuntimeBinaryFileName`);
 * resolving a Windows target to an extensionless name asks a release for an
 * asset it never published.
 * // Usage: resolveRuntimeRelease('0.1.1-canary.abc1234', 'linux-x64').tagVersion
 */
export function resolveRuntimeRelease(
  version: string,
  platformId: string
): RuntimeReleaseResolution {
  return {
    channel: CANARY_VERSION.test(version) ? 'canary' : 'stable',
    tagVersion: version,
    assetVersion: version,
    runtimeAssetName: runtimeAssetName(version, platformId),
  };
}

/** Mirrors `releaseRawRuntimeBinaryFileName` for a release platform id. */
function runtimeAssetName(assetVersion: string, platformId: string): string {
  const suffix = platformId.startsWith('windows-') ? '.exe' : '';
  return `mangostudio-runtime-${assetVersion}-${platformId}${suffix}`;
}
