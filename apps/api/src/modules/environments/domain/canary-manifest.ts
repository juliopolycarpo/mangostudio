/**
 * Reads the provenance record the rolling canary pre-release publishes.
 *
 * Written by `scripts/release/stage-canary-assets.ts`; the shape is a pinned
 * contract between the two the same way `SHA256SUMS` is, and it is checksummed
 * by the same manifest every other asset is.
 *
 * It exists because a rolling channel reuses one tag and one filename across
 * builds. `mangostudio-runtime-0.1.0-canary-linux-x64` is whatever the last
 * green commit put there, so the bytes behind that name are not necessarily
 * this hub's pair — and the binaries themselves report the sha-stamped version,
 * which the filename has thrown away. The manifest is the only thing on the
 * release that can say which commit a rolling name currently refers to.
 */

export const CANARY_MANIFEST_ASSET = 'canary-manifest.json';

interface CanaryManifestPair {
  readonly platform: string;
  readonly hub: { readonly asset: string; readonly digest: string };
  readonly runtime: { readonly asset: string; readonly digest: string };
}

export interface CanaryManifest {
  readonly schemaVersion: number;
  readonly channel: 'canary';
  /** The version the binaries report about themselves, source sha included. */
  readonly version: string;
  /** The version their filenames and tag carry. */
  readonly assetVersion: string;
  readonly sourceSha: string;
  readonly builtAt: string;
  readonly pairs: readonly CanaryManifestPair[];
}

/**
 * Parses a manifest, or returns null for anything that is not one.
 *
 * Null rather than a throw because an absent or unreadable manifest is a
 * tolerated state: rolling releases published before this record existed have
 * none, and refusing to provision from them would break the channel to add a
 * check. A manifest that parses is trusted; one that does not is treated as
 * missing, and the caller falls back to the install-time version check.
 */
export function parseCanaryManifest(text: string): CanaryManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const candidate = parsed as Record<string, unknown>;
  if (candidate.channel !== 'canary') return null;
  if (typeof candidate.version !== 'string' || candidate.version.length === 0) return null;
  if (typeof candidate.assetVersion !== 'string') return null;
  if (typeof candidate.sourceSha !== 'string') return null;
  if (typeof candidate.builtAt !== 'string') return null;
  if (typeof candidate.schemaVersion !== 'number') return null;
  if (!Array.isArray(candidate.pairs)) return null;

  const pairs = candidate.pairs.map(parsePair);
  if (pairs.some((pair) => pair === null)) return null;

  return {
    schemaVersion: candidate.schemaVersion,
    channel: 'canary',
    version: candidate.version,
    assetVersion: candidate.assetVersion,
    sourceSha: candidate.sourceSha,
    builtAt: candidate.builtAt,
    pairs: pairs as CanaryManifestPair[],
  };
}

function parsePair(value: unknown): CanaryManifestPair | null {
  if (typeof value !== 'object' || value === null) return null;
  const pair = value as Record<string, unknown>;
  if (typeof pair.platform !== 'string') return null;
  const hub = parsePairAsset(pair.hub);
  const runtime = parsePairAsset(pair.runtime);
  if (!hub || !runtime) return null;
  return { platform: pair.platform, hub, runtime };
}

function parsePairAsset(value: unknown): { asset: string; digest: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const asset = value as Record<string, unknown>;
  if (typeof asset.asset !== 'string' || typeof asset.digest !== 'string') return null;
  return { asset: asset.asset, digest: asset.digest };
}

/**
 * Why this hub must not install what the rolling tag currently serves, or null
 * when it may.
 *
 * The failure this prevents is specific: a hub at `…-canary.abc1234` asks the
 * rolling tag for its runtime, the tag has since moved to `…-canary.def5678`,
 * and the bytes that come back are a runtime from a different commit. The
 * checksum verifies — `SHA256SUMS` was clobbered with them — so nothing catches
 * it until the runtime is already on the machine and the handshake refuses the
 * pair. Refusing here keeps the failure on the hub, before any remote write,
 * and says what to do about it.
 */
export function canaryPairRefusal(
  manifest: CanaryManifest,
  hubVersion: string,
  platformId: string
): string | null {
  if (manifest.version !== hubVersion) {
    return (
      `The rolling canary release has moved on: it now publishes ${manifest.version} ` +
      `(from ${manifest.sourceSha.slice(0, 7)}), but this hub is ${hubVersion}. Installing ` +
      'that runtime would pair a hub and a runtime from different commits, which the ' +
      'handshake refuses. Update MangoStudio to the current canary and try again.'
    );
  }

  if (!manifest.pairs.some((pair) => pair.platform === platformId)) {
    const published = manifest.pairs.map((pair) => pair.platform).join(', ');
    return (
      `The rolling canary release does not publish a runtime for ${platformId}. ` +
      `Canary covers ${published}; stable publishes every platform.`
    );
  }

  return null;
}
