#!/usr/bin/env bun
// Verify one release asset against the SHA256SUMS manifest shipped beside it.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { error, success } from '../lib/runner';

/** Return a file's SHA-256 digest. // Usage: sha256File('release-assets/app.tar.gz') */
export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Find an asset checksum in a sha256sum-compatible manifest. // Usage: findChecksum(manifest, 'app.tar.gz') */
export function findChecksum(manifest: string, assetName: string): string {
  for (const line of manifest.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match?.[2] === assetName) return match[1].toLowerCase();
  }

  throw new Error(`SHA256SUMS does not contain ${assetName}`);
}

const printHelp = (): never => {
  console.log('Usage: bun ./scripts/release/verify-checksum.ts SHA256SUMS asset-file');
  process.exit(0);
};

const main = (): void => {
  const [manifestPath, assetPath, ...extra] = process.argv.slice(2);
  if (process.argv.includes('--help')) printHelp();
  if (!manifestPath || !assetPath || extra.length > 0) printHelp();

  const expected = findChecksum(readFileSync(manifestPath, 'utf8'), basename(assetPath));
  const actual = sha256File(assetPath);
  if (actual !== expected) throw new Error(`Checksum mismatch for ${basename(assetPath)}`);
  success(`Checksum verified: ${basename(assetPath)}`);
};

if (import.meta.main) {
  try {
    main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
