#!/usr/bin/env bun
// Render the Scoop manifest for one release: fill the manifest template with the
// version and the per-architecture Windows archive checksums from SHA256SUMS.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { normalizeVersion, resolveReleaseVersion } from '../lib/release-version';
import { assertNoUnexpectedArguments, error, parseArgs, success } from '../lib/runner';
import {
  renderDistManifest,
  resolveManifestPath,
  type ShaPlaceholderMap,
} from './template-renderer';

export const SCOOP_MANIFEST_TEMPLATE_PATH = join(
  import.meta.dir,
  'templates',
  'mangostudio.json.tmpl'
);

/** Template placeholders mapped to the Windows release platform whose archive checksum fills them. */
export const SCOOP_SHA_PLACEHOLDERS: ShaPlaceholderMap = {
  SHA_WINDOWS_X64: 'windows-x64',
  SHA_WINDOWS_ARM64: 'windows-arm64',
};

export interface RenderScoopManifestInput {
  readonly version: string;
  /** Raw SHA256SUMS manifest content. */
  readonly manifest: string;
  readonly template: string;
}

/**
 * Fill the Scoop manifest template with the release version and both Windows
 * architecture checksums. Throws when the version is not semver, when SHA256SUMS
 * is missing an expected `.zip` archive (naming-contract drift), or when a
 * `{{…}}` placeholder survives. Scoop's own `$version`/`$sha256`/`$basename`
 * autoupdate tokens use single `$` and are left untouched.
 * // Usage: renderScoopManifest({ version: '1.2.3', manifest, template })
 */
export function renderScoopManifest(input: RenderScoopManifestInput): string {
  return renderDistManifest({ ...input, shaPlaceholders: SCOOP_SHA_PLACEHOLDERS });
}

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/update-scoop.ts --sums <SHA256SUMS|assets-dir> [options]

Renders bucket/mangostudio.json for the Scoop bucket from the release checksums.

Flags:
  --sums <path>     SHA256SUMS file or the release-assets directory containing it (required)
  --version <semver> Release version (default: VERSION env or root package.json)
  --out <path>      Output manifest path (default: bucket/mangostudio.json)
  --help            Show this help message`);
  process.exit(0);
};

function main(): void {
  const { flags, values, positional } = parseArgs({ valueFlags: ['--version', '--sums', '--out'] });
  if (flags['--help']) printHelp();
  assertNoUnexpectedArguments(positional);
  if (!values['--sums']) printHelp();

  const version = values['--version'] ?? resolveReleaseVersion();
  const outPath = values['--out'] ?? join('bucket', 'mangostudio.json');
  const rendered = renderScoopManifest({
    version,
    manifest: readFileSync(resolveManifestPath(values['--sums']), 'utf8'),
    template: readFileSync(SCOOP_MANIFEST_TEMPLATE_PATH, 'utf8'),
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, rendered);
  success(`Scoop manifest for v${normalizeVersion(version)} written to ${outPath}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
