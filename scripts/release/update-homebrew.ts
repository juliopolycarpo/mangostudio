#!/usr/bin/env bun
// Render the Homebrew formula for one release: fill the formula template with
// the version and the per-platform archive checksums from SHA256SUMS.

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { filterBinaryTargets, releaseArchiveFileName } from '../lib/release-targets';
import { isValidSemver, normalizeVersion, resolveReleaseVersion } from '../lib/release-version';
import { assertNoUnexpectedArguments, error, parseArgs, success } from '../lib/runner';
import { findChecksum } from './verify-checksum';

export const HOMEBREW_FORMULA_TEMPLATE_PATH = join(
  import.meta.dir,
  'templates',
  'mangostudio.rb.tmpl'
);

/** Template placeholders mapped to the release platform whose archive checksum fills them. */
export const HOMEBREW_SHA_PLACEHOLDERS = {
  SHA_DARWIN_ARM64: 'darwin-arm64',
  SHA_DARWIN_X64: 'darwin-x64',
  SHA_LINUX_ARM64: 'linux-arm64',
  SHA_LINUX_X64: 'linux-x64',
} as const;

export interface RenderHomebrewFormulaInput {
  readonly version: string;
  /** Raw SHA256SUMS manifest content. */
  readonly manifest: string;
  readonly template: string;
}

/**
 * Fill the formula template with the release version and the four platform
 * checksums. Throws when the version is not semver, when SHA256SUMS is missing
 * an expected archive (naming-contract drift), or when a placeholder survives.
 * // Usage: renderHomebrewFormula({ version: '1.2.3', manifest, template })
 */
export function renderHomebrewFormula(input: RenderHomebrewFormulaInput): string {
  const version = normalizeVersion(input.version);
  if (!isValidSemver(version)) {
    throw new Error(`Invalid release version "${input.version}". Expected semver like 1.2.3.`);
  }

  let rendered = input.template.replaceAll('{{VERSION}}', version);
  for (const [placeholder, platformId] of Object.entries(HOMEBREW_SHA_PLACEHOLDERS)) {
    const [target] = filterBinaryTargets(platformId);
    if (!target) throw new Error(`Unknown release platform: ${platformId}`);
    const assetName = releaseArchiveFileName(version, target);
    rendered = rendered.replaceAll(`{{${placeholder}}}`, findChecksum(input.manifest, assetName));
  }

  const leftover = rendered.match(/\{\{[^}]*\}\}/);
  if (leftover) {
    throw new Error(`Formula template placeholder ${leftover[0]} was not filled`);
  }
  return rendered;
}

function resolveManifestPath(sumsPath: string): string {
  return statSync(sumsPath).isDirectory() ? join(sumsPath, 'SHA256SUMS') : sumsPath;
}

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/update-homebrew.ts --sums <SHA256SUMS|assets-dir> [options]

Renders Formula/mangostudio.rb for the Homebrew tap from the release checksums.

Flags:
  --sums <path>     SHA256SUMS file or the release-assets directory containing it (required)
  --version <semver> Release version (default: VERSION env or root package.json)
  --out <path>      Output formula path (default: Formula/mangostudio.rb)
  --help            Show this help message`);
  process.exit(0);
};

function main(): void {
  const { flags, values, positional } = parseArgs({ valueFlags: ['--version', '--sums', '--out'] });
  if (flags['--help']) printHelp();
  assertNoUnexpectedArguments(positional);
  if (!values['--sums']) printHelp();

  const version = values['--version'] ?? resolveReleaseVersion();
  const outPath = values['--out'] ?? join('Formula', 'mangostudio.rb');
  const rendered = renderHomebrewFormula({
    version,
    manifest: readFileSync(resolveManifestPath(values['--sums']), 'utf8'),
    template: readFileSync(HOMEBREW_FORMULA_TEMPLATE_PATH, 'utf8'),
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, rendered);
  success(`Homebrew formula for v${normalizeVersion(version)} written to ${outPath}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
