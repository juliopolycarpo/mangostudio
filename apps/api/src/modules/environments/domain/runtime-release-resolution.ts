/** Channel-aware identity for the raw runtime asset a hub needs. */

/**
 * The sha identifier is optionally `g`-prefixed: a short sha that is all digits
 * with a leading zero is an illegal semver numeric identifier, so the release
 * scripts write it git-describe style. Missing that spelling would resolve the
 * build onto a stable tag that was never published.
 */
const CANARY_VERSION = /^(\d+\.\d+\.\d+)-canary(?:\.(g?[a-f0-9]{7,40}))?$/;

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
   * Only the frozen pre-2026-09 canary release is: it published every green
   * commit under one `v<root>-canary` tag, so the asset behind it is whatever
   * the last run put there, not necessarily this hub's pair, and anything
   * fetching from it has to confirm the identity of what it got. Canary now
   * cuts one immutable release per commit, whose tag and asset names carry the
   * build's own sha — nothing to confirm, because nothing can be replaced.
   */
  readonly rolling: boolean;
}

/**
 * Every channel publishes under its exact version: the tag is `v<version>` and
 * the assets carry `<version>`, canary sha included. A canary version with no
 * sha is the one exception — it names the frozen rolling release, which is
 * exactly what such a build was installed from.
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
  const canary = CANARY_VERSION.exec(version);
  return {
    channel: canary ? 'canary' : 'stable',
    tagVersion: version,
    assetVersion: version,
    runtimeAssetName: runtimeAssetName(version, platformId),
    rolling: canary !== null && canary[2] === undefined,
  };
}

/** Mirrors `releaseRawRuntimeBinaryFileName` for a release platform id. */
function runtimeAssetName(assetVersion: string, platformId: string): string {
  const suffix = platformId.startsWith('windows-') ? '.exe' : '';
  return `mangostudio-runtime-${assetVersion}-${platformId}${suffix}`;
}
