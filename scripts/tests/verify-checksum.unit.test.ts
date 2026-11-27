import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findChecksum } from '../release/verify-checksum';

const checksumFixture = readFileSync(join(import.meta.dir, 'support', 'SHA256SUMS.sample'), 'utf8');

describe('findChecksum', () => {
  test('reads the shared sha256sum fixture for each supported line shape', () => {
    expect(findChecksum(checksumFixture, 'mangostudio-0.1.0-linux-x64.tar.gz')).toBe(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    );
    expect(findChecksum(checksumFixture, 'mangostudio-0.1.0-darwin-arm64.tar.gz')).toBe(
      'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
    );
    expect(findChecksum(checksumFixture, 'mangostudio-0.1.0-windows-x64.zip')).toBe(
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
    );
  });

  test('throws when the asset is missing from the manifest', () => {
    expect(() => findChecksum(checksumFixture, 'mangostudio-0.1.0-linux-arm64.tar.gz')).toThrow(
      /does not contain mangostudio-0\.1\.0-linux-arm64\.tar\.gz/
    );
  });
});
