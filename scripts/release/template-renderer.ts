// Shared renderer for distribution manifests (Homebrew formula, Scoop manifest).
// Each channel owns a template plus a map of {{SHA_*}} placeholders to release
// platforms; this fills {{VERSION}} and those checksums from a release's
// SHA256SUMS, failing loud on naming-contract drift or any unfilled placeholder.

import { statSync } from 'node:fs';
import { join } from 'node:path';

import type { ReleasePlatformId } from '../lib/release-targets';
import { filterBinaryTargets, releaseArchiveFileName } from '../lib/release-targets';
import { isValidSemver, normalizeVersion } from '../lib/release-version';
import { findChecksum } from './verify-checksum';

/** Template placeholder name (without braces) → the release platform whose
 * archive checksum fills it. // Usage: { SHA_WINDOWS_X64: 'windows-x64' } */
export type ShaPlaceholderMap = Readonly<Record<string, ReleasePlatformId>>;

export interface RenderDistManifestInput {
  readonly version: string;
  /** Raw SHA256SUMS manifest content. */
  readonly manifest: string;
  readonly template: string;
  readonly shaPlaceholders: ShaPlaceholderMap;
}

/**
 * Fill a manifest template with the release version and the per-platform archive
 * checksums named by `shaPlaceholders`. Throws when the version is not semver,
 * when SHA256SUMS is missing an expected archive (naming-contract drift), or when
 * any `{{…}}` placeholder survives.
 * // Usage: renderDistManifest({ version, manifest, template, shaPlaceholders })
 */
export function renderDistManifest(input: RenderDistManifestInput): string {
  const version = normalizeVersion(input.version);
  if (!isValidSemver(version)) {
    throw new Error(`Invalid release version "${input.version}". Expected semver like 1.2.3.`);
  }

  let rendered = input.template.replaceAll('{{VERSION}}', version);
  for (const [placeholder, platformId] of Object.entries(input.shaPlaceholders)) {
    const [target] = filterBinaryTargets(platformId);
    if (!target) throw new Error(`Unknown release platform: ${platformId}`);
    const assetName = releaseArchiveFileName(version, target);
    rendered = rendered.replaceAll(`{{${placeholder}}}`, findChecksum(input.manifest, assetName));
  }

  const leftover = rendered.match(/\{\{[^}]*\}\}/);
  if (leftover) {
    throw new Error(`Manifest template placeholder ${leftover[0]} was not filled`);
  }
  return rendered;
}

/** Resolve a `--sums` argument to the SHA256SUMS file, accepting either the file
 * itself or the release-assets directory that contains it. */
export function resolveManifestPath(sumsPath: string): string {
  return statSync(sumsPath).isDirectory() ? join(sumsPath, 'SHA256SUMS') : sumsPath;
}
