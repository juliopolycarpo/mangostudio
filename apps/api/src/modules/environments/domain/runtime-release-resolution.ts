/** Channel-aware identity for the raw runtime asset a hub needs. */

/**
 * The sha identifier is optionally `g`-prefixed: a short sha that is all digits
 * with a leading zero is an illegal semver numeric identifier, so the release
 * scripts write it git-describe style. Missing that spelling would resolve the
 * build onto a stable tag that was never published.
 */
const CANARY_VERSION = /^(\d+\.\d+\.\d+)-canary(?:\.g?[a-f0-9]{7,40})?$/;

export interface RuntimeReleaseResolution {
  readonly channel: 'stable' | 'canary';
  /** Release tag without its `v` prefix. */
  readonly tagVersion: string;
  /** Version segment used by assets on that tag. */
  readonly assetVersion: string;
  readonly runtimeAssetName: string;
  /**
   * True when the tag and the asset name are reused across builds.
   *
   * This is a property of the *assets*, not of the version: a canary hub still
   * carries its source sha (`<root>-canary.<sha7>`), so what it recorded in a
   * slot does identify the bytes it pushed. What is ambiguous is the other
   * direction — the asset behind a rolling tag is whatever the last green
   * commit put there, which is not necessarily this hub's pair. Anything that
   * fetches from a rolling tag has to confirm the identity of what it got.
   */
  readonly rolling: boolean;
}

/**
 * Canary reports the source SHA in the running version while publishing under
 * one rolling tag and filename. Stable uses its exact version for both.
 *
 * Windows keeps the `.exe` the release writes (`releaseRawRuntimeBinaryFileName`);
 * resolving a Windows target to an extensionless name asks a release for an
 * asset it never published.
 */
export function resolveRuntimeRelease(
  version: string,
  platformId: string
): RuntimeReleaseResolution {
  const canary = CANARY_VERSION.exec(version);
  const channel = canary ? 'canary' : 'stable';
  const assetVersion = canary ? `${canary[1]}-canary` : version;
  return {
    channel,
    tagVersion: assetVersion,
    assetVersion,
    runtimeAssetName: runtimeAssetName(assetVersion, platformId),
    rolling: canary !== null,
  };
}

/** Mirrors `releaseRawRuntimeBinaryFileName` for a release platform id. */
function runtimeAssetName(assetVersion: string, platformId: string): string {
  const suffix = platformId.startsWith('windows-') ? '.exe' : '';
  return `mangostudio-runtime-${assetVersion}-${platformId}${suffix}`;
}
