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

import { SOURCE_SHA_PATTERN } from '@mangostudio/shared/runtime-home';

export const CANARY_MANIFEST_ASSET = 'canary-manifest.json';

/**
 * The only manifest layout this hub knows how to read.
 *
 * Gated on exactly, not `>=`: the field exists so a future layout can change
 * meaning, and a hub that acted on a shape it does not understand would be
 * enforcing a guardrail it cannot actually evaluate. An unsupported version is
 * treated as no manifest at all — the same tolerated fallback a rolling release
 * cut before the manifest existed already takes.
 */
const CANARY_MANIFEST_SCHEMA_VERSION = 1;

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
 * check. A manifest that parses is trusted; one that does not — including one
 * carrying a {@link CANARY_MANIFEST_SCHEMA_VERSION} this hub does not know — is
 * treated as missing, and the caller falls back to the install-time version
 * check.
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
  // Shape-checked, not merely typed: this value no longer stops at a refusal
  // message. A rolling install writes it into the target machine's
  // `runtime.json`, where `RuntimeSlotConfigSchema` bounds it at 64
  // characters — and a config that fails that check is discarded whole,
  // consent included. An out-of-shape sha must never leave this parser.
  if (typeof candidate.sourceSha !== 'string' || !SOURCE_SHA_PATTERN.test(candidate.sourceSha)) {
    return null;
  }
  if (typeof candidate.builtAt !== 'string') return null;
  if (candidate.schemaVersion !== CANARY_MANIFEST_SCHEMA_VERSION) return null;
  if (!Array.isArray(candidate.pairs)) return null;

  const pairs = candidate.pairs.map(parsePair);
  if (pairs.some((pair) => pair === null)) return null;

  return {
    schemaVersion: CANARY_MANIFEST_SCHEMA_VERSION,
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
export interface RollingPairCheck {
  /** The manifest behind the rolling tag, or null when none could be read. */
  readonly manifest: CanaryManifest | null;
  /** Why this hub must not install what the tag serves, or null when it may. */
  readonly refusal: string | null;
}

/**
 * Fetches the rolling tag's manifest and decides whether this hub may install
 * from it — the one implementation both fetch paths share.
 *
 * It exists as a parameterised helper rather than a function per caller because
 * the WSL provisioner and the generic release fetcher differ only in their error
 * classes: the tolerated-failure rule and the refusal rule are the same
 * supply-chain check, and a correction applied to one copy but not the other is
 * precisely the failure this guard is meant to prevent.
 *
 * `tolerate` decides which fetch failures mean "no manifest published" rather
 * than "this provision fails". Anything it rejects propagates untouched.
 */
export async function checkRollingPair(options: {
  readonly fetchManifest: () => Promise<Uint8Array>;
  readonly tolerate: (error: unknown) => boolean;
  readonly hubVersion: string;
  readonly platformId: string;
}): Promise<RollingPairCheck> {
  let manifest: CanaryManifest | null = null;
  try {
    const bytes = await options.fetchManifest();
    manifest = parseCanaryManifest(new TextDecoder().decode(bytes));
  } catch (error) {
    // A 404 is the "no manifest published" case. A transport failure is
    // tolerated too rather than promoted to fatal here: the asset download that
    // follows hits the same host and reports a real outage on its own terms,
    // and an advisory guardrail should not be the thing that fails a provision.
    if (!options.tolerate(error)) throw error;
  }
  if (!manifest) return { manifest: null, refusal: null };

  return {
    manifest,
    refusal: canaryPairRefusal(manifest, options.hubVersion, options.platformId),
  };
}

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

/**
 * The digest a validated manifest already committed to for one platform's raw
 * runtime asset, or undefined when the manifest names something else.
 *
 * This is what closes the gap {@link checkRollingPair} otherwise leaves open: a
 * caller that approves a pair from the manifest and then fetches a fresh
 * `SHA256SUMS` for the actual download is trusting two separate reads of a tag
 * that can move between them. Binding the download to the digest this same
 * manifest read already named removes the second read — and the second
 * opportunity for the tag to have moved — entirely. The asset-name comparison
 * is a defensive check, not an expected mismatch: {@link canaryPairRefusal}
 * already required this platform to be in `manifest.pairs` before a caller can
 * reach here.
 */
export function manifestRuntimeDigest(
  manifest: CanaryManifest,
  platformId: string,
  runtimeAssetName: string
): string | undefined {
  const pair = manifest.pairs.find((candidate) => candidate.platform === platformId);
  if (!pair || pair.runtime.asset !== runtimeAssetName) return undefined;
  return pair.runtime.digest;
}
