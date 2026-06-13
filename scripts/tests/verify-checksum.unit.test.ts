import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChecksum, sha256File } from '../release/verify-checksum';

const checksumFixture = readFileSync(join(import.meta.dir, 'support', 'SHA256SUMS.sample'), 'utf8');

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-checksum-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs.length = 0;
});

describe('sha256File', () => {
  test('hashes file contents with SHA-256', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'asset.tar.gz');
    writeFileSync(filePath, 'release asset');

    expect(sha256File(filePath)).toBe(
      'e6abe9df7db8513616674b02b5edb26c37bf3b2f81daeec1e3c6fc8c9a802850'
    );
  });
});

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
