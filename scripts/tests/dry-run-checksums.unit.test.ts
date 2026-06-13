import { describe, expect, test } from 'bun:test';

import { createDryRunChecksumRows, fillDryRunChecksumManifest } from '../lib/dry-run-checksums';
import { ALL_BINARY_TARGETS, releaseArchiveFileName } from '../lib/release-targets';

describe('createDryRunChecksumRows', () => {
  test('derives placeholder rows from every binary release target', () => {
    const rows = createDryRunChecksumRows('0.0.0-dryrun');

    expect(rows.map((row) => row.assetName)).toEqual(
      ALL_BINARY_TARGETS.map((target) => releaseArchiveFileName('0.0.0-dryrun', target))
    );
    expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum))).toBe(true);
  });
});

describe('fillDryRunChecksumManifest', () => {
  test('keeps existing archive checksums and appends missing targets', () => {
    const existingChecksum = 'f'.repeat(64);
    const existingAsset = 'mangostudio-0.0.0-dryrun-linux-x64.tar.gz';
    const filled = fillDryRunChecksumManifest(
      `${existingChecksum}  ${existingAsset}\n`,
      '0.0.0-dryrun'
    );

    expect(filled).toContain(`${existingChecksum}  ${existingAsset}\n`);
    for (const target of ALL_BINARY_TARGETS) {
      expect(filled).toContain(`  ${releaseArchiveFileName('0.0.0-dryrun', target)}\n`);
    }
    expect(filled.match(new RegExp(existingAsset, 'g'))).toHaveLength(1);
  });

  test('does not rewrite a complete manifest', () => {
    const manifest = `${createDryRunChecksumRows('0.0.0-dryrun')
      .map((row) => `${row.checksum}  ${row.assetName}`)
      .join('\n')}\n`;

    expect(fillDryRunChecksumManifest(manifest, '0.0.0-dryrun')).toBe(manifest);
  });
});
