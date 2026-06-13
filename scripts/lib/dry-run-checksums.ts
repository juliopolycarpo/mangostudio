import { createHash } from 'node:crypto';

import { ALL_BINARY_TARGETS, releaseArchiveFileName } from './release-targets';

// Keep in lockstep with verify-checksum.ts, archive-assets.ts, cargo-shim,
// install.sh, and install.ps1; see scripts/tests/support/SHA256SUMS.sample.
const CHECKSUM_LINE_PATTERN = /^([a-fA-F0-9]{64})\s+\*?(.+)$/;

export interface DryRunChecksumRow {
  readonly assetName: string;
  readonly checksum: string;
}

/** Build deterministic placeholder checksums for every binary release target. */
export function createDryRunChecksumRows(version: string): DryRunChecksumRow[] {
  return ALL_BINARY_TARGETS.map((target) => {
    const assetName = releaseArchiveFileName(version, target);
    return {
      assetName,
      checksum: createPlaceholderChecksum(assetName),
    };
  });
}

/** Append missing dry-run binary archive rows to a SHA256SUMS manifest. */
export function fillDryRunChecksumManifest(manifest: string, version: string): string {
  const presentAssetNames = new Set(parseChecksumAssetNames(manifest));
  const missingRows = createDryRunChecksumRows(version).filter(
    (row) => !presentAssetNames.has(row.assetName)
  );

  if (missingRows.length === 0) {
    return manifest;
  }

  const prefix = manifest.length === 0 || manifest.endsWith('\n') ? manifest : `${manifest}\n`;
  const appended = missingRows.map((row) => `${row.checksum}  ${row.assetName}`).join('\n');
  return `${prefix}${appended}\n`;
}

function parseChecksumAssetNames(manifest: string): string[] {
  return manifest
    .split(/\r?\n/)
    .map((line) => CHECKSUM_LINE_PATTERN.exec(line.trim())?.[2])
    .filter((assetName): assetName is string => assetName !== undefined);
}

function createPlaceholderChecksum(assetName: string): string {
  return createHash('sha256').update(`mangostudio-dry-run:${assetName}`).digest('hex');
}
