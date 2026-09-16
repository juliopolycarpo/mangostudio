/**
 * Reads the provenance record a canary pre-release publishes.
 *
 * Written by `scripts/release/stage-canary-assets.ts`; the shape is a pinned
 * contract between the two the same way `SHA256SUMS` is, and it is checksummed
 * by the same manifest every other asset is.
 *
 * It exists because a version alone does not say which commit produced it. The
 * manifest names the source commit behind a release, which is what the update
 * check compares against the sha this build was stamped with.
 */

import { SOURCE_SHA_PATTERN } from '@mangostudio/shared/runtime-home';

export const CANARY_MANIFEST_ASSET = 'canary-manifest.json';

/**
 * The only manifest layout this hub knows how to read.
 *
 * Gated on exactly, not `>=`: the field exists so a future layout can change
 * meaning, and a hub that acted on a shape it does not understand would be
 * reading fields it cannot actually evaluate. An unsupported version is treated
 * as no manifest at all — the same tolerated fallback a release cut before the
 * manifest existed already takes.
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
 * tolerated state: releases published before this record existed have none, and
 * refusing to read them would break the channel to add a check. A manifest that
 * parses is trusted; one that does not — including one carrying a
 * {@link CANARY_MANIFEST_SCHEMA_VERSION} this hub does not know — is treated as
 * missing, and the caller falls back to a version comparison.
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
  // Shape-checked, not merely typed: this value does not stop at a message. It
  // reaches `runtime.json` through an upgrade target, where
  // `RuntimeSlotConfigSchema` bounds it at 64 characters — and a config that
  // fails that check is discarded whole, consent included. An out-of-shape sha
  // must never leave this parser.
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
