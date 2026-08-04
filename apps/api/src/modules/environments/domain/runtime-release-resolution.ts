/** Channel-aware identity for the one raw runtime asset a hub needs. */

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
}

/**
 * Canary reports the source SHA in the running version while publishing under
 * one rolling tag and filename. Stable uses its exact version for both.
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
    runtimeAssetName: `mangostudio-runtime-${assetVersion}-${platformId}`,
  };
}
